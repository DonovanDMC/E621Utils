import { discord } from "./clients.js";
import logger from "./logger.js";
import RequestQueue from "./queue.js";
import { DRY_RUN } from "./state.js";
import { getStream } from "./stream.js";
import { dataDir, isDirectRun } from "./util.js";
import config from "../config.json" with { type: "json" };
import type { PostVersion } from "e621stream";
import { ButtonStyles, ComponentTypes } from "oceanic.js";
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const channel = (config as { revertsChannel?: string; }).revertsChannel || null;
/** without a channel there's nowhere to log them, so nothing is crawled or tracked */
export const revertsEnabled = channel !== null;

const me = config.authUser.toLowerCase().replaceAll(" ", "_");
const auth = `Basic ${Buffer.from(`${config.authUser}:${config.authKey}`).toString("base64")}`;

// the version fields that matter here, the crawl and the stream both have them
type Version = Pick<PostVersion, "added_tags" | "id" | "parent_changed" | "parent_id" | "post_id" | "rating" | "rating_changed" | "reason" | "removed_tags" | "tags" | "updated_at" | "updater_id" | "updater_name" | "version">;

type EditType = "tag" | "rating" | "parent";
interface Edit {
    /** the tag, empty for rating and parent */
    key: string;
    post_id: number;
    type: EditType;
    /** "+" or "-" for tags, the rating, or the parent id ("" for none) */
    value: string;
    /** our version that made this edit */
    version: number;
}

/**
 * The newest edit we've made to each tag, rating, and parent on a post, as long as it's still in place.
 * Over 550k versions is too much to keep in memory, so it's in sqlite.
 */
let db: Database | undefined;
function getDB() {
    if (db === undefined) {
        db = new Database(`${dataDir}/reverts.sqlite`, { create: true });
        db.run("PRAGMA journal_mode = WAL");
        db.run("CREATE TABLE IF NOT EXISTS edits (post_id INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (post_id, type, key)) WITHOUT ROWID");
        db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }
    return db;
}

