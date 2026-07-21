import { BasicPost, ExtendedPost, Post, ThumbnailPost } from "e621";
import { type PathLike } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const exists = async(path: PathLike) => access(path).then(() => true, () => false);
export const DAY = 1000 * 60 * 60 * 24;

export function isDirectRun(url: string) {
    return url.startsWith("file:") && process.argv[1] === fileURLToPath(url);
}

export const isDocker = await access("/.dockerenv").then(() => true, () => false) || await readFile("/proc/1/cgroup", "utf8").then(contents => contents.includes("docker"));
export const dataDir = isDocker ? "/mnt/data" : new URL("../data/", import.meta.url).pathname;

export function getFileURL(post: BasicPost | ExtendedPost | ThumbnailPost | Post): string {
    let deleted = false, md5: string | undefined, ext: string | undefined, url: string | undefined;
    if (post instanceof ThumbnailPost) {
        if (post.flags.includes("deleted")) deleted = true;
        else if (post.file_url) url = post.file_url;
        else {
            md5 = post.md5;
            ext = post.file_ext;
        }
    } else if (post instanceof BasicPost || post instanceof ExtendedPost) {
        if (post.flags.deleted) deleted = true;
        else if (post.files.original.url) url = post.files.original.url;
        else {
            md5 = post.files.meta.md5;
            ext = post.files.meta.ext;
        }
    } else if (post instanceof Post) {
        if (post.flags.deleted) deleted = true;
        else if (post.file.url) url = post.file.url;
        else {
            md5 = post.file.md5;
            ext = post.file.ext;
        }
    }
    if (url) return url;
    if (deleted || (!md5 && !ext)) return "https://e621.net/images/deleted-preview.png";
    return `https://static1.e621.net/data/${md5}/${md5!.slice(0, 1)}/${md5!.slice(1, 2)}.${ext}`;
}
