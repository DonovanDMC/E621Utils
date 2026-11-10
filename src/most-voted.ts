import RequestQueue from "./queue.js";
import { DAY, dataDir, exists } from "./util.js";
import config from "../config.json" with { type: "json" };
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface VoteRequest {
    forum_post_id: number | null;
    forum_topic_id: number | null;
    id: number;
    title: string;
}

export interface Votes {
    down: number;
    flip: number;
    id: number;
    meh: number;
    total: number;
    up: number;
}

export interface VoteSource<T> {
    // shown in the table, e.g. "BUR #123", which dtext also links
    label: string;
    // used for the cache file and the script name
    name: string;
    // e.g. tag_aliases, used for both the json listing and the html pages
    path: string;
    fillTitles?(requests: Array<VoteRequest>): Promise<void>;
    toRequest(raw: T): VoteRequest;
}

export type SortBy = Exclude<keyof Votes, "id">;
export const sorts = ["up", "down", "meh", "flip", "total"] as const satisfies ReadonlyArray<SortBy>;

// search[id] accepts up to 320 comma separated ids
export const MAX_IDS = 320;
const headers = {
    "Authorization": `Basic ${Buffer.from(`${config.authUser}:${config.authKey}`).toString("base64")}`,
    "User-Agent":    "MostVotedAIBUR (by donovan_dmc)"
};

export async function get<T>(url: string, json: true): Promise<T>;
export async function get(url: string, json: false): Promise<string>;
export async function get(url: string, json: boolean) {
    return RequestQueue.add(async() => {
        console.error(`-> ${url}`);
        const res = await fetch(url, { headers });
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText} for ${url}`);
        }
        return json ? res.json() : res.text();
    });
}

async function getPending<T>(source: VoteSource<T>) {
    const requests: Array<VoteRequest> = [];
    for (let page = 1; ; page++) {
        const list = await get<Array<T>>(`https://e621.net/${source.path}.json?limit=320&page=${page}&search[status]=pending&search[order]=id_asc`, true);
        requests.push(...list.map(raw => source.toRequest(raw)));
        if (list.length < 320) {
            break;
        }
    }

    return requests;
}

const noVotes = (id: number): Votes => ({ id, up: 0, down: 0, meh: 0, flip: 0, total: 0 });

function parseVotes(id: number, html: string): Votes {
    const votes = noVotes(id);
    // the vote list isn't rendered at all when there are no votes
    const list = html.match(/<ul[^>]*class="forum-post-vote-list"[^>]*>/)?.[0];
    if (!list) {
        return votes;
    }

    for (const [ul] of html.matchAll(/<ul[^>]*class="forum-post-votes"[^>]*>/g)) {
        const type = ul.match(/data-vote="(\w+)"/)?.[1];
        const count = Number(ul.match(/data-vote-count="(\d+)"/)?.[1] ?? 0);
        if (type === "up" || type === "down" || type === "meh" || type === "flip") {
            votes[type] = count;
        } else {
            console.error(`Unknown vote type "${type}" on #${id}`);
        }
    }

    votes.total = votes.up + votes.down + votes.meh + votes.flip;
    const expected = Number(list.match(/data-vote-count="(\d+)"/)?.[1]);
    if (votes.total !== expected) {
        throw new Error(`Vote counts for #${id} don't add up (${votes.total} != ${expected}), the html has probably changed`);
    }

    return votes;
}

interface Cache {
    created: number;
    requests: Array<VoteRequest>;
    votes: Array<Votes>;
}

// cached for a day so an interrupted run can pick back up
async function load<T>(source: VoteSource<T>, fresh: boolean) {
    const file = join(dataDir, `${source.name}-votes.json`);
    if (!fresh && await exists(file)) {
        const cache = JSON.parse(await readFile(file, "utf8")) as Cache;
        if (Date.now() - cache.created < DAY) {
            console.error(`Resuming from ${file} (${cache.votes.length}/${cache.requests.length} done)`);
            return { file, cache };
        }
    }

    const requests = await getPending(source);
    await source.fillTitles?.(requests);
    const cache: Cache = { created: Date.now(), requests, votes: [] };
    await writeFile(file, JSON.stringify(cache));
    return { file, cache };
}