function getMeta(key: string) {
    return getDB().query<{ value: string; }>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

function setMeta(key: string, value: string | number) {
    getDB().query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

const isMine = (v: Pick<Version, "updater_name">) => v.updater_name.toLowerCase() === me;

/** what one of our versions changed, version 1 is the upload so it isn't counted */
function editsOf(v: Version): Array<Edit> {
    if (v.version === 1) {
        return [];
    }
    const base = { post_id: v.post_id, version: v.id };
    return [
        ...v.added_tags.map(tag => ({ ...base, type: "tag" as const, key: tag, value: "+" })),
        ...v.removed_tags.map(tag => ({ ...base, type: "tag" as const, key: tag, value: "-" })),
        ...(v.rating_changed ? [{ ...base, type: "rating" as const, key: "", value: v.rating }] : []),
        ...(v.parent_changed ? [{ ...base, type: "parent" as const, key: "", value: String(v.parent_id ?? "") }] : [])
    ];
}

/** the crawl goes newest first, so anything already there is newer and kept. live versions only replace older ones */
function saveEdits(edits: Array<Edit>, keepExisting: boolean) {
    const insert = getDB().query(keepExisting ?
        "INSERT OR IGNORE INTO edits (post_id, type, key, value, version) VALUES (?, ?, ?, ?, ?)" :
        "INSERT INTO edits (post_id, type, key, value, version) VALUES (?, ?, ?, ?, ?) ON CONFLICT (post_id, type, key) DO UPDATE SET value = excluded.value, version = excluded.version WHERE excluded.version > edits.version");
    for (const e of edits) {
        insert.run(e.post_id, e.type, e.key, e.value, e.version);
    }
}

/** only deleted if they haven't been replaced by a newer edit of ours in the meantime */
function deleteEdits(edits: Array<Edit>) {
    const del = getDB().query("DELETE FROM edits WHERE post_id = ? AND type = ? AND key = ? AND version = ?");
    for (const e of edits) {
        del.run(e.post_id, e.type, e.key, e.version);
    }
}

/** our edits on the post that someone else's version reverses */
export function findUndone(v: Version) {
    if (!revertsEnabled || isMine(v)) {
        return [];
    }
    const added = new Set(v.added_tags), removed = new Set(v.removed_tags);
    return getDB().query<Edit>("SELECT * FROM edits WHERE post_id = ? AND version < ?").all(v.post_id, v.id).filter(e => {
        switch (e.type) {
            case "tag": return e.value === "+" ? removed.has(e.key) : added.has(e.key);
            case "rating": return v.rating_changed && v.rating !== e.value;
            case "parent": return v.parent_changed && String(v.parent_id ?? "") !== e.value;
        }
    });
}

/** our own versions update what's tracked, returns true if it was ours */
export function handleOwnVersion(v: Version) {
    if (!revertsEnabled || !isMine(v)) {
        return false;
    }
    saveEdits(editsOf(v), false);
    return true;
}

const RATINGS: Record<string, string> = { s: "Safe", q: "Questionable", e: "Explicit" };
const parentText = (value: string) => value === "" ? "none" : `#${value}`;

function describe(e: Edit, v: Version) {
    const ours = `[ours](https://e621.net/post_versions?search[id]=${e.version})`;
    switch (e.type) {
        case "tag": return e.value === "+" ? `- Removed \`${e.key}\` (${ours} added it)` : `- Re-added \`${e.key}\` (${ours} removed it)`;
        case "rating": return `- Rating changed to **${RATINGS[v.rating]}** (${ours} set **${RATINGS[e.value]}**)`;
        case "parent": return `- Parent changed to ${parentText(String(v.parent_id ?? ""))} (${ours} set ${parentText(e.value)})`;
    }
}

/** logs our edits that someone else's version reversed, they're only logged once since they're no longer tracked after */
export async function handleUndone(v: Version) {
    // checked again, the version may have been queued behind changes to the same post
    const tags = new Set(v.tags.split(" "));
    const undone: Array<Edit> = [], related: Array<Edit> = [];
    for (const e of findUndone(v)) {
        (await byTagRelation(e, tags) ? related : undone).push(e);
    }
    // they aren't on the post the way we left them anymore either way, those just aren't logged
    if (!DRY_RUN) {
        deleteEdits(related);
    }
    if (undone.length === 0) {
        return;
    }

    let description = undone.map(e => describe(e, v)).join("\n");
    if (v.reason) {
        description += `\n\nReason: ${v.reason}`;
    }
    if (DRY_RUN) {
        logger.info(`[reverts] [dry run] Would log ${v.updater_name} undoing edits on https://e621.net/posts/${v.post_id}\n${description}`);
        return;
    }

    await discord().rest.channels.createMessage(channel!, {
        embeds: [
            {
                title:       `Edits undone on #${v.post_id} by ${v.updater_name}`.slice(0, 256),
                url:         `https://e621.net/post_versions?search[post_id]=${v.post_id}`,
                author:      { name: v.updater_name, url: `https://e621.net/users/${v.updater_id}` },
                description: description.length > 4096 ? `${description.slice(0, 4093)}...` : description,
                footer:      { text: `Version ${v.version}` },
                color:       0xDC143C,
                timestamp:   v.updated_at
            }
        ],
        components: [
            {
                type:       ComponentTypes.ACTION_ROW,
                components: [{ type: ComponentTypes.BUTTON, style: ButtonStyles.LINK, label: "View Post", url: `https://e621.net/posts/${v.post_id}` }]
            }
        ],
        allowedMentions: { everyone: false, roles: false, users: false }
    });
    deleteEdits(undone);
}

async function get<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await RequestQueue.add(async() => {
                const res = await fetch(`https://e621.net${path}`, {
                    headers: { "Authorization": auth, "User-Agent": "E621Utils (by donovan_dmc)" },
                    signal:  AbortSignal.timeout(60_000)
                });
                if (!res.ok) {
                    throw new Error(`e621 returned ${res.status} for ${path}`);
                }
                return res.json() as Promise<T>;
            });
        } catch (err) {
            if (attempt === 5) {
                throw err;
            }
            console.warn(`[reverts] Request failed (attempt ${attempt}), retrying in ${attempt * 30} seconds:`, err);
            await sleep(attempt * 30_000);
        }
    }
}

/** goes through all of our versions newest first, page numbers stop at the newest 10k so it has to go by id */
async function crawl() {
    let before = getMeta("crawl.before");
    logger.info(before === null ? "[reverts] Crawling our post versions" : `[reverts] Resuming the crawl before version ${before}`);
    let count = 0, pages = 0;
    const savePage = getDB().transaction((versions: Array<Version>, last: number) => {
        for (const v of versions) {
            if (isMine(v)) {
                saveEdits(editsOf(v), true);
            }
        }
        setMeta("crawl.before", last);
    });
    for (;;) {
        const versions = await get<Array<Version>>(`/post_versions.json?search[updater_name]=${encodeURIComponent(config.authUser)}&limit=320${before === null ? "" : `&page=b${before}`}`);
        if (versions.length === 0) {
            break;
        }
        versions.sort((a, b) => b.id - a.id);
        before = String(versions.at(-1)!.id);
        savePage(versions, Number(before));
        count += versions.length;
        if ((++pages % 100) === 0) {
            console.log(`[reverts] Crawled ${count} versions, now before ${before}`);
        }
    }
    setMeta("crawl.done", 1);
    logger.info(`[reverts] Crawl finished, ${count} versions this run`);
}

