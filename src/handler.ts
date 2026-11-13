import { e621 } from "./clients.js";
import logger from "./logger.js";
import RequestQueue from "./queue.js";
import { DRY_RUN, markSourcesEdited, wasSourceEdited } from "./state.js";
import type { LegacyPost } from "e621stream";

/** what handlers get to look at, it's all export rows have too */
export type HandlerPost = Pick<LegacyPost, "id" | "sources" | "tags">;

export interface PostHandler {
    /**
     * Checked against the stream's copy of the post as each event comes in, so it can't make requests.
     * Only posts this returns true for are queued for `run`.
     */
    check(post: HandlerPost): boolean;
    name: string;
    run(post: HandlerPost): Promise<void>;
}

export function allTags(post: Pick<LegacyPost, "tags">): Array<string> {
    return Object.values(post.tags).flat();
}

/**
 * Replaces sources on a post (`null` removes it), only touching ones that are still there and that we've never edited before.
 * The post is re-fetched first since the stream's copy can be behind, and `old_source` is sent so a conflicting edit isn't clobbered.
 *
 * Returns what was actually changed.
 */
export async function replaceSourcesOnce(id: number, replacements: Map<string, string | null>, reason?: string): Promise<Map<string, string | null>> {
    const live = await RequestQueue.add(() => e621.posts.get(id));
    if (!live) {
        return new Map();
    }

    const changed = new Map<string, string | null>();
    for (const [from, to] of replacements) {
        if (live.sources.includes(from) && !wasSourceEdited(id, from)) {
            changed.set(from, to);
        }
    }
    if (changed.size === 0) {
        return changed;
    }

    const sources: Array<string> = [];
    for (const source of live.sources) {
        const to = changed.has(source) ? changed.get(source)! : source;
        if (to !== null && !sources.includes(to)) {
            sources.push(to);
        }
    }

    let summary = [...changed].map(([from, to]) => `- <${from}> -> ${to === null ? "(removed)" : `<${to}>`}`).join("\n");
    if (reason) {
        summary += `\nReason: ${reason}`;
    }
    if (DRY_RUN) {
        logger.info(`[sources] [dry run] Would edit https://e621.net/posts/${id}\n${summary}`);
        return changed;
    }

    await markSourcesEdited(id, [...changed.keys()]);
    await RequestQueue.add(() => e621.posts.update(id, {
        source:     sources.join("\n"),
        old_source: live.sources.join("\n"),
        ...(reason ? { edit_reason: reason } : {})
    }));
    logger.info(`[sources] Edited https://e621.net/posts/${id}\n${summary}`);
    return changed;
}
