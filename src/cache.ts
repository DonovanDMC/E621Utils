import { e621 } from "./clients.js";
import { getBlips, getComments, getForumPosts } from "./mentions.js";
import { dataDir, exists } from "./util.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";


if (!await exists(dataDir)) {
    await mkdir(dataDir);
}

export interface CacheEntry {
    post: number;
    rating: string;
    since: string;
    tags: Array<string>;
}

export interface Cache {
    changeSeq: number;
    lastMilestone: number;
    lastSeen: {
        blip: number;
        comment: number;
        forumPost: number;
    };
    message: string | null;
    posts: Array<CacheEntry>;
}

export function isMilestone(id: number) {
    const n = Number(id.toString().slice(1));
    return (n <= 900_000 && (n % 100_000) === 0) ||
        (n > 900_000 && n <= 980_000 && (n % 10_000) === 0) ||
        (n > 980_000 && n <= 998_000 && (n % 1000) === 0) ||
        (n > 998_000 && (n % 100) === 0);
}

export function getMilestoneTime(id: number) {
    const n = Number(id.toString().slice(1));
    if (n <= 900_000) {
        return 30 * 60 * 1000;
    } else if  (n <= 980_000) {
        return 15 * 60 * 1000;
    } else if (n <= 998_000) {
        return 5 * 60 * 1000;
    } else {
        return 1 * 60 * 1000;
    }
}

export function getClosestMilestone(id: number) {
    let milestone = false;
    while (!milestone) {
        if (isMilestone(id)) {
            milestone = true;
        } else {
            id -= 1;
        }
    }
    return id;
}

export async function getLatestMilestone() {
    const [post] = await e621.posts.search({ limit: 1 });
    return getClosestMilestone(post.id);
}

async function getCacheDefault(type: "lastMilestone" | "lastSeen.blip" | "lastSeen.comment" | "lastSeen.forumPost") {
    switch (type) {
        case "lastMilestone":
            return getLatestMilestone();
        case "lastSeen.blip":
            return (await getBlips())[0]?.id ?? 0;
        case "lastSeen.comment":
            return (await getComments())[0]?.id ?? 0;
        case "lastSeen.forumPost":
            return (await getForumPosts())[0]?.id ?? 0;
    }
}

export async function readCache() {
    if (!await exists(`${dataDir}/cache.json`)) {
        return {
            changeSeq:     0,
            lastMilestone: await getCacheDefault("lastMilestone"),
            lastSeen:      {
                blip:      await getCacheDefault("lastSeen.blip"),
                comment:   await getCacheDefault("lastSeen.comment"),
                forumPost: await getCacheDefault("lastSeen.forumPost")
            },
            message: null,
            posts:   []
        } satisfies Cache;
    }
    const cache = JSON.parse(await readFile(`${dataDir}/cache.json`, "utf8")) as Cache;
    if (!cache.lastMilestone) {
        cache.lastMilestone = await getCacheDefault("lastMilestone");
    }
    if (!cache.lastSeen) {
        cache.lastSeen = {
            blip:      await getCacheDefault("lastSeen.blip"),
            comment:   await getCacheDefault("lastSeen.comment"),
            forumPost: await getCacheDefault("lastSeen.forumPost")
        };
    }

    if ([null, undefined].includes(cache.lastSeen.blip as never)) {
        cache.lastSeen.blip = await getCacheDefault("lastSeen.blip");
    }
    if ([null, undefined].includes(cache.lastSeen.comment as never)) {
        cache.lastSeen.comment = await getCacheDefault("lastSeen.comment");
    }
    if ([null, undefined].includes(cache.lastSeen.forumPost as never)) {
        cache.lastSeen.forumPost = await getCacheDefault("lastSeen.forumPost");
    }

    return cache;
}

export async function writeCache(cache: Cache) {
    await writeFile(`${dataDir}/cache.json`, JSON.stringify(cache));
}
