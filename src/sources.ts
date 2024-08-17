/// <reference lib="dom" />
import { e621 } from "./clients.js";
import { getExport } from "./exports.js";
import { DAY, isDirectRun, exists, dataDir } from "./util.js";
import RequestQueue from "./queue.js";
import { readFile, rm, writeFile } from "node:fs/promises";

const remove = Symbol.for("e621.twitter.remove");
const sourceReplacements = [
    {
        regex: /^https?:\/\/pbs\.twimg\.com\/media\/(?<id>[\w-]+)\.(?<format>[a-z]+):(?<name>[a-z]+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://pbs.twimg.com/media/${r.groups!.id}?format=${r.groups!.format}&name=${r.groups!.name}`;
        }
    },
    {
        regex: /^https?:\/\/pbs\.twimg\.com\/media\/(?<id>[\w-]+)\.(?<format>[a-z]+)\?name=(?<name>[a-z]+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://pbs.twimg.com/media/${r.groups!.id}?format=${r.groups!.format}&name=${r.groups!.name}`;
        }
    },
    {
        regex: /^https?:\/\/pbs\.twimg\.com\/media\/(?<id>[\w-]+)\.(?<format>[a-z]+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://pbs.twimg.com/media/${r.groups!.id}?format=${r.groups!.format}&name=orig`;
        }
    },
    {
        regex: /^https?:\/\/pic\.(twitter|x)\.com\/(?<id>[\w-]+)$/i,
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
        regex: /^https?:\/\/t.co\/(?<id>[\w-]+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            const getURL = await fetch(`https://t.co/${r.groups!.id}`, {
                headers: {
                    "User-Agent": e621.options.userAgent
                },
                redirect: "manual",
                method:   "HEAD"
            });
            if (getURL.status === 404) {
                return remove;
            } else {
                const newURL = getURL.headers.get("location");
                if (!newURL) {
                    return null;
                }

                return newURL;
            }
        }
    },
    {
        regex: /^https?:\/\/mobile\.(twitter|x)\.com(?<path>\S+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/(?:.*\.)?[fv]xtwitter\.com(?<path>\S+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/(?:.*\.)?fixupx\.com(?<path>\S+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/fxfuraffinity\.net(?<path>\S+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://furaffinity.net${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/(twitter|x)\.com\/(?<handle>\w{1,15})\/status\/(?<tweet>\d+)\/photo\/\d+(?<path>\S*)/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com/${r.groups!.handle}/status/${r.groups!.tweet}${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/(twitter|x)\.com(?<path>.+)\?.*$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com${r.groups!.path.split("?")[0]}`;
        }
    },
    {
        regex: /^https?:\/\/x\.com(?<path>.+)$/i,
        async fix(this: void, r: RegExpExecArray) {
            return `https://twitter.com${r.groups!.path.split("?")[0]}`;
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
    await writeFile(`${dataDir}/posts-${d}.last`, String(id));
}

async function readLastPost() {
    const date = new Date();
    const d = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${(date.getDate()).toString().padStart(2, "0")}`;
    const prevDate = new Date(date.getTime() - DAY);
    const pd = `${prevDate.getFullYear()}-${(prevDate.getMonth() + 1).toString().padStart(2, "0")}-${(prevDate.getDate()).toString().padStart(2, "0")}`;
    if (await exists(`${dataDir}/posts-${d}.last`)) {
        return Number(await readFile(`${dataDir}/posts-${d}.last`, "utf8"));
    }

    if (await exists(`${dataDir}/posts-${pd}.last`)) {
        await rm(`${dataDir}/posts-${pd}.last`);
    }

    return null;
}

export default async function runSources() {
    const lastPost = await readLastPost();

    let i = 0, maxChangeSeq = 0;
    const changes: Array<{ add: Array<string>; id: number; remove: Array<string>; }> = [];

    if (await exists(`${dataDir}/changes.json`)) {
        changes.unshift(...JSON.parse(await readFile(`${dataDir}/changes.json`, "utf8")) as typeof changes);
    }

    await getExport("posts", async(record, total) => {
        i++;
        if (lastPost && lastPost >= record.id) {
            if ((i % 25000) === 0) {
                console.log(`Skipping.. ${record.id}/${lastPost}`);
            }
            return;
        }

        if (record.change_seq > maxChangeSeq) {
            maxChangeSeq = record.change_seq;
        }

        if ((i % 10000) === 0) {
            await writeLastPost(record.id);
        }

        const anyMatch = record.sources.some(s => sourceReplacements.some(sp => sp.regex.test(s)));

        if (!anyMatch) {
            return;
        }

        const post = await RequestQueue.add(async() => e621.posts.get(record.id));
        const sources = post?.sources;

        if (!sources) {
            console.log("Failed to get sources for post:", record.id);
            return;
        }

        const addSources: Array<string> = [], removeSources: Array<string> = [];
        sources: for (let source of sources) {
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

        const finalSources = sources.filter(s => !removeSources.includes(s)).concat(...addSources);

        // remove duplicate twitter handle & tweet sources
        const TWITTER_HANDLE_REGEX = /^https?:\/\/(twitter|x)\.com\/(?<handle>[^/]+)$/;
        const TWITTER_TWEET_REGEX = /^https?:\/\/(twitter|x)\.com\/(?<handle>[^/]+)\/status\/(?<tweet>\d+)(?:.+)?$/;
        const loopSources = (lpsources: Array<string>) => {
            const handles: Array<[handle: string, source: string]> = [];
            outer: for (const source of Array.from(lpsources)) {
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

        if (addSources.length === 0 && removeSources.length === 0) {
            return;
        }

        const edit = async(): Promise<void> => {
            await RequestQueue.add(async() => {
                await e621.posts.modify(record.id, {
                    add_sources:    addSources,
                    remove_sources: removeSources
                }).then(() => changes.push({ add: addSources,  id: record.id, remove: removeSources }));
            });
        };

        await edit();

        console.log("Add:", addSources);
        console.log("Remove:", removeSources);
        console.log(`https://e621.net/posts/${record.id}`);
        console.log("%d/%d", record.id, total);

        if (i % 10000 === 0) {
            await writeFile(`${dataDir}/changes.json`, JSON.stringify(changes));
        }
    });

    await writeFile(`${dataDir}/changes.json`, JSON.stringify(changes));
    await writeFile(`${dataDir}/sources.seq`, String(maxChangeSeq));
}

if (isDirectRun(import.meta.url)) {
    await runSources();
}
