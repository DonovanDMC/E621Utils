import { type HandlerPost, type PostHandler, replaceSourcesOnce } from "./handler.js";
import logger from "./logger.js";
import { addPendingSource, saveState, takeExpiredSources, wasSourceEdited } from "./state.js";

const CDN = "https://cdn.discordapp.com", MEDIA = "https://media.discordapp.net";
const expiryParams = new Set(["ex", "hm", "is"]);
// wait a bit past the expiry, so the url has definitely stopped working before it's marked dead
const GRACE_MS = 10 * 60 * 1000;

function isDiscord(source: string) {
    return source.startsWith(CDN) || source.startsWith(MEDIA);
}

function getParams(source: string) {
    try {
        return new URL(source).searchParams;
    } catch {
        return new URLSearchParams();
    }
}

const onlyExpiryParams = (params: URLSearchParams) => Array.from(params.keys()).every(p => expiryParams.has(p));

/** when a signed discord url stops working, in ms */
export function getExpiry(source: string) {
    const ex = parseInt(getParams(source).get("ex") ?? "", 16);
    return isNaN(ex) ? null : ex * 1000;
}

/**
 * What a discord source should be replaced with right now, or null if it's fine for now.
 * media.discordapp.net links are swapped for cdn.discordapp.com, and anything unsigned or expired
 * is marked dead (`-url`) with the expiry params stripped.
 */
export function fixSource(source: string, now = Date.now()) {
    if (!isDiscord(source)) {
        return null;
    }

    const params = getParams(source);
    let fixed = source;
    if (fixed.startsWith(MEDIA) && onlyExpiryParams(params)) {
        fixed = fixed.replace(MEDIA, CDN);
    }

    if (!fixed.includes("?")) {
        return `-${fixed}`;
    }

    const expires = getExpiry(fixed);
    if (expires === null || expires < now) {
        const query = new URLSearchParams(Array.from(params).filter(([key]) => !expiryParams.has(key))).toString();
        return `-${fixed.split("?")[0]}${query.length === 0 ? "" : `?${query}`}`;
    }

    return fixed === source ? null : fixed;
}

/** e.g. 2026-11-13 04:05:06 UTC */
function formatUTC(time: number) {
    return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

async function fix(post: number, sources: Array<string>, now = Date.now()) {
    const replacements = new Map<string, string>(), expiries = new Set<number>();
    for (const source of sources) {
        const fixed = fixSource(source, now);
        if (fixed === null) {
            continue;
        }

        replacements.set(source, fixed);
        const expires = getExpiry(source);
        if (expires !== null && expires < now) {
            expiries.add(expires);
        }
    }
    if (replacements.size === 0) {
        return;
    }

    const reason = expiries.size === 0 ? undefined : `[discord-cdn-params] URL expired at ${formatUTC(Math.min(...expiries))}`;
    await replaceSourcesOnce(post, replacements, reason);
}

const discordCDNParams: PostHandler = {
    name:  "discord-cdn-params",
    check: post => post.sources.some(source => isDiscord(source) && !wasSourceEdited(post.id, source)),
    async run(post: HandlerPost) {
        const now = Date.now(), fixNow: Array<string> = [];
        let added = false;
        for (const source of post.sources) {
            if (!isDiscord(source) || wasSourceEdited(post.id, source)) {
                continue;
            }

            if (fixSource(source, now) !== null) {
                fixNow.push(source);
                continue;
            }

            // still valid, so it gets marked dead once it expires
            const expires = getExpiry(source);
            if (expires !== null && addPendingSource(post.id, source, expires)) {
                added = true;
            }
        }

        if (added) {
            await saveState();
        }
        await fix(post.id, fixNow, now);
    }
};
export default discordCDNParams;

/** fixes every tracked url that has expired */
export async function fixExpiredSources() {
    const now = Date.now();
    const expired = takeExpiredSources(now - GRACE_MS);
    if (expired.length === 0) {
        return;
    }

    await saveState();
    const byPost = Map.groupBy(expired, p => p.post);
    for (const [post, entries] of byPost) {
        try {
            await fix(post, entries.map(e => e.source), now);
        } catch (err) {
            logger.error(`[discord-cdn-params] Failed to fix post ${post}, retrying later:`, err);
            for (const entry of entries) {
                addPendingSource(entry.post, entry.source, entry.expires);
            }
            await saveState();
        }
    }
}
