import { readCache, writeCache } from "./cache.js";
import { discord, e621 } from "./clients.js";
import logger from "./logger.js";
import RequestQueue from "./queue.js";
import { DRY_RUN } from "./state.js";
import { getFileURL } from "./util.js";
import config from "../config.json" with { type: "json" };

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

const MENTION = /donovan(_| )?dmc/i;
export const isMention = (input: Pick<Mentionable, "body">) => MENTION.test(input.body);

export async function getAvatar(userID: number) {
    const user = await RequestQueue.add(() => e621.users.get(userID));
    if (!user?.avatar_id) {
        return null;
    }
    return RequestQueue.add(() => e621.posts.get(user.avatar_id!));
}

async function send(input: Mentionable, type: MentionType) {
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
                title:  `${d.title}${input.creator_name}`,
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
 */
export async function handleMention(type: MentionType, input: Mentionable, recovered = false) {
    if (!recovered && input.id <= (await readCache()).lastSeen[type]) {
        return;
    }
    if (DRY_RUN) {
        logger.info(`[mentions] [dry run] Would send the mention from ${type} ${input.id} by ${input.creator_name}`);
        return;
    }

    await send(input, type);
    // read again right before writing, so changes made by anything else while sending aren't overwritten
    const cache = await readCache();
    if (input.id > cache.lastSeen[type]) {
        cache.lastSeen[type] = input.id;
        await writeCache(cache);
    }
}
