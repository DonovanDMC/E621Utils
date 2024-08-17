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
    lastSeen: {
        blip: number;
        comment: number;
        forumPost: number;
    };
    message: string | null;
    posts: Array<CacheEntry>;
}

export async function readCache() {
    if (!await exists(`${dataDir}/cache.json`)) {
        return {
            changeSeq: 0,
            lastSeen:  {
                blip:      0,
                comment:   7576246,
                forumPost: 372982
            },
            message: null,
            posts:   []
        } satisfies Cache;
    }

    return JSON.parse(await readFile(`${dataDir}/cache.json`, "utf8")) as Cache;
}

export async function writeCache(cache: Cache) {
    await writeFile(`${dataDir}/cache.json`, JSON.stringify(cache));
}