export async function getMostVoted<T>(source: VoteSource<T>, sortBy: SortBy = "total", count = 100, fresh = false) {
    const { file, cache } = await load(source, fresh);
    const { requests, votes } = cache;
    const done = new Set(votes.map(v => v.id));
    const remaining = requests.filter(r => !done.has(r.id));
    const save = async() => writeFile(file, JSON.stringify(cache));
    // keep whatever was done since the last save when stopped with ctrl+c
    const onInterrupt = () => {
        writeFileSync(file, JSON.stringify(cache));
        console.error(`Saved ${votes.length}/${requests.length} to ${file}`);
        process.exit(130);
    };
    process.once("SIGINT", onInterrupt);

    let i = 0;
    for (const request of remaining) {
        // without a forum post there's nothing to vote on
        votes.push(request.forum_post_id ? parseVotes(request.id, await get(`https://e621.net/${source.path}/${request.id}`, false)) : noVotes(request.id));
        if (++i % 100 === 0) {
            console.error(`${votes.length}/${requests.length}`);
            await save();
        }
    }
    await save();
    process.off("SIGINT", onInterrupt);

    if (votes.length !== 0 && votes.every(v => v.total === 0)) {
        throw new Error("No votes found on anything, the html has probably changed");
    }

    const byId = new Map(requests.map(r => [r.id, r]));
    return votes
        .toSorted((a, b) => b[sortBy] - a[sortBy] || b.total - a.total)
        .slice(0, count)
        .map(v => ({ ...v, title: byId.get(v.id)!.title, url: `https://e621.net/${source.path}/${v.id}` }));
}

// forum posts are capped at 50,000 characters
const MAX_BODY = 50_000;
const SHOWN = 25;

export function toDText<T>(source: VoteSource<T>, rows: Awaited<ReturnType<typeof getMostVoted>>) {
    const table = (part: typeof rows, offset: number) => [
        `[table][thead][tr][td]${source.label}[/td][td]Total[/td][td]Up[/td][td]Down[/td][td]Meh[/td][td]Flip[/td][td]Title[/td][/tr][/thead][tbody]`,
        ...part.map((v, i) => `[tr][td]${source.label} #${v.id} (#${offset + i + 1})[/td][td]${v.total}[/td][td]${v.up}[/td][td]${v.down}[/td][td]${v.meh}[/td][td]${v.flip}[/td][td]${v.title}[/td][/tr]`),
        "[/tbody][/table]"
    ].join("\n");

    // drop rows off the end until it fits in a single post
    for (let end = rows.length; ; end--) {
        let body = table(rows.slice(0, Math.min(end, SHOWN)), 0);
        if (end > SHOWN) {
            body += `\n\n[section=Top ${end} (${SHOWN + 1}-${end})]\n${table(rows.slice(SHOWN, end), SHOWN)}\n[/section]`;
        }

        if (body.length <= MAX_BODY || end <= SHOWN) {
            if (end < rows.length) {
                console.error(`Trimmed to ${end} rows to fit in ${MAX_BODY} characters`);
            }
            return body;
        }
    }
}

export async function runCLI<T>(source: VoteSource<T>) {
    const args = process.argv.slice(2);
    const fresh = args.includes("--fresh");
    const [sortBy = "total", count = "500"] = args.filter(a => a !== "--fresh");
    if (!sorts.includes(sortBy as SortBy) || Number.isNaN(Number(count))) {
        console.error(`Usage: bun src/most-voted-${source.name}.ts [${sorts.join("|")}] [count] [--fresh]`);
        process.exit(1);
    }

    console.log(toDText(source, await getMostVoted(source, sortBy as SortBy, Number(count), fresh)));
}
