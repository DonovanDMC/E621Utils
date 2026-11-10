import { e621, discord } from "./clients.js";
import { type CacheEntry, readCache, writeCache } from "./cache.js";
import logger from "./logger.js";
import RequestQueue from "./queue.js";
import { DRY_RUN, loadState, saveState, state } from "./state.js";
import { runQueued } from "./stream.js";
import { getFileURL, isDirectRun } from "./util.js";
import tagConfig from "../tags.json" with { type: "json" };
import config from "../config.json" with { type: "json" };
import {
    type EmbedOptions,
    MessageFlags,
    ComponentTypes,
    ButtonStyles,
    ComponentInteraction,
    type AnyInteractionGateway,
    type MessageActionRow,
    type CreateMessageOptions,
    type EditMessageOptions
} from "oceanic.js";
import chunk from "chunk";
import type { ExtendedPost } from "e621";

// the parts of a post the tag checks look at, which stream posts and api posts both have
interface CheckPost {
    flags: { deleted: boolean; };
    id: number;
    rating: string;
    tags: Record<string, Array<string>>;
}

interface Term {
    negate: boolean;
    /** a `~` term, at least one of these has to match */
    or: boolean;
    type: "rating" | "set" | "tag";
    value: string;
}

/** a small part of e621's search syntax: `tag`, `-tag`, `~tag`, `rating:x` and `set:shortname` */
function parseQuery(query: string): Array<Term> {
    return query.split(/\s+/).filter(Boolean).map(token => {
        const or = token.startsWith("~");
        if (or) token = token.slice(1);
        const negate = token.startsWith("-");
        if (negate) token = token.slice(1);

        if (token.startsWith("rating:")) {
            return { negate, or, type: "rating", value: token.slice(7, 8) };
        }
        if (token.startsWith("set:")) {
            return { negate, or, type: "set", value: token.slice(4) };
        }
        // anything else with a colon (besides ratios like 16:9) is a metatag this can't check, so it'd never match
        if (/^[a-z_]+:/i.test(token)) {
            throw new Error(`Unsupported metatag in tags.json: "${token}"`);
        }
        return { negate, or, type: "tag", value: token };
    });
}

const configs = tagConfig.map(({ base, groups }) => ({ base, groups, terms: parseQuery(base) }));
const setNames = [...new Set(configs.flatMap(c => c.terms.filter(t => t.type === "set").map(t => t.value)))];

// set membership isn't on posts, so it's loaded and polled separately
const sets = new Map<string, Set<number>>();

function matches(post: CheckPost, tags: Set<string>, terms: Array<Term>) {
    const holds = (term: Term) => term.negate !== (
        term.type === "tag" ? tags.has(term.value) :
            (term.type === "rating" ? post.rating === term.value : sets.get(term.value)!.has(post.id))
    );
    const or = terms.filter(t => t.or);
    return terms.every(t => t.or || holds(t)) && (or.length === 0 || or.some(holds));
}

/** what a post is currently found for, the same strings the searches would give */
function evaluate(post: CheckPost | null) {
    // deleted posts don't show up in searches
    if (post === null || post.flags.deleted) {
        return [];
    }

    const tags = new Set(Object.values(post.tags).flat());
    const found: Array<string> = [];
    for (const { base, groups, terms } of configs) {
        if (!matches(post, tags, terms)) {
            continue;
        }
        if (groups === null) {
            found.push(base);
        } else {
            found.push(...groups.filter(tag => tags.has(tag)).map(tag => `${tag} ${base}`));
        }
    }
    return found;
}

const sameTags = (a: Array<string>, b: Array<string>) => a.length === b.length && a.every(t => b.includes(t));

// the cached posts are kept in memory, since every post event is checked against them
let tracked = new Map<number, CacheEntry>();
async function saveTracked() {
    if (DRY_RUN) {
        return;
    }
    // read right before writing, so anything else in the cache isn't overwritten
    const cache = await readCache();
    cache.posts = [...tracked.values()];
    await writeCache(cache);
}