interface Relation {
    antecedent_name: string;
    consequent_name: string;
    id: number;
    status: string;
}
// e621 gives an object instead of an empty array when nothing matches
const list = <T>(body: Array<T> | object) => Array.isArray(body) ? body : [];

// aliases and implications rarely change, but they're cleared every so often so new ones are picked up
const aliased = new Map<string, boolean>(), implications = new Map<string, { active: Set<string>; removed: Set<string>; }>();
let relationsLoaded = Date.now();
function resetRelations() {
    if (Date.now() - relationsLoaded > 6 * 60 * 60 * 1000 || aliased.size + implications.size > 20_000) {
        aliased.clear();
        implications.clear();
        relationsLoaded = Date.now();
    }
}

async function loadAliases(tags: Array<string>) {
    resetRelations();
    const missing = [...new Set(tags)].filter(t => !aliased.has(t));
    for (let i = 0; i < missing.length; i += 100) {
        const batch = missing.slice(i, i + 100);
        const found = list(await get<Array<Relation>>(`/tag_aliases.json?limit=320&search[status]=active&search[antecedent_name]=${encodeURIComponent(batch.join(","))}`));
        for (const tag of batch) {
            aliased.set(tag, found.some(a => a.antecedent_name === tag));
        }
    }
}

/**
 * The tags that directly imply this one (anything further up implies one of these too), and ones that used to.
 * Removing an implication takes the implied tag off posts without a post version.
 */
async function getImplications(tag: string) {
    resetRelations();
    let found = implications.get(tag);
    if (found === undefined) {
        found = { active: new Set(), removed: new Set() };
        for (let before: number | null = null; ;) {
            const page = list(await get<Array<Relation>>(`/tag_implications.json?limit=320&search[consequent_name]=${encodeURIComponent(tag)}${before === null ? "" : `&page=b${before}`}`));
            for (const i of page) {
                if (i.status === "active") {
                    found.active.add(i.antecedent_name);
                } else if (i.status === "deleted" || i.status === "retired") {
                    found.removed.add(i.antecedent_name);
                }
            }
            if (page.length < 320) {
                break;
            }
            before = Math.min(...page.map(i => i.id));
        }
        implications.set(tag, found);
    }
    return found;
}

/** a tag of ours that an alias or removed implication took off, or that an implication put back, rather than someone undoing it */
async function byTagRelation(e: Edit, tags: Set<string>) {
    if (e.type !== "tag") {
        return false;
    }
    if (e.value === "+") {
        await loadAliases([e.key]);
        if (aliased.get(e.key)) {
            return true;
        }
    }
    const { active, removed } = await getImplications(e.key);
    return [...(e.value === "+" ? removed : active)].some(tag => tags.has(tag));
}

interface CurrentPost {
    parent: string;
    rating: string;
    tags: Set<string>;
}

// snapshots count towards the stream's 120 messages a minute (our account is privileged), so they're kept well under it
const SNAPSHOT_INTERVAL_MS = 1000, SNAPSHOT_SIZE = 1000;
// what one posts search can return
const SEARCH_SIZE = 300;
let lastSnapshot = 0;

/**
 * The current state of the posts, destroyed posts are left out. The stream's snapshots are used where it has
 * them, which saves e621 the requests, and anything it doesn't have (or isn't connected for) is fetched from e621.
 */
