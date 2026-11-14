import { initChecks, needsTagCheck, onSetChanged, recheckPost, setSubscriptions } from "./checks.js";
import discordCDNParams, { fixExpiredSources } from "./discord-cdn-params.js";
import { dmailsEnabled, handleDMail } from "./dmails.js";
import type { HandlerPost, PostHandler } from "./handler.js";
import logger from "./logger.js";
import { handleMention, isMention } from "./mentions.js";
import nukeTags from "./nuke-tags.js";
import ratios from "./ratios.js";
import { findUndone, handleOwnVersion, handleUndone, revertsEnabled } from "./reverts.js";
import { DRY_RUN, loadState, saveState, state } from "./state.js";
import { isDirectRun } from "./util.js";
import config from "../config.json" with { type: "json" };
import { E621Stream, type LegacyPost, type PostVersion } from "e621stream";

const handlers: Array<PostHandler> = [discordCDNParams, ratios, nukeTags];

interface Job {
    /** saved once this job is done, it's moved forward when events are skipped while it's queued */
    cursor: string | null;
    run(): Promise<void>;
}

// everything runs one at a time, in the order events came in
const jobs: Array<Job> = [];
let running: Job | null = null;

let cursorTimer: NodeJS.Timeout | null = null;
function setCursor(cursor: string) {
    state().cursor = cursor;
    // events can come in quickly, so the cursor alone is saved at most every 5 seconds
    cursorTimer ??= setTimeout(() => {
        cursorTimer = null;
        void saveState();
    }, 5000);
}

async function processJobs() {
    if (running !== null) {
        return;
    }
    while ((running = jobs.shift() ?? null) !== null) {
        await running.run().catch(err => logger.error("[stream] Job failed:", err));
        if (running.cursor !== null) {
            setCursor(running.cursor);
        }
    }
}

function enqueue(cursor: string | null, run: () => Promise<void>) {
    jobs.push({ cursor, run });
    void processJobs();
}

/** skipped events can't be saved as the cursor until everything before them is done */
function skip(cursor: string) {
    const last = jobs.at(-1) ?? running;
    if (last) {
        last.cursor = cursor;
    } else {
        setCursor(cursor);
    }
}

export function matchHandlers(post: HandlerPost) {
    return handlers.filter(h => h.check(post));
}

export async function runHandlers(post: HandlerPost, matched: Array<PostHandler>) {
    for (const handler of matched) {
        await handler.run(post).catch(err => logger.error(`[stream] ${handler.name} failed on post ${post.id}:`, err));
    }
}

/** runs `run` in the same queue as stream events, so nothing else is editing at the same time */
export async function runQueued(run: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => enqueue(null, async() => run().then(resolve, reject)));
}

function onPost(id: string, post: LegacyPost) {
    const matched = matchHandlers(post);
    const tagCheck = needsTagCheck(post);
    if (matched.length === 0 && !tagCheck) {
        skip(id);
        return;
    }

    enqueue(id, async() => {
        await runHandlers(post, matched);
        if (tagCheck) {
            await recheckPost(post.id).catch(err => logger.error(`[stream] Tag check failed on post ${post.id}:`, err));
        }
    });
}

function onMention(id: string, type: Parameters<typeof handleMention>[0], input: Parameters<typeof handleMention>[1]) {
    if (!isMention(input)) {
        skip(id);
        return;
    }

    enqueue(id, async() => handleMention(type, input).catch(err => logger.error(`[stream] Failed to send the mention from ${type} ${input.id}:`, err)));
}

function onVersion(id: string, version: PostVersion) {
    // ours are only saved, which is safe to repeat if they're replayed
    if (handleOwnVersion(version) || findUndone(version).length === 0) {
        skip(id);
        return;
    }

    enqueue(id, async() => handleUndone(version).catch(err => logger.error(`[stream] Failed to log undone edits from version ${version.id}:`, err)));
}

function onSet(id: string, setId: number) {
    enqueue(id, async() => onSetChanged(setId).catch(err => logger.error(`[stream] Failed to update set ${setId}:`, err)));
}

let stream: E621Stream | undefined;
export const getStream = () => stream;
export async function startStream() {
    if (stream !== undefined) {
        return stream;
    }

    const { cursor } = await loadState();
    if (state().startedAt === undefined) {
        state().startedAt = Date.now();
        await saveState();
    }
    if (DRY_RUN) {
        logger.info("[stream] Dry run, nothing will be edited");
    }

    stream = new E621Stream({
        auth:          { username: config.authUser, apiKey: config.authKey },
        client:        "E621Utils",
        // STREAM_CURSOR can be an event id or a ms timestamp, for replaying by hand
        cursor:        process.env.STREAM_CURSOR ?? cursor ?? undefined,
        subscriptions: ["post.create", "post.update", "blip.create", "comment.create", "forum_post.create", ...(revertsEnabled ? ["post_version.create"] : []), ...(dmailsEnabled ? ["dmail.create"] : []), ...setSubscriptions()]
    });

    stream.on("ready", ready => {
        logger.info(`[stream] Ready as ${ready.user?.name ?? "anonymous"}${ready.replaying ? ", replaying" : ""}`);
        if (ready.cursor_expired) {
            logger.warn("[stream] The saved cursor is older than the stream keeps (24 hours), anything before the oldest kept event was missed");
        }
    });
    stream.on("replayComplete", ({ events }) => logger.info(`[stream] Replayed ${events} events`));
    stream.on("reconnecting", ({ attempt, delayMS }) => logger.info(`[stream] Reconnecting in ${delayMS}ms (attempt ${attempt})`));
    stream.on("close", ({ code, reason, reconnecting }) => logger.info(`[stream] Closed (${code}: ${reason})${reconnecting ? "" : ", not reconnecting"}`));
    stream.on("error", err => logger.error("[stream] Error:", err));
    stream.on("post.create", event => onPost(event.id, event.data.post));
    stream.on("post.update", event => onPost(event.id, event.data.post));
    stream.on("blip.create", event => onMention(event.id, "blip", event.data));
    stream.on("comment.create", event => onMention(event.id, "comment", event.data));
    stream.on("forum_post.create", event => onMention(event.id, "forumPost", event.data));
    stream.on("post_version.create", event => onVersion(event.id, event.data));
    stream.on("post_set.add_posts", event => onSet(event.id, event.data.post_set.id));
    stream.on("post_set.remove_posts", event => onSet(event.id, event.data.post_set.id));
    // private, so they aren't part of the cursor and skip the cursor queue
    const onPrivateSet = (setId: number) => void runQueued(async() => onSetChanged(setId)).catch(err => logger.error(`[stream] Failed to update set ${setId}:`, err));
    stream.on("private_post_set.add_posts", event => onPrivateSet(event.data.post_set.id));
    stream.on("private_post_set.remove_posts", event => onPrivateSet(event.data.post_set.id));
    // private events aren't part of the cursor, the stream keeps track of which dmails it's sent itself
    stream.on("dmail.create", event => void handleDMail(event.data).catch(err => logger.error(`[stream] Failed to send dmail ${event.data.id}:`, err)));

    // discord urls are rechecked after they expire
    setInterval(() => {
        if (!jobs.some(j => j.run === fixExpiredSources)) {
            enqueue(null, fixExpiredSources);
        }
    }, 60_000);

    return stream.connect();
}

if (isDirectRun(import.meta.url)) {
    await initChecks();
    await startStream();
}
