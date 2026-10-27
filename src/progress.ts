import { dataDir, DAY, exists } from "./util.js";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

function formatDate(date: Date) {
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${(date.getDate()).toString().padStart(2, "0")}`;
}

/**
 * Tracks how far a script has gotten through today's posts export, so a crashed
 * or aborted run can pick up where it left off instead of starting over.
 *
 * `config` should be whatever decides which posts get edited (e.g. the tag list),
 * so changing it starts a fresh run instead of skipping posts the new config would match.
 */
export default class Progress {
    private file: string;
    private lastId: number | null;
    private lastWrite = 0;
    private constructor(file: string, lastId: number | null) {
        this.file = file;
        this.lastId = lastId;
    }

    static async load(name: string, config?: unknown) {
        const key = config === undefined ? name : `${name}-${createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 8)}`;
        const today = `${dataDir}/${key}-${formatDate(new Date())}.progress`;
        const yesterday = `${dataDir}/${key}-${formatDate(new Date(Date.now() - DAY))}.progress`;
        if (await exists(yesterday)) {
            await rm(yesterday);
        }

        let lastId: number | null = null;
        if (await exists(today)) {
            const contents = (await readFile(today, "utf8")).trim();
            lastId = contents === "done" ? Infinity : Number(contents);
            console.log(lastId === Infinity ? `[${name}] Already finished today, skipping` : `[${name}] Resuming after post ${lastId}`);
        }

        return new Progress(today, lastId);
    }

    get finished() {
        return this.lastId === Infinity;
    }

    /** The export is ordered by id, so anything at or below the last saved id was already handled. */
    shouldSkip(id: number) {
        return this.lastId !== null && id <= this.lastId;
    }

    /** Call after a post has been fully handled. Saved every 10k posts, or immediately with `force` (use after making requests). */
    async update(id: number, force = false) {
        this.lastId = id;
        if (force || ++this.lastWrite >= 10_000) {
            this.lastWrite = 0;
            await writeFile(this.file, String(id));
        }
    }

    async finish() {
        this.lastId = Infinity;
        await writeFile(this.file, "done");
    }
}
