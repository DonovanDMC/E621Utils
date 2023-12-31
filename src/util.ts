import { type PathLike } from "node:fs";
import { access } from "node:fs/promises";

export const exists = async(path: PathLike) => access(path).then(() => true, () => false);
export const DAY = 1000 * 60 * 60 * 24;
