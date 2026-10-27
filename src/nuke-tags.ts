import ExportsClient from "./exports.js";
import Progress from "./progress.js";
import { safeRemoveTags } from "./safeTagRemoval.js";
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
    const progress = await Progress.load("nuke-tags", tags);
    if (progress.finished) {
        return;
    }

    for await (const [record] of ExportsClient.getDeferredReader("posts")) {
        if (++i % 25000 === 0) {
            console.log(i);
        }

        if (progress.shouldSkip(record.id)) {
            continue;
        }

        const includedTags = tags.filter(tag => record.tags.includes(tag));
        if (includedTags.length !== 0) {
            if (await safeRemoveTags(record.id, includedTags)) {
                for (const tag of includedTags) {
                    console.log("Removed %s from %d", tag, record.id);
                }
            }
        }

        await progress.update(record.id, includedTags.length !== 0);
    }

    await progress.finish();
}

if (isDirectRun(import.meta.url)) {
    await runNuke();
}
