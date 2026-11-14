import { e621 } from "./clients.js";
import { allTags, type HandlerPost, type PostHandler } from "./handler.js";
import logger from "./logger.js";
import RequestQueue from "./queue.js";
import { removeTagsOnce } from "./safeTagRemoval.js";
import { DAY } from "./util.js";

const tags = new Set([
    "invalid_tag",
    "colored_muzzle",
    "iridescent_muzzle",
    "light_muzzle",
    "yellow_muzzle",
    "purple_muzzle",
    "dipstick_muzzle",
    "green_muzzle",
    "two_tone_muzzle",
    "multicolored_muzzle",
    "ten_muzzle",
    "gray_muzzle",
    "white_muzzle",
    "pink_muzzle",
    "brown_muzzle",
    "orange_muzzle",
    "red_muzzle",
    "blue_muzzle",
    "grey_muzzle",
    "cream_muzzle",
    "black_muzzle"
]);

interface Conditional {
    /** used as the edit reason */
    reason?: string;
    when(post: HandlerPost): boolean;
}
// only removed from the posts they're wrong on, they're fine everywhere else
const conditional: Record<string, Conditional> = {
    no_sound: {
        reason: "[cleanup] file cannot have sound",
        when:   post => ["png", "gif", "webp"].includes(post.file.ext)
    }
};

// anything used this much should be looked at by hand, invalid_tag and the conditional ones are always removed
const MAX_POSTS = 100;
const noLimit = new Set(["invalid_tag", ...Object.keys(conditional)]);

const matching = (post: HandlerPost) => allTags(post).filter(tag => tags.has(tag) || conditional[tag]?.when(post));

const lookups = new Map<string, { skip: boolean; time: number; }>();
async function isTooBig(tag: string) {
    if (noLimit.has(tag)) {
        return false;
    }

    const cached = lookups.get(tag);
    if (cached && Date.now() - cached.time < DAY) {
        return cached.skip;
    }

    const [info] = await RequestQueue.add(() => e621.tags.search({ name: tag }));
    const skip = (info?.post_count ?? 0) > MAX_POSTS;
    // only logged when it's looked up, so it isn't repeated for every post
    if (skip) {
        logger.warn(`[cleanup] Skipping ${tag} for the next day, it has ${info!.post_count} posts`);
    }
    lookups.set(tag, { skip, time: Date.now() });
    return skip;
}

const cleanup: PostHandler = {
    name:  "cleanup",
    check: post => matching(post).length !== 0,
    async run(post) {
        // an edit only has one reason, so tags with different ones are removed separately
        const byReason = new Map<string | undefined, Array<string>>();
        for (const tag of matching(post)) {
            if (!await isTooBig(tag)) {
                const reason = tags.has(tag) ? undefined : conditional[tag]!.reason;
                byReason.set(reason, [...byReason.get(reason) ?? [], tag]);
            }
        }

        for (const [reason, remove] of byReason) {
            for (const tag of await removeTagsOnce(post.id, remove, reason)) {
                logger.info(`[cleanup] Removed ${tag} from https://e621.net/posts/${post.id}`);
            }
        }
    }
};
export default cleanup;
