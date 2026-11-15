import { readCache, writeCache } from "./cache.js";
import { discord, e621 } from "./clients.js";
import logger from "./logger.js";
import RequestQueue from "./queue.js";
import { DRY_RUN, saveState, state } from "./state.js";
import { getStream } from "./stream.js";
import { getFileURL } from "./util.js";
import config from "../config.json" with { type: "json" };
import type { ForumTopic } from "e621stream";

export async function getBlips() {
    return e621.blips.search({ body_matches: "Donovan_DMC" });
}

export async function getComments() {
    return e621.comments.search({ body_matches: "Donovan_DMC" });
}

export async function getForumPosts() {
    return e621.forumPosts.search({ body_matches: "Donovan_DMC" });
}

type MentionType = "blip" | "comment" | "forumPost";
// what's needed out of a blip, comment, or forum post
interface Mentionable {
    body: string;
    creator_id: number;
    creator_name: string;
    id: number;
}

type OwnTopic = Pick<ForumTopic, "id" | "title">;

const MENTION = /donovan(_| )?dmc/i;
export const isMention = (input: Pick<Mentionable, "body">) => MENTION.test(input.body);

let userID: number | null = null;
/** set from the stream's ready, it's who the stream is authed as */
export function setAuthUser(id: number | null) {
    userID = id;
    if (id === null) {
        logger.warn("[mentions] The stream isn't authed, replies to our topics won't be sent");
        return;
    }
    // started now so the first reply doesn't have to wait on it, it's tried again on the next reply if it fails
    getOwnTopics().catch(err => logger.error("[mentions] Failed to find our topics:", err));
}

export const isOwn = (input: Pick<Mentionable, "creator_id">) => input.creator_id === userID;

// what one search can return
const SEARCH_SIZE = 320;
/** topics from before they were tracked, found through our own posts since topics can't be searched by creator */
async function seedOwnTopics(id: number) {
    const topicIDs = new Set<number>();
    for (let page = 1; ; page++) {
        const posts = await RequestQueue.add(() => e621.forumPosts.search({ creator_id: id, limit: SEARCH_SIZE, page }));
        for (const post of posts) {
            topicIDs.add(post.topic_id);
        }
        if (posts.length < SEARCH_SIZE) {
            break;
        }
    }

    const ids = [...topicIDs], topics: Record<number, string> = {};
    for (let i = 0; i < ids.length; i += SEARCH_SIZE) {
        const found = await RequestQueue.add(() => e621.forumTopics.search({ id: ids.slice(i, i + SEARCH_SIZE).join(","), limit: SEARCH_SIZE }));
        for (const topic of found) {
            if (topic.creator_id === id) {
                topics[topic.id] = topic.title;
            }
        }
    }
    logger.info(`[mentions] Found ${Object.keys(topics).length} topics we've created`);
    return topics;
}

let seeding: Promise<void> | null = null;
async function getOwnTopics() {
    if (state().ownTopics === undefined && userID !== null) {
        const id = userID;
        seeding ??= seedOwnTopics(id).then(async topics => {
            // anything created while seeding is kept
            state().ownTopics = { ...topics, ...state().ownTopics };
            await saveState();
        }).finally(() => (seeding = null));
        await seeding;
    }
    return state().ownTopics ?? {};
}

/** saves the topic if it's one we created */
export async function handleTopic(topic: Pick<ForumTopic, "creator_id" | "id" | "title">) {
    if (topic.creator_id !== userID) {
        return;
    }
    await getOwnTopics();
    (state().ownTopics ??= {})[topic.id] = topic.title;
    await saveState();
}

/** the topic's title if it's one we created, the snapshot has the current title if it's been renamed */
export async function getOwnTopic(id: number) {
    const title = (await getOwnTopics())[id];
    if (title === undefined) {
        return null;
    }
    const snapshot = await getStream()?.snapshots("forum_topic", [id]).catch(() => null);
    return { id, title: snapshot?.[id]?.title ?? title };
}

export async function getAvatar(userID: number) {
    const user = await RequestQueue.add(() => e621.users.get(userID));
    if (!user?.avatar_id) {
        return null;
    }
    return RequestQueue.add(() => e621.posts.get(user.avatar_id!));
}

async function send(input: Mentionable, type: MentionType, topic?: OwnTopic) {
    const d = {
        blip:      { title: "New Blip by ", url: "https://e621.net/blips/" },
        comment:   { title: "New Comment by ", url: "https://e621.net/comments/" },
        forumPost: { title: "New Forum Post by ", url: "https://e621.net/forum_posts/" }
    }[type];
    // a missing avatar shouldn't stop the mention from being sent
    const avatar = await getAvatar(input.creator_id).catch(() => null);
    await discord().rest.channels.createMessage(config.mentionsChannel, {
        embeds: [
            {
                title:  (topic ? `New Reply to ${topic.title} by ${input.creator_name}` : `${d.title}${input.creator_name}`).slice(0, 256),
                url:    `${d.url}${input.id}`,
                author: {
                    name:    input.creator_name,
                    iconURL: avatar ? getFileURL(avatar) : undefined,
                    url:     `https://e621.net/users/${input.creator_id}`
                },
                description: input.body.length > 2048 ? `${input.body.slice(0, 2045)}...` : input.body,
                color:       0xFFD700
            }
        ]
    });
}

/**
 * Sends a mention to discord, unless it's already been sent (the stream can replay events after a restart).
 * Recovered ones are older than what's already been seen, and the stream only sends ones we missed, so they aren't checked.
 * `topic` is set for replies to our topics, the same post is only sent once even if it's also a mention.
 */
export async function handleMention(type: MentionType, input: Mentionable, recovered = false, topic?: OwnTopic) {
    if (!recovered && input.id <= (await readCache()).lastSeen[type]) {
        return;
    }
    if (DRY_RUN) {
        logger.info(`[mentions] [dry run] Would send the ${topic ? "reply" : "mention"} from ${type} ${input.id} by ${input.creator_name}`);
        return;
    }

    await send(input, type, topic);
    // read again right before writing, so changes made by anything else while sending aren't overwritten
    const cache = await readCache();
    if (input.id > cache.lastSeen[type]) {
        cache.lastSeen[type] = input.id;
        await writeCache(cache);
    }
}
