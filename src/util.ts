import { type PathLike } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const exists = async(path: PathLike) => access(path).then(() => true, () => false);
export const DAY = 1000 * 60 * 60 * 24;

export function isDirectRun(url: string) {
    return url.startsWith("file:") && process.argv[1] === fileURLToPath(url);
}
