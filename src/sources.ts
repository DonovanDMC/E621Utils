/// <reference lib="dom" />
import { e621 } from "./clients";
import { getExport } from "./exports";
import { DAY, exists } from "./util";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { readFile, rm, writeFile } from "node:fs/promises";

const remove = Symbol.for("e621.twitter.remove");
const sourceReplacements = [
    {
        regex: /^https?:\/\/pbs\.twimg\.com\/media\/(?<id>.+)\.(?<format>.+):(?<name>.+)$/,
        async fix(this: void, r: RegExpExecArray) {
            return `https://pbs.twimg.com/media/${r.groups!.id}?format=${r.groups!.format}&name=${r.groups!.name}`;
        }
    },
    {
        regex: /^https?:\/\/pbs\.twimg\.com\/media\/(?<id>.+)\.(?<format>.+)\?name=(?<name>.+)$/,
        async fix(this: void, r: RegExpExecArray) {
            return `https://pbs.twimg.com/media/${r.groups!.id}?format=${r.groups!.format}&name=${r.groups!.name}`;
        }
    },
    {
        regex: /^https?:\/\/pbs\.twimg\.com\/media\/(?<id>.+)\.(?<format>.+)$/,
        async fix(this: void, r: RegExpExecArray) {
            return `https://pbs.twimg.com/media/${r.groups!.id}?format=${r.groups!.format}&name=orig`;
        }
    },
    {
        regex: /^https?:\/\/pic\.(twitter|x)\.com\/(?<id>.+)$/,
        async fix(this: void, r: RegExpExecArray) {
            const getURL = await fetch(`https://pic.twitter.com/${r.groups!.id}`, {
                headers: {
                    "User-Agent": e621.options.userAgent
                },
                redirect: "manual",
                method:   "HEAD"
            });
            if (getURL.status === 404) {
                return remove;
            } else {
                const newURL = getURL.headers.get("location")?.replace(/\/photo\/\d+/, "");
                if (!newURL) {
                    return null;
                }

                return newURL;
            }
        }
    },
    {
        regex: /^https?:\/\/mobile\.(twitter|x)\.com(?<path>.+)$/,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com/${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/fxtwitter\.com(?<path>.+)$/,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com/${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/vxtwitter\.com(?<path>.+)$/,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com/${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/(twitter|x)\.com\/(?<handle>.+)\/(?<tweet>\d+)\/photo\/\d+$/,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com/${r.groups!.handle}/${r.groups!.tweet}`;
        }
    },
    {
        regex: /^blob:.*$/,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        async fix(this: void, _r: RegExpExecArray) {
            return remove;
        }
    }
];

async function writeLastPost(id: number) {
    const date = new Date();
    const d = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${(date.getDate()).toString().padStart(2, "0")}`;
    await writeFile(`${tmpdir()}/posts-${d}.last`, String(id));
}

async function readLastPost() {
    const date = new Date();
    const d = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${(date.getDate()).toString().padStart(2, "0")}`;
    const prevDate = new Date(date.getTime() - DAY);
    const pd = `${prevDate.getFullYear()}-${(prevDate.getMonth() + 1).toString().padStart(2, "0")}-${(prevDate.getDate()).toString().padStart(2, "0")}`;
    if (await exists(`${tmpdir()}/posts-${d}.last`)) {
        return Number(await readFile(`${tmpdir()}/posts-${d}.last`, "utf8"));
    }

    if (await exists(`${tmpdir()}/posts-${pd}.last`)) {
        await rm(`${tmpdir()}/posts-${pd}.last`);
    }

    return null;
}

export default async function runSources() {
    const lastPost = await readLastPost();

    let i = 0, lastRequest = 0;
    await getExport("posts", async(record, total) => {
        if (lastPost && lastPost >= record.id) {
            i++;
            if ((i % 10000) === 0) {
                console.log(`Skipping.. ${i}/${lastPost}`);
            }
            return;
        }

        const addSources: Array<string> = [], removeSources: Array<string> = [];
        sources: for (let source of record.sources.split("\n")) {
            const og = source;
            replace: for (const rp of sourceReplacements) {
                let matches: RegExpExecArray | null;
                if ((matches = rp.regex.exec(source))) {
                    const fixed = await rp.fix(matches);
                    if (fixed === null) {
                        continue replace;
                    }

                    if (typeof fixed === "symbol") {
                        if (fixed === remove) {
                            removeSources.push(source);
                            continue sources;
                        }
                        throw new Error(`unknown symbol: ${Symbol.keyFor(fixed)}`);
                    }

                    source = fixed;
                }
            }

            if (og !== source) {
                addSources.push(source);
                removeSources.push(og);
            }
        }

        const finalSources = record.sources.split("\n").filter(s => !removeSources.includes(s)).concat(...addSources);

        // remove duplicate twitter handle & tweet sources
        const TWITTER_HANDLE_REGEX = /^https?:\/\/(twitter|x)\.com\/(?<handle>[^/]+)$/;
        const TWITTER_TWEET_REGEX = /^https?:\/\/(twitter|x)\.com\/(?<handle>[^/]+)\/status\/(?<tweet>\d+)(?:.+)?$/;
        const loopSources = (sources: Array<string>) => {
            const handles: Array<[handle: string, source: string]> = [];
            outer: for (const source of Array.from(sources)) {
                let match: RegExpMatchArray | null;
                if ((match = TWITTER_HANDLE_REGEX.exec(source))) {
                    handles.push([source, match.groups!.handle]);
                    continue;
                }

                if (handles.length !== 0 && (match = TWITTER_TWEET_REGEX.exec(source))) {
                    for (const sh of handles) {
                        if (match.groups!.handle === sh[1]) {
                            removeSources.push(sh[0]);
                            finalSources.splice(finalSources.indexOf(sh[0]), 1);
                            handles.splice(handles.indexOf(sh), 1);
                            continue outer;
                        }
                    }
                }
            }
        };

        loopSources(finalSources);
        loopSources(finalSources.reverse());

        i++;

        if ((i % 10000) === 0) {
            await writeLastPost(record.id);
        }

        if (addSources.length === 0 && removeSources.length === 0) {
            return;
        }

        const edit = async(): Promise<void> => {
            let diff: number;
            if (lastRequest !== 0 && (diff = Date.now() - lastRequest) < 700) {
                await setTimeout(diff);
            }
            lastRequest = Date.now();

            await e621.posts.modify(record.id, {
                add_sources:    addSources,
                remove_sources: removeSources
            })
                .catch(async() => {
                    await setTimeout(1000);
                    await edit();
                });
        };

        await edit();

        console.log("Add:", addSources);
        console.log("Remove:", removeSources);
        console.log(`https://e621.net/posts/${record.id}`);
        console.log("%d/%d", i, total);
    });

}