async function onInteraction(interaction: AnyInteractionGateway) {
    if (interaction instanceof ComponentInteraction) {
        await interaction.defer(MessageFlags.EPHEMERAL);
        const [command, ...args] = interaction.data.customID.split(":");
        switch (command) {
            case "run-checks": {
                void runQueued(runChecks);
                return interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: "Running."
                });
            }

            case "list-cache": {
                if (tracked.size === 0) {
                    return interaction.createFollowup({
                        flags:   MessageFlags.EPHEMERAL,
                        content: "There are currently 0 cached posts."
                    });
                }

                const embeds: Array<EmbedOptions> = [];
                const posts = await RequestQueue.add(() => e621.posts.search({ tags: `id:${[...tracked.keys()].join(",")}`, v2: true, mode: "extended" }));
                for (const entry of tracked.values()) {
                    embeds.push(makeEmbed(entry, posts.find(p => p.id === entry.post) ?? null, null));
                }

                const eb = chunk(embeds, 10);
                const initial = eb.shift()!;
                await interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: `There are currently ${tracked.size} cached posts.`,
                    embeds:  initial
                });
                for (const e of eb.values()) {
                    await interaction.createFollowup({
                        embeds: e,
                        flags:  MessageFlags.EPHEMERAL
                    });
                }
                break;
            }

            case "clear-cache": {
                tracked.clear();
                await saveTracked();
                await interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: "Cache cleared."
                });
                break;
            }

            case "remove-post": {
                if (!tracked.delete(Number(args[0]))) {
                    return interaction.createFollowup({
                        flags:   MessageFlags.EPHEMERAL,
                        content: "That post is not cached."
                    });
                }
                await saveTracked();
                await interaction.message.delete();
                await interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: "Post removed."
                });
                break;
            }
        }
    }
}

const GREEN = 0x008000, YELLOW = 0xFFD700, RED = 0xDC143C;
let lastResync: { added: number; removed: number; time: number; } | null = null;
function getMessageContent(): CreateMessageOptions | EditMessageOptions {
    const resync = lastResync === null ? "A full check hasn't been ran yet." : `The last full check was <t:${Math.floor(lastResync.time / 1000)}:R>, and added **${lastResync.added}** post${lastResync.added === 1 ? "" : "s"} and removed **${lastResync.removed}** post${lastResync.removed === 1 ? "" : "s"}.`;
    return {
        embeds: [
            {
                title:       "Status",
                description: `Posts are checked as they're edited, last updated <t:${Math.floor(Date.now() / 1000)}:R>.\n${resync}`,
                footer:      {
                    text: `Total Cached Posts: ${tracked.size}`
                },
                color:     tracked.size === 0 ? GREEN : (tracked.size <= 5 ? YELLOW : RED),
                timestamp: new Date().toISOString()
            }
        ],
        components: [
            {
                type:       ComponentTypes.ACTION_ROW,
                components: [
                    {
                        type:     ComponentTypes.BUTTON,
                        style:    ButtonStyles.PRIMARY,
                        label:    "Run Checks",
                        customID: "run-checks"
                    },
                    {
                        type:     ComponentTypes.BUTTON,
                        style:    ButtonStyles.SUCCESS,
                        label:    "List Cache",
                        customID: "list-cache"
                    },
                    {
                        type:     ComponentTypes.BUTTON,
                        style:    ButtonStyles.DANGER,
                        label:    "Clear Cache",
                        customID: "clear-cache"
                    }
                ]
            }
        ]
    };
}

/** `recreate` moves the status message to the bottom of the channel, under anything just sent */
async function updateMessage(recreate: boolean) {
    if (DRY_RUN) {
        return;
    }
    const cache = await readCache();
    const content = getMessageContent();
    if (cache.message !== null && !recreate) {
        await discord().rest.channels.editMessage(config.tagsChannel, cache.message, content)
            .catch(() => (recreate = true));
    }
    if (recreate || cache.message === null) {
        if (cache.message !== null) {
            await discord().rest.channels.deleteMessage(config.tagsChannel, cache.message).catch(err => {
                console.log("Failed to delete message:", err);
            });
        }
        const message = (await discord().rest.channels.createMessage(config.tagsChannel, content as CreateMessageOptions)).id;
        // read again, the cache may have changed while that was being sent
        const latest = await readCache();
        latest.message = message;
        await writeCache(latest);
    }
}

function makeEmbed(entry: CacheEntry, post: ExtendedPost | null, op: "add" | "remove" | null) {
    const color = op === "add" ? GREEN : (op === "remove" ? RED : YELLOW);
    if (post === null) {
        return {
            title:     `Post Destroyed: #${entry.post}`,
            timestamp: new Date().toISOString(),
            color
        };
    }
    return {
        title:       op === "add" ? `Post Added: #${entry.post}` : (op === "remove" ? `Post Removed: #${entry.post}` : `Post #${entry.post}`),
        description: `Rating: **${post.rating === "s" ? "Safe" : (post.rating === "q" ? "Questionable" : "Explicit")}**${op === "remove" ? ` (Old: **${entry.rating === "s" ? "Safe" : (entry.rating === "q" ? "Questionable" : "Explicit")}**)` : ""}\n\nFound For:\n${entry.tags.map(tag => `- \`${tag}\``).join("\n")}`,
        timestamp:   new Date().toISOString(),
        url:         `https://e621.net/posts/${entry.post}`,
        color,
        image:       ["webm", "mp4", "swf"].includes(post.files.meta.ext)  ? undefined : {
            url: getFileURL(post)
        }
    } satisfies EmbedOptions;
}

