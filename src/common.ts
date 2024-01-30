import { e621 } from "./clients.js";
import { getExport } from "./exports.js";
import type { PostData } from "./parsers/posts.js";
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

function recordMatches(data: PostData, tags: string | Array<string>) {
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
    let i = 0;
    await getExport("posts", async (record, total) => {
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
            console.log(`Removing "${remove.join(" ")}" from ${record.id}`);
            await doWithRetry(async() => {
                await e621.posts.modify(record.id, { remove_tags: remove });
            });
        }

        if ((++i % 100_000) === 0) {
            console.log("%d/%d", i, total);
        }
    });
}

if (isDirectRun(import.meta.url)) {
    await runCommon();
}
