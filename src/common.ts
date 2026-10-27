import { DefaultParsers } from "e621-export-downloader";
import ExportsClient from "./exports.js";
import Progress from "./progress.js";
import { safeRemoveTags } from "./safeTagRemoval.js";
import { isDirectRun } from "./util.js";

const tagRemovals = [
    {
        search: "type:gif no_sound",
        remove: ["no_sound"]
    },
    {
        search: "animated_png no_sound",
        remove: ["no_sound"]
    },
    {
        search: "no_climax",
        remove: ["no_climax"]
    }
];

function recordMatches(data: DefaultParsers.PostData, tags: string | Array<string>) {
    if (!Array.isArray(tags)) {
        tags = tags.split(" ");
    }

    loop: for (const str of tags) {
        if (str.includes(":")) {
            const [meta, tag] = str.split(":");

            switch (meta) {
                case "type": {
                    if (data.file_ext !== tag) {
                        return false;
                    }

                    continue loop;
                }

                case "rating": {
                    if (data.rating !== tag) {
                        return false;
                    }

                    continue loop;
                }
            }
        }

        if (!data.tags.includes(str)) {
            return false;
        }
    }

    return true;
}

async function doWithRetry(func: () => Promise<void>): Promise<void> {
    await func()
        .catch(() => doWithRetry(func));
}

export default async function runCommon() {
    const progress = await Progress.load("common", tagRemovals);
    if (progress.finished) {
        return;
    }

    let i = 0;
    for await (const [record, total] of ExportsClient.getDeferredReader("posts")) {
        if ((++i % 100_000) === 0) {
            console.log("%d/%d", i, total);
        }

        if (progress.shouldSkip(record.id)) {
            continue;
        }

        const remove: Array<string> = [];
        for (const config of tagRemovals) {
            if (recordMatches(record, config.search)) {
                remove.push(...config.remove);
                if (record.tags.includes("invalid_tag") && !remove.includes("invalid_tag")) {
                    remove.push("invalid_tag");
                }
            }
        }

        if (remove.length !== 0) {
            await doWithRetry(async() => {
                if (await safeRemoveTags(record.id, remove)) {
                    console.log(`Removed "${remove.join(" ")}" from ${record.id}`);
                }
            });
        }

        await progress.update(record.id, remove.length !== 0);
    }

    await progress.finish();
}

if (isDirectRun(import.meta.url)) {
    await runCommon();
}