function getComponents(entry: CacheEntry, op: "add" | "remove" | null): Array<MessageActionRow> {
    const base: Array<MessageActionRow> = [
        {
            type:       ComponentTypes.ACTION_ROW,
            components: [
                {
                    type:  ComponentTypes.BUTTON,
                    style: ButtonStyles.LINK,
                    label: "View Post",
                    url:   `https://e621.net/posts/${entry.post}`
                }
            ]
        }
    ];

    switch (op) {
        case "remove": return base;
        case null:
        case "add": {
            base[0]!.components.push({
                type:     ComponentTypes.BUTTON,
                style:    ButtonStyles.DANGER,
                label:    "Remove Post",
                customID: `remove-post:${entry.post}`
            });
            return base;
        }
    }
}

async function sendDiscord(entry: CacheEntry, post: ExtendedPost | null, op: "add" | "remove" | null) {
    if (DRY_RUN) {
        logger.info(`[checks] [dry run] Would send ${op} for https://e621.net/posts/${entry.post} (${entry.tags.join(", ")})`);
        return;
    }
    await discord().rest.channels.createMessage(config.tagsChannel, {
        embeds:     [makeEmbed(entry, post, op)],
        components: getComponents(entry, op)
    });
}

/** adds or removes a post from the cache based on what it's currently found for, and says so in discord. returns what changed */
async function apply(id: number, found: Array<string>, post: ExtendedPost | null) {
    const entry = tracked.get(id);
    if (found.length !== 0 && entry === undefined) {
        const added = { post: id, rating: post!.rating, tags: found, since: new Date().toISOString() };
        tracked.set(id, added);
        await saveTracked();
        await sendDiscord(added, post, "add");
        return "add";
    }
    if (found.length === 0 && entry !== undefined) {
        tracked.delete(id);
        await saveTracked();
        await sendDiscord(entry, post, "remove");
        return "remove";
    }
    if (entry !== undefined && !sameTags(entry.tags, found)) {
        entry.tags = found;
        await saveTracked();
    }
    return null;
}

/** the posts currently cached */
export function trackedPosts() {
    return [...tracked.keys()];
}

/** checked against each post from the stream (or export), true if its cached state would change */
export function needsTagCheck(post: CheckPost) {
    const entry = tracked.get(post.id);
    const found = evaluate(post);
    return entry === undefined ? found.length !== 0 : !sameTags(entry.tags, found);
}

/** checks the post as it is right now, the stream's copy (or a set change) is only what says it might have changed */
export async function recheckPost(id: number) {
    const post = await RequestQueue.add(() => e621.posts.get(id, { v2: true, mode: "extended" }));
    if (await apply(id, evaluate(post), post) !== null) {
        await updateMessage(true);
    }
}

interface SetInfo {
    id: number;
    isPublic: boolean;
    name: string;
}
// filled in once the sets are first loaded
const setInfo = new Map<string, SetInfo>();

async function loadSet(shortname: string) {
    const [set] = await RequestQueue.add(() => e621.postSets.search({ shortname }));
    if (!set) {
        throw new Error(`Couldn't find set "${shortname}", if it's private the account in the config needs access to it`);
    }
    setInfo.set(shortname, { id: set.id, isPublic: set.is_public, name: shortname });
    return new Set(set.post_ids);
}

/** replaces the local copy of a set, and returns the posts that were added or removed */
async function refreshSet(name: string) {
    const ids = await loadSet(name);
    // what the set was last time it was saved, so changes from while this wasn't running are caught too
    const old = sets.get(name) ?? new Set(state().sets?.[name] ?? ids);
    const changed = [...ids].filter(id => !old.has(id)).concat([...old].filter(id => !ids.has(id)));
    sets.set(name, ids);
    if (changed.length !== 0 || state().sets?.[name] === undefined) {
        (state().sets ??= {})[name] = [...ids];
        await saveState();
    }
    return changed;
}

async function refreshSets(names: Array<string>) {
    const changed = new Set<number>();
    for (const name of names) {
        for (const id of await refreshSet(name)) {
            changed.add(id);
        }
    }
    for (const id of changed) {
        await recheckPost(id);
    }
}

