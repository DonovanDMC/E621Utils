import { e621 } from "./clients.js";
import logger, { flush } from "./logger.js";
import RequestQueue from "./queue.js";
import { DRY_RUN, markTagsRemoved, wasTagRemoved } from "./state.js";
import type { Post } from "e621";

function flattenTags(tags: Post["tags"]): Array<string> {
    return Object.values(tags).flat();
}

// posts can be behind on implications (usually ones still processing), any edit will cause missing implied tags to be added
async function isImpliedBy(tag: string, tags: Array<string>): Promise<boolean> {
    const implications = await RequestQueue.add(() => e621.tagImplications.search({ consequent_name: tag, limit: 320 }));
    return implications.some(implication => ["active", "processing"].includes(implication.status) && tags.includes(implication.antecedent_name));
}

/**
 * Removes `tagsToRemove` from post `id`.
 *
 * This exists because a typo (`tag_string`, which replaces every tag on a post,
 * used where `tag_string_diff` was meant) combined with an array being
 * interpolated directly into the diff string (`-${tags}` joins with commas
 * instead of producing one "-tag" per tag) silently wiped every tag off of
 * several posts. Nothing caught it until the tags were already gone.
 *
 * To prevent that class of bug from doing damage again, this re-fetches the
 * post immediately before editing (the export dumps callers read from can be
 * stale) and re-checks it immediately after editing:
 *   - Before: if a tag we mean to remove is no longer present, or removing
 *     everything we're asked to would strip the post down to nothing, the
 *     post is skipped and left untouched.
 *   - After: the response from the update is compared against exactly what
 *     should have changed. Added tags are allowed if they're implied by a tag
 *     on the post, since the post may have been behind on implications.
 *     If anything other than the intended tags moved,
 *     the post is reverted to its pre-edit tags and the process exits
 *     immediately, since at that point the API is behaving in a way this
 *     script doesn't understand and continuing could silently damage more
 *     posts.
 *
 * Returns whether an edit was actually made.
 */
export async function safeRemoveTags(id: number, tagsToRemove: Array<string>): Promise<boolean> {
    if (tagsToRemove.length === 0) {
        return false;
    }

    const live = await RequestQueue.add(() => e621.posts.get(id));
    if (!live) {
        logger.info(`[safeRemoveTags] Skipping post ${id}: it no longer exists`);
        return false;
    }

    const before = flattenTags(live.tags);
    // locked tags can't be removed anyway, and someone locked them for a reason
    const toRemove = tagsToRemove.filter(tag => before.includes(tag) && !live.locked_tags?.includes(tag));
    if (toRemove.length === 0) {
        return false;
    }

    if (toRemove.length >= before.length) {
        logger.warn(`[safeRemoveTags] Skipping https://e621.net/posts/${id}: refusing to remove ${toRemove.length} of its ${before.length} total tag(s) (${toRemove.join(", ")})`);
        return false;
    }

    const expectedAfter = before.filter(tag => !toRemove.includes(tag));
    const diff = toRemove.map(tag => `-${tag}`).join(" ");
    if (DRY_RUN) {
        logger.info(`[safeRemoveTags] [dry run] Would remove "${toRemove.join(" ")}" from ${id}`);
        return true;
    }

    const updated = await RequestQueue.add(() => e621.posts.update(id, {
        tag_string_diff: diff,
        old_tag_string:  before.join(" ")
    }));

    const after = flattenTags(updated.tags);
    const stillPresent = toRemove.filter(tag => after.includes(tag));
    const missingExpected = expectedAfter.filter(tag => !after.includes(tag));
    const unexpectedExtra: Array<string> = [];
    for (const tag of after.filter(t => !expectedAfter.includes(t))) {
        if (!await isImpliedBy(tag, after)) {
            unexpectedExtra.push(tag);
        }
    }

    if (stillPresent.length !== 0 || missingExpected.length !== 0 || unexpectedExtra.length !== 0) {
        const details = [
            `[safeRemoveTags] SANITY CHECK FAILED updating https://e621.net/posts/${id} - reverting immediately`,
            `Attempted to remove: ${toRemove.join(" ")}`,
            stillPresent.length === 0 ? null : `Should have been removed but weren't: ${stillPresent.join(" ")}`,
            missingExpected.length === 0 ? null : `Removed unexpectedly: ${missingExpected.join(" ")}`,
            unexpectedExtra.length === 0 ? null : `Present unexpectedly: ${unexpectedExtra.join(" ")}`,
            `Before: ${before.join(" ")}`,
            `Expected after: ${expectedAfter.join(" ")}`,
            `Actual after: ${after.join(" ")}`
        ];
        logger.error(details.filter(Boolean).join("\n"));

        try {
            await RequestQueue.add(() => e621.posts.update(id, {
                tag_string:  before.join(" "),
                edit_reason: "automatic revert: sanity check failed after tag removal"
            }));
            logger.error(`[safeRemoveTags] Reverted https://e621.net/posts/${id} to its original tags.`);
        } catch (err) {
            logger.error(`[safeRemoveTags] FAILED TO REVERT https://e621.net/posts/${id}! Manual intervention required. Its tags before this script ran were: ${before.join(" ")}\n`, err);
        }

        // make sure this gets out before exiting
        await flush();
        process.exit(1);
    }

    return true;
}

/**
 * {@link safeRemoveTags}, but each tag is only ever removed from a post once. If someone
 * puts it back after that, it's left alone instead of fighting them over it.
 */
export async function removeTagsOnce(id: number, tags: Array<string>): Promise<Array<string>> {
    const toRemove: Array<string> = [];
    for (const tag of tags) {
        if (!toRemove.includes(tag) && !wasTagRemoved(id, tag)) {
            toRemove.push(tag);
        }
    }
    if (toRemove.length === 0) {
        return [];
    }

    await markTagsRemoved(id, toRemove);
    return await safeRemoveTags(id, toRemove) ? toRemove : [];
}
