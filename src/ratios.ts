import { e621 } from "./clients.js";
import { allTags, type HandlerPost, type PostHandler } from "./handler.js";
import logger from "./logger.js";
import RequestQueue from "./queue.js";
import { removeTagsOnce } from "./safeTagRemoval.js";
import { DAY } from "./util.js";

const whitelisted = new Set([
    "1:1",
    "2:1", "3:1", "3:2", "4:3", "5:3",
    "5:4", "6:5", "7:3", "21:9", "7:4",
    "8:5", "16:10", "11:8", "14:9", "16:9",
    "256:135", "1:2", "9:18", "1:3", "2:3",
    "3:4", "3:5", "4:5", "4:7", "5:6",
    "5:8", "9:14", "9:16", "135:256", "6:13"
]);
// anything used this much is probably intentional, and should be looked at by hand
const MAX_POSTS = 25;

const ratio = /^\d+:\d+$/;
const candidates = (post: HandlerPost) => allTags(post).filter(tag => ratio.test(tag) && !whitelisted.has(tag));

const lookups = new Map<string, { remove: boolean; time: number; }>();
async function shouldRemove(tag: string) {
    const cached = lookups.get(tag);
    if (cached && Date.now() - cached.time < DAY) {
        return cached.remove;
    }

    let remove = true;
    const aliases = [
        ...await RequestQueue.add(() => e621.tagAliases.search({ antecedent_name: tag, status: "active" })),
        ...await RequestQueue.add(() => e621.tagAliases.search({ consequent_name: tag, status: "active" }))
    ];
    if (aliases.some(a => whitelisted.has(a.antecedent_name) || whitelisted.has(a.consequent_name))) {
        remove = false;
    } else {
        const [info] = await RequestQueue.add(() => e621.tags.search({ name: tag }));
        if (info && info.post_count > MAX_POSTS) {
            logger.info(`[ratios] Skipping ${tag} (${info.post_count})`);
            remove = false;
        }
    }

    lookups.set(tag, { remove, time: Date.now() });
    return remove;
}

const ratios: PostHandler = {
    name:  "ratios",
    check: post => candidates(post).length !== 0,
    async run(post) {
        const tags: Array<string> = [];
        for (const tag of candidates(post)) {
            if (await shouldRemove(tag)) {
                tags.push(tag);
            }
        }

        for (const tag of await removeTagsOnce(post.id, tags)) {
            logger.info(`[ratios] Removed ${tag} from https://e621.net/posts/${post.id}`);
        }
    }
};
export default ratios;
