import { readCache, writeCache } from "./cache.js";
import { discord, e621 } from "./clients.js";
import { getFileURL, isDirectRun } from "./util.js";
import config from "../config.json" with { type: "json" };
import { BasicPost, Blip, Comment, ForumPost, type Post, type User } from "e621";

export async function getBlips() {
    return e621.blips.search({ body_matches: "Donovan_DMC" });
}

export async function getComments() {
    return e621.comments.search({ body_matches: "Donovan_DMC" });
}

export async function getForumPosts() {
    return e621.forumPosts.search({ body_matches: "Donovan_DMC" });
}

async function send(input: Blip | Comment | ForumPost, avatar: BasicPost | null, type: "blip" | "comment" | "forumPost", user: User) {
    const d = {
        blip:      { title: "New Blip by ", url: "https://e621.net/blips/" },
        comment:   { title: "New Comment by ", url: "https://e621.net/comments/" },
        forumPost: { title: "New Forum Post by ", url: "https://e621.net/forum_posts/" }
    }[type];
    await discord().rest.channels.createMessage(config.mentionsChannel, {
        embeds: [
            {
                title:  `${d.title}${user.name}`,
                url:    `${d.url}${input.id}`,
                author: {
                    name:    user.name,
                    iconURL: avatar ? getFileURL(avatar) : undefined,
                    url:     `https://e621.net/users/${input.creator_id}`
                },
                description: input.body.length > 2048 ? `${input.body.slice(0, 2045)}...` : input.body,
                color:       0xFFD700
            }
        ]
    });
}

export default async function runMentions() {
    const cache = await readCache();
    const [blips, comments, forumPosts] = await Promise.all([getBlips(), getComments(), getForumPosts()]);
    const newBlips = blips.filter(b => b.id > cache.lastSeen.blip);
    const newComments = comments.filter(c => c.id > cache.lastSeen.comment);
    const newForumPosts = forumPosts.filter(fp => fp.id > cache.lastSeen.forumPost);

    const users: Array<User> = [];
    const avatarsToFetch: Array<number> = [];
    for (const item of [...newBlips, ...newComments, ...newForumPosts]) {
        if (users.some(u => u.id === item.creator_id)) {
            continue;
        }
        const user = await e621.users.get(item.creator_id);
        if (user !== null) {
            users.push(user);
            if (user.avatar_id !== null) {
                avatarsToFetch.push(user.avatar_id);
            }
        }
    }
    const avatars = await e621.posts.search({ tags: `id:${avatarsToFetch.join(",")}`, v2: true });
    for (const blip of newBlips) {
        const avatar = avatars.find(a => a.id === users.find(u => u.id === blip.creator_id)?.avatar_id) ?? null;
        await send(blip, avatar, "blip", users.find(u => u.id === blip.creator_id)!);
    }

    for (const comment of newComments) {
        const avatar = avatars.find(a => a.id === users.find(u => u.id === comment.creator_id)?.avatar_id) ?? null;
        await send(comment, avatar, "comment", users.find(u => u.id === comment.creator_id)!);
    }

    for (const forumPost of newForumPosts) {
        const avatar = avatars.find(a => a.id === users.find(u => u.id === forumPost.creator_id)?.avatar_id) ?? null;
        await send(forumPost, avatar, "forumPost", users.find(u => u.id === forumPost.creator_id)!);
    }

    const oldCache = JSON.stringify(cache);
    cache.lastSeen.blip = blips[0]?.id ?? cache.lastSeen.blip;
    cache.lastSeen.comment = comments[0]?.id ?? cache.lastSeen.comment;
    cache.lastSeen.forumPost = forumPosts[0]?.id ?? cache.lastSeen.forumPost;
    if (oldCache !== JSON.stringify(cache)) {
        await writeCache(cache);
    }
}

if (isDirectRun(import.meta.url)) {
    await runMentions();
}
