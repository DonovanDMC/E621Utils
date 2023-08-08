import { type PathLike } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

export const isDocker = await access("/.dockerenv").then(() => true, () => false) || await readFile("/proc/1/cgroup", "utf8").then(contents => contents.includes("docker"));
const exists = (path: PathLike) => access(path).then(() => true, () => false);
const dir = isDocker ? "/mnt/data" : new URL("../data/", import.meta.url).pathname;
if (!await exists(dir)) {
    await mkdir(dir);
}

export interface CacheEntry {
    post: number;
    rating: string;
    since: string;
    tags: Array<string>;
}

export interface Cache {
    lastSeen: {
        blip: number;
        comment: number;
        forumPost: number;
    };
    message: string | null;
    posts: Array<CacheEntry>;
}

export async function readCache() {
    if (!await exists(`${dir}/cache.json`)) {
        return {} as Cache;
    }

    return JSON.parse(await readFile(`${dir}/cache.json`, "utf8")) as Cache;
}

export async function writeCache(cache: Cache) {
    await writeFile(`${dir}/cache.json`, JSON.stringify(cache));
}
