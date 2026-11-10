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

// anything used this much should be looked at by hand, invalid_tag is always removed
const MAX_POSTS = 100;
const noLimit = new Set(["invalid_tag"]);

const matching = (post: HandlerPost) => allTags(post).filter(tag => tags.has(tag));

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
        logger.warn(`[nuke-tags] Skipping ${tag} for the next day, it has ${info!.post_count} posts`);
    }
    lookups.set(tag, { skip, time: Date.now() });
    return skip;
}

const nukeTags: PostHandler = {
    name:  "nuke-tags",
    check: post => matching(post).length !== 0,
    async run(post) {
        const remove: Array<string> = [];
        for (const tag of matching(post)) {
            if (!await isTooBig(tag)) {
                remove.push(tag);
            }
        }

        for (const tag of await removeTagsOnce(post.id, remove)) {
            logger.info(`[nuke-tags] Removed ${tag} from https://e621.net/posts/${post.id}`);
        }
    }
};
export default nukeTags;