async function getPosts(ids: Array<number>) {
    const found = new Map<number, CurrentPost>();
    const stream = getStream();
    if (stream) {
        for (let i = 0; i < ids.length; i += SNAPSHOT_SIZE) {
            const wait = lastSnapshot + SNAPSHOT_INTERVAL_MS - Date.now();
            if (wait > 0) {
                await sleep(wait);
            }
            lastSnapshot = Date.now();
            // anything that fails is fetched from e621 below
            const snapshots = await stream.snapshots("post", ids.slice(i, i + SNAPSHOT_SIZE)).catch(() => null);
            for (const snap of Object.values(snapshots ?? {})) {
                // only id is guaranteed, the rest are fetched if any are missing
                if (snap?.tags && snap.rating && snap.parent_id !== undefined) {
                    found.set(snap.id, { parent: String(snap.parent_id ?? ""), rating: snap.rating, tags: new Set(Object.values(snap.tags).flat()) });
                }
            }
        }
    }

    const missing = ids.filter(id => !found.has(id));
    for (let i = 0; i < missing.length; i += SEARCH_SIZE) {
        const { posts } = await get<{ posts: Array<{ id: number; rating: string; relationships: { parent_id: number | null; }; tags: Record<string, Array<string>>; }>; }>(`/posts.json?limit=320&tags=${encodeURIComponent(`status:any id:${missing.slice(i, i + SEARCH_SIZE).join(",")}`)}`);
        for (const p of posts) {
            found.set(p.id, { parent: String(p.relationships.parent_id ?? ""), rating: p.rating, tags: new Set(Object.values(p.tags).flat()) });
        }
    }
    return found;
}

function stillInPlace(e: Edit, post: CurrentPost) {
    switch (e.type) {
        case "tag": return post.tags.has(e.key) === (e.value === "+");
        case "rating": return post.rating === e.value;
        case "parent": return post.parent === e.value;
    }
}

function describeExisting(e: Edit, post: CurrentPost) {
    const ours = `https://e621.net/post_versions?search[id]=${e.version}`;
    switch (e.type) {
        case "tag": return e.value === "+" ? `  Removed ${e.key} (we added it in ${ours})` : `  Re-added ${e.key} (we removed it in ${ours})`;
        case "rating": return `  Rating is now ${RATINGS[post.rating]} (we set ${RATINGS[e.value]} in ${ours})`;
        case "parent": return `  Parent is now ${parentText(post.parent)} (we set ${parentText(e.value)} in ${ours})`;
    }
}

/** everything the check finds was already undone, grouped by post */
const existingFile = `${dataDir}/reverts-existing.txt`;

/** drops anything that was already undone before tracking started, so it isn't mistaken for a new revert later */
async function verify() {
    let after = Number(getMeta("verify.after") ?? 0);
    logger.info(after === 0 ? "[reverts] Checking the crawled edits against the current posts" : `[reverts] Resuming the check after post ${after}`);
    let undone = 0, related = 0, destroyed = 0;
    const select = getDB().query<{ post_id: number; }>(`SELECT DISTINCT post_id FROM edits WHERE post_id > ? ORDER BY post_id LIMIT ${SNAPSHOT_SIZE}`);
    const editsFor = getDB().query<Edit>("SELECT * FROM edits WHERE post_id = ?");
    const save = getDB().transaction((stale: Array<Edit>, text: string, last: number) => {
        // written before the batch is committed, so a crash can repeat a batch but never lose one
        if (text !== "") {
            appendFileSync(existingFile, text);
        }
        deleteEdits(stale);
        setMeta("verify.after", last);
    });
    for (;;) {
        const ids = select.all(after).map(r => r.post_id);
        if (ids.length === 0) {
            break;
        }
        const posts = await getPosts(ids);
        const stale: Array<Edit> = [];
        let text = "";
        for (const id of ids) {
            const post = posts.get(id);
            const edits = editsFor.all(id);
            // destroyed posts aren't reverts, they're just dropped
            if (!post) {
                stale.push(...edits);
                destroyed += edits.length;
                continue;
            }
            const lines: Array<string> = [];
            for (const e of edits.filter(e => !stillInPlace(e, post))) {
                stale.push(e);
                if (await byTagRelation(e, post.tags)) {
                    related++;
                } else {
                    lines.push(describeExisting(e, post));
                    undone++;
                }
            }
            if (lines.length !== 0) {
                text += `#${id} https://e621.net/posts/${id}\n${lines.join("\n")}\n\n`;
            }
        }
        save(stale, text, ids.at(-1)!);
        after = ids.at(-1)!;
    }
    setMeta("verify.done", 1);
    const { total } = getDB().query<{ total: number; }>("SELECT COUNT(*) AS total FROM edits").get()!;
    logger.info(`[reverts] Check finished, ${undone} edits were already undone (saved to ${existingFile}), ${related} were changed by aliases or implications, ${destroyed} were on destroyed posts. ${total} are being tracked`);
}

/** the first run crawls everything, after that it's all from the stream. resumes where it left off after a restart */
export async function runRevertsBackfill() {
    if (!revertsEnabled) {
        return;
    }
    if (getMeta("crawl.done") === null) {
        await crawl();
    }
    if (getMeta("verify.done") === null) {
        await verify();
    }
}

if (isDirectRun(import.meta.url)) {
    await runRevertsBackfill();
}
