import { readCache, writeCache } from "./cache";
import { discord, e621 } from "./clients";
import config from "../config.json" assert { type: "json" };
import { type Post, type User } from "e621";

// the public version of the e621 package doesn't support blips/comments/forum posts
// we don't support pagination, so things *could* in theory break
type WarningType = "warning"| "record" | "ban";
interface Blip {
    body: string;
    created_at: string;
    creator_id: number;
    creator_name: string;
    id: number;
    is_hidden: boolean;
    response_to: number | null;
    updated_at: string;
    warning_type: WarningType;
    warning_user_id: number | null;
}
interface Comment {
    body: string;
    created_at: string;
    creator_id: number;
    creator_name: string;
    do_not_bump_post: boolean;
    id: number;
    is_hidden: boolean;
    is_sticky: boolean;
    post_id: number;
    score: number;
    updated_at: string;
    updater_id: number;
    warning_type: WarningType;
    warning_user_id: number | null;
}
interface ForumPost {
    body: string;
    created_at: string;
    creator_id: number;
    id: number;
    is_hidden: boolean;
    topic_id: number;
    updated_at: string;
    updater_id: number;
    warning_type: WarningType;
    warning_user_id: number;
}

async function getBlips() {
    const data = (await e621.request.get<Array<Blip> | { blips: []; }>("/blips.json?search[body_matches]=Donovan_DMC"))!;
    return !Array.isArray(data) && "blips" in data ? data.blips : data;
}

async function getComments() {
    const data = (await e621.request.get<Array<Comment> | { comments: []; }>("/comments.json?group_by=comment&search[body_matches]=Donovan_DMC"))!;
    return !Array.isArray(data) && "comments" in data ? data.comments : data;
}

async function getForumPosts() {
    const data = (await e621.request.get<Array<ForumPost> | { forum_posts: []; }>("/forum_posts.json?search[body_matches]=Donovan_DMC"))!;
    return !Array.isArray(data) && "forum_posts" in data ? data.forum_posts : data;
}

async function send(input: Blip | Comment | ForumPost, avatar: Post | null, type: "blip" | "comment" | "forumPost", user: User) {
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
                    iconURL: avatar?.file.url ?? undefined,
                    url:     `https://e621.net/users/${input.creator_id}`
                },
                description: input.body.length > 2048 ? `${input.body.slice(0, 2045)}...` : input.body,
                color:       0xFFD700
            }
        ]
    });
}

export default async function run() {
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
    const avatars = await e621.posts.search({ tags: `id:${avatarsToFetch.join(",")}` });
    for (const blip of newBlips) {
        const avatar = avatars.find(a => a.id === users.find(u => u.id === blip.creator_id)?.avatar_id ?? null) ?? null;
        await send(blip, avatar, "blip", users.find(u => u.id === blip.creator_id)!);
    }

    for (const comment of newComments) {
        const avatar = avatars.find(a => a.id === users.find(u => u.id === comment.creator_id)?.avatar_id ?? null) ?? null;
        await send(comment, avatar, "comment", users.find(u => u.id === comment.creator_id)!);
    }

    for (const forumPost of newForumPosts) {
        const avatar = avatars.find(a => a.id === users.find(u => u.id === forumPost.creator_id)?.avatar_id ?? null) ?? null;
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