/** a set event only says a set changed, it's reloaded since replayed events can be older than what's already known */
export async function onSetChanged(setId: number) {
    const set = [...setInfo.values()].find(s => s.id === setId);
    if (set) {
        await refreshSets([set.name]);
    }
}

/**
 * Like dmails, the stream only remembers the newest private set state it's sent per account, so any other connection
 * that gets the events means the real one never will. Dry runs poll the private sets instead.
 */
const privateSetEvents = !DRY_RUN;

/** set changes come from the stream */
export function setSubscriptions() {
    const publicIds = [...setInfo.values()].filter(s => s.isPublic).map(s => s.id);
    return [
        ...(publicIds.length === 0 ? [] : ["post_set.add_posts", "post_set.remove_posts"].map(type => ({ type, filter: { set_ids: publicIds } }))),
        // these can't be filtered, onSetChanged ignores sets that aren't used. like dmails, only one connection per account should get them
        ...(privateSetEvents ? ["private_post_set.add_posts", "private_post_set.remove_posts"] : [])
    ];
}

let running = false;
/** the original search based check, only ran from the button now. searches stop at 320 posts, so this can miss some */
export default async function runChecks() {
    if (running) {
        return;
    }
    running = true;

    try {
        const found = new Map<number, Array<string>>();
        const allPosts: Array<ExtendedPost> = [];
        for (const { base, groups } of configs) {
            const tags = `${groups === null ? "" : groups.map(tag => `~${tag} `).join("")}${base}`;
            const posts = await RequestQueue.add(() => e621.posts.search({ tags, limit: 320, v2: true, mode: "extended" }));
            allPosts.push(...posts);
            for (const post of posts) {
                const all = new Set(Object.values(post.tags).flat());
                const foundFor = groups === null ? [base] : groups.filter(tag => all.has(tag)).map(tag => `${tag} ${base}`);
                found.set(post.id, [...found.get(post.id) ?? [], ...foundFor]);
            }
        }

        const missing = [...tracked.keys()].filter(id => !found.has(id));
        if (missing.length !== 0) {
            allPosts.push(...await RequestQueue.add(() => e621.posts.search({ tags: `id:${missing.join(",")}`, limit: 320, v2: true, mode: "extended" })));
        }

        let added = 0, removed = 0;
        for (const id of new Set([...found.keys(), ...missing])) {
            const post = allPosts.find(p => p.id === id) ?? null;
            // stream events are checked locally, so that's what's used here too, or the two would keep undoing each other
            const local = evaluate(post);
            if (!sameTags(local, found.get(id) ?? [])) {
                logger.warn(`[checks] Search and the local check disagree on https://e621.net/posts/${id}, search: ${found.get(id)?.join(", ") || "nothing"}, local: ${local.join(", ") || "nothing"}`);
            }
            const op = await apply(id, local, post);
            if (op === "add") added++;
            if (op === "remove") removed++;
        }

        lastResync = { added, removed, time: Date.now() };
        if (added !== 0 || removed !== 0) {
            logger.info(`[checks] Full check added ${added} and removed ${removed} posts`);
        }
        await updateMessage(added !== 0 || removed !== 0);
    } finally {
        running = false;
    }
}

const SET_POLL_MS = 5 * 60 * 1000;
/** has to be done before the stream starts, set checks can't be right without knowing what's in the sets */
export async function initChecks() {
    // dry runs leave the buttons to the real one
    if (!DRY_RUN) {
        discord().on("interactionCreate", onInteraction);
    }
    await loadState();
    tracked = new Map((await readCache()).posts.map(entry => [entry.post, entry]));
    // kept across retries, sets that loaded before a failure already have their new copy
    const changed: Array<number> = [];
    for (let attempt = 1; ; attempt++) {
        try {
            for (const name of setNames) {
                changed.push(...await refreshSet(name));
            }
            break;
        } catch (err) {
            logger.error(`[checks] Failed to load sets (attempt ${attempt}), retrying in 30 seconds:`, err);
            await new Promise(resolve => setTimeout(resolve, 30_000));
        }
    }
    for (const id of new Set(changed)) {
        void runQueued(async() => recheckPost(id)).catch(err => logger.error(`[checks] Tag check failed on post ${id}:`, err));
    }

    // dry runs don't get the private set events, so they poll instead
    const polled = privateSetEvents ? [] : [...setInfo.values()].filter(s => !s.isPublic).map(s => s.name);
    if (polled.length !== 0) {
        setInterval(() => void runQueued(async() => refreshSets(polled)).catch(err => logger.error("[checks] Set poll failed:", err)), SET_POLL_MS);
    }
}

if (isDirectRun(import.meta.url)) {
    await initChecks();
}
