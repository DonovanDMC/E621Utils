import { dataDir, exists } from "./util.js";
import { readFile, rename, writeFile } from "node:fs/promises";

export interface PendingSource {
    /** when the url's `ex` param says it expires, in ms */
    expires: number;
    post: number;
    source: string;
}

export interface BackfillState {
    done: boolean;
    /** set once the export has fully downloaded, a partial file would otherwise be read as if it were all there */
    downloaded: boolean;
    /** the export's updated_at, if a newer one comes out before this one is finished it starts over on that */
    export: string;
    /** the last post that was fully handled, the export is in id order */
    lastId: number;
}

export interface StreamState {
    /** one pass over an export, to catch anything from before the stream was started */
    backfill?: BackfillState;
    /** the last event that was fully handled, the stream resumes after it */
    cursor: string | null;
    /** sources we've edited, per post. anything in here is never touched again, even if someone puts it back */
    editedSources: Record<number, Array<string>>;
    /** discord urls that haven't expired yet, rechecked once they have */
    pendingSources: Array<PendingSource>;
    /** tags we've tried removing, per post. same as editedSources, these are never removed a second time */
    removedTags: Record<number, Array<string>>;
    /** the sets used by the tag checks, as of the last time they were loaded */
    sets?: Record<string, Array<number>>;
    /** when the stream was first started, anything before this is left to the backfill */
    startedAt?: number;
}

/** logs edits instead of making them, and never writes the state file */
export const DRY_RUN = ["1", "true"].includes(process.env.DRY_RUN ?? "");

const file = `${dataDir}/stream.json`;
let current: StreamState | undefined;

export async function loadState() {
    current ??= await exists(file) ? JSON.parse(await readFile(file, "utf8")) as StreamState : {
        cursor:         null,
        editedSources:  {},
        pendingSources: [],
        removedTags:    {}
    };
    return current;
}

export function state() {
    if (current === undefined) {
        throw new Error("loadState() has to be called first");
    }
    return current;
}

let saving: Promise<void> | null = null, dirty = false;
/** writes are serialized, and anything that changes during a write is written right after */
export async function saveState(): Promise<void> {
    if (DRY_RUN || current === undefined) {
        return;
    }
    dirty = true;
    if (saving !== null) {
        return saving;
    }

    saving = (async() => {
        while (dirty) {
            dirty = false;
            // write then rename, so a crash mid write can't leave a truncated file
            await writeFile(`${file}.tmp`, JSON.stringify(current));
            await rename(`${file}.tmp`, file);
        }
    })().finally(() => (saving = null));
    return saving;
}

function add(record: Record<number, Array<string>>, post: number, values: Array<string>) {
    const list = (record[post] ??= []);
    for (const value of values) {
        if (!list.includes(value)) {
            list.push(value);
        }
    }
}

export function wasTagRemoved(post: number, tag: string) {
    return state().removedTags[post]?.includes(tag) ?? false;
}

/** saved before the edit is made, so an edit that crashes or exits partway is still never retried */
export async function markTagsRemoved(post: number, tags: Array<string>) {
    add(state().removedTags, post, tags);
    await saveState();
}

export function wasSourceEdited(post: number, source: string) {
    return state().editedSources[post]?.includes(source) ?? false;
}

export async function markSourcesEdited(post: number, sources: Array<string>) {
    add(state().editedSources, post, sources);
    await saveState();
}

export function addPendingSource(post: number, source: string, expires: number) {
    const { pendingSources } = state();
    if (pendingSources.some(p => p.post === post && p.source === source)) {
        return false;
    }
    pendingSources.push({ post, source, expires });
    return true;
}

/** removes and returns everything that expired before `before` */
export function takeExpiredSources(before: number) {
    const s = state();
    const expired = s.pendingSources.filter(p => p.expires <= before);
    if (expired.length !== 0) {
        s.pendingSources = s.pendingSources.filter(p => p.expires > before);
    }
    return expired;
}
