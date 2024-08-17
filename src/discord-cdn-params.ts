import { e621 } from "./clients.js";
import { getExport } from "./exports.js";
import RequestQueue from "./queue.js";
import { isDirectRun } from "./util.js";

let i = 0;
export default async function runDiscordCDNParams() {
    const d = Date.now();
    await getExport("posts", async record => {
        if (++i % 25000 === 0) {
            console.log(i);
        }

        if (record.change_seq < 59_000_000) {
            return;
        }

        let changes = false;
        for (const source of record.sources) {
            if (source.startsWith("https://media.discordapp.net")) {
                changes = true;
                break;
            }
            if (source.startsWith("https://cdn.discordapp.com")) {
                if (!source.includes("?")) {
                    changes = true;
                    break;
                }

                try {
                    const url = new URL(source);
                    const expire = parseInt(url.searchParams.get("ex")!, 16) * 1000;
                    if (!isNaN(expire) && expire < d) {
                        changes = true;
                        break;
                    }
                } catch {}
            }
        }

        if (!changes) {
            return;
        }

        const post = (await RequestQueue.add(async() => e621.posts.get(record.id)))!;
        const sources = Array.from(post.sources);
        const expiryParams = new Set(["ex", "hm", "is"]);
        const onlyExpiryParams = (params: URLSearchParams) => Array.from(params.keys()).every(p => expiryParams.has(p));

        for (let source of post.sources) {
            let params = new URLSearchParams();
            try {
                params = new URL(source).searchParams;
            } catch {
                // ignore
            }
            // ex, hm, is
            if (source.startsWith("https://media.discordapp.net") && onlyExpiryParams(params)) {
                const original = source;
                source = source.replace("https://media.discordapp.net", "https://cdn.discordapp.com");
                sources.splice(sources.indexOf(original), 1, source);
            }
            if (source.startsWith("https://cdn.discordapp.com") || source.startsWith("https://media.discordapp.net")) {
                if (!source.includes("?")) {
                    sources.splice(sources.indexOf(source), 1, `-${source}`);
                    continue;
                }

                try {
                    const expire = parseInt(params.get("ex")!, 16);
                    if (isNaN(expire) || expire < d) {
                        let query = "";
                        if (!onlyExpiryParams(params)) {
                            for (const param of Array.from(params.keys())) {
                                if (expiryParams.has(param)) {
                                    continue;
                                }

                                query += `&${param}=${params.get(param)!}`;
                            }
                        }

                        if (query.length !== 0) {
                            query = `?${query.slice(1)}`;
                        }

                        sources.splice(sources.indexOf(source), 1, `-${source.split("?")[0]}${query}`);
                    }
                } catch {}
            }
        }

        if (JSON.stringify(sources) !== JSON.stringify(post.sources)) {
            await RequestQueue.add(async() => {
                const add: Array<string> = [], remove: Array<string> = [];
                for (const source of sources) {
                    if (!post.sources.includes(source)) {
                        add.push(source);
                    }
                }
                for (const source of post.sources) {
                    if (!sources.includes(source)) {
                        remove.push(source);
                    }
                }
                console.log(`https://e621.net/posts/${post.id}`, "Add:", add, "Remove:", remove);
                await post.modify({
                    source: sources.join("\n")
                });
            });
        }
    });
}

if (isDirectRun(import.meta.url)) {
    await runDiscordCDNParams();
}
