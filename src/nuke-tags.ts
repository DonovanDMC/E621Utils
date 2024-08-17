import { e621 } from "./clients.js";
import { getExport } from "./exports.js";
import RequestQueue from "./queue.js";
import { isDirectRun } from "./util.js";

const tags = [
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
];

let i = 0;
export default async function runNuke() {
    await getExport("posts", async record => {
        if (++i % 25000 === 0) {
            console.log(i);
        }

        const includedTags = tags.filter(tag => record.tags.includes(tag));
        if (includedTags.length !== 0) {
            for (const tag of includedTags) {
                console.log("Removed %s from %d", tag, record.id);
            }

            await RequestQueue.add(async() => {
                await e621.posts.modify(record.id, { remove_tags: includedTags });
            });
        }
    });
}

if (isDirectRun(import.meta.url)) {
    await runNuke();
}
