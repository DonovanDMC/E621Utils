import config from "./config.json" assert { type: "json" };
import tags from "./tags.json" assert { type: "json" };
import type { Post, PostHistory } from "e621";
import E621 from "e621";
import chunk from "chunk";
import { StatusServer } from "@uwu-codes/utils";
import {
    ApplicationCommandTypes,
    Client,
    CommandInteraction,
    type EmbedOptions,
    MessageFlags
} from "oceanic.js";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import type { PathLike } from "node:fs";

const statusServer = StatusServer(() => clients.every(c => c.ready));

process
    .once("SIGINT", () => {
        statusServer.close();
        clearInterval(interval);
        for (const c of clients) {
            c.disconnect(false);
        }
        process.kill(process.pid, "SIGINT");
    })
    .once("SIGTERM", () => {
        statusServer.close();
        process.kill(process.pid, "SIGTERM");
    });

const isDocker = process.env.DOCKER === "1";
const e621 = new E621({
    authUser: config.authUser,
    authKey:  config.authKey
});

const exists = (path: PathLike) => access(path).then(() => true, () => false);
const dir = isDocker ? "/mnt/data" : new URL("data/", import.meta.url).pathname;
if (!await exists(dir)) {
    await mkdir(dir);
}
const cache: Record<string, { rating: string; tags: Array<string>; }> = {};
if (await exists(`${dir}/cache.json`)) {
    const c = JSON.parse((await readFile(`${dir}/cache.json`)).toString()) as typeof cache;
    for (const [k, v] of Object.entries(c)) {
        cache[k] = v;
    }
}
const clients: Array<Client> = [];
let lastClientIndex = -1;
for (const token of config.tokens) {
    const client = new Client({
        auth:    `Bot ${token}`,
        gateway: {
            intents: 0
        },
        disableCache: "no-warning"
    });
    client.on("debug", info => console.debug("[Oceanic Debug | #%d]:", clients.indexOf(client) + 1, info));
    client.on("interactionCreate", async interaction => {
        if (interaction instanceof CommandInteraction) {
            await interaction.defer(MessageFlags.EPHEMERAL);
            switch (interaction.data.name) {
                case "run-checks": {
                    void run();
                    return interaction.createFollowup({
                        flags:   MessageFlags.EPHEMERAL,
                        content: "Running."
                    });
                }

                case "dump-cache": {
                    if (Object.keys(cache).length === 0) {
                        return interaction.createFollowup({
                            flags:   MessageFlags.EPHEMERAL,
                            content: "There are currently 0 cached posts."
                        });
                    }

                    const embeds: Array<EmbedOptions> = [];
                    for (const [k, v] of Object.entries(cache)) {
                        const post = await e621.posts.get(Number(k));
                        embeds.push(makeEmbed(k, v.rating, v.tags, post));
                    }

                    const eb = chunk(embeds, 10);
                    const initial = eb.shift()!;
                    await interaction.createFollowup({
                        flags:   MessageFlags.EPHEMERAL,
                        content: `There are currently ${Object.keys(cache).length} cached posts.`,
                        embeds:  initial
                    });
                    for (const e of eb.values()) {
                        await interaction.createFollowup({
                            embeds: e,
                            flags:  MessageFlags.EPHEMERAL
                        });
                    }
                }
            }
        }
    });
    client.on("ready", async() => {
        await client.restMode();
        console.debug("[Oceanic | #%d]: Ready as %s#%s", clients.indexOf(client) + 1, client.user.username, client.user.discriminator);
        if (clients.indexOf(client) !== 0) {
            return;
        }
        await client.application.bulkEditGuildCommands(config.guild, [
            { type: ApplicationCommandTypes.CHAT_INPUT, name: "run-checks", description: "Force run the checks now." },
            { type: ApplicationCommandTypes.CHAT_INPUT, name: "dump-cache", description: "List the currently cached posts." }
        ]);
    });
    clients.push(client);
    void client.connect();
}

let ratelimited = 0;
async function editChannel() {
    if (ratelimited >= clients.length) {
        console.error("Failed to edit channel, all clients are ratelimited.");
        return;
    }
    lastClientIndex++;
    if (lastClientIndex > clients.length - 1) {
        lastClientIndex = 0;
    }
    const client = clients[lastClientIndex];
    const d = Math.floor(Date.now() / 1000);
    await client.rest.channels.edit(config.channel, { topic: `Last Checked: <t:${d}:R>` })
        .then(() => ratelimited = 0)
        .catch(() => {
            ratelimited++;
            return editChannel();
        });
}

async function sendDiscord(embeds: Array<EmbedOptions>): Promise<void> {
    const eb = chunk(embeds, 10);
    if (eb.length > 1) {
        await Promise.all(eb.map(sendDiscord));
        return;
    }

    await clients[0].rest.webhooks.execute(config.webhook.id, config.webhook.token, {
        embeds
    });
}

function makeEmbed(id: string, rating: string, tagSet: Array<string>, post: Post | null) {
    return post === null ? {
        title:     `Post Destroyed: #${id}`,
        timestamp: new Date().toISOString()
    } : {
        title:       `Post Removed: #${id}`,
        description: `Rating: **${post.rating === "s" ? "Safe" : (post.rating === "q" ? "Questionable" : "Explicit")}** (Old: **${rating === "s" ? "Safe" : (rating === "q" ? "Questionable" : "Explicit")}**)\n\nFound For:\n${tagSet.map(tag => `- \`${tag}\``).join("\n")}`,
        timestamp:   new Date().toISOString(),
        url:         `https://e621.net/posts/${id}`,
        color:       0xDC143C,
        image:       ["webm", "swf"].includes(post.file.ext) ? undefined : {
            url: post.file.url
        }
    };
}

let running = false;
async function run() {
    if (running) {
        return;
    }
    running = true;
    const found: Array<[post: Post, tagIndex: number]> = [];
    const allPosts: Array<number> = [];
    const prev = new Set(Object.keys(cache).map(Number));
    const stillPresent: Array<number> = [];
    const addedPosts: Array<number> = [];
    const groupedByPost: Record<number, { post: Post; tags: Array<string>; }> = {};
    let removed = 0, added = 0;
    for (const tag of tags) {
        console.debug("Checking \"%s\"...", tag);
        const posts = await e621.posts.search({ tags: tag });
        await new Promise(resolve => setTimeout(resolve, 500));
        if (posts.length === 0) {
            console.log("No posts found for \"%s\".", tag);
        } else {
            console.log("Found %d posts for \"%s\".", posts.length, tag);
            for (const post of posts) {
                if (prev.has(post.id)) {
                    stillPresent.push(post.id);
                    console.debug("Skipping post %d.", post.id);
                    continue;
                } else {
                    if (!addedPosts.includes(post.id)) {
                        addedPosts.push(post.id);
                        added++;
                    }
                }
                if (!allPosts.includes(post.id)) {
                    allPosts.push(post.id);
                }
                const tagIndex = tags.indexOf(tag);
                const a = tag.split(" ").map(t => t. replace(/-?set:.*/g, "").replace(/-?rating:[eqs]/g, "")).filter(Boolean).slice(1);
                const h: Array<PostHistory> = [];
                for (const t of a) {
                    try {
                        h.push(...(await e621.posts.searchHistory({
                            post:       post.id,
                            added_tags: t
                        })));
                    } catch {
                        console.log("Failed to get history for post %d with tag \"%s\".", post.id, t);
                    }
                }
                groupedByPost[post.id] = {
                    post,
                    tags: [
                        ...(groupedByPost[post.id]?.tags ?? []),
                        tag
                    ]
                };
                found.push([post, tagIndex]);
                cache[post.id] = {
                    tags:   [...(cache[post.id]?.tags || []), tag],
                    rating: post.rating
                };
            }
        }
    }

    for (const [id, { tags: tagSet, rating }] of Object.entries(cache)) {
        if (!stillPresent.includes(Number(id)) && !addedPosts.includes(Number(id))) {
            const post = await e621.posts.get(id);
            removed++;
            delete cache[id];
            await sendDiscord([makeEmbed(id, rating, tagSet, post)]);
        }
    }

    await writeFile(`${dir}/cache.json`, JSON.stringify(cache));

    for (const [id, { post, tags: tagSet }] of Object.entries(groupedByPost)) {
        await sendDiscord([
            {
                title:       `Post Added: #${id}`,
                description: `Rating: **${post.rating === "s" ? "Safe" : (post.rating === "q" ? "Questionable" : "Explicit")}**\n\nFound For:\n${tagSet.map(tag => `- \`${tag}\``).join("\n")}`,
                timestamp:   new Date().toISOString(),
                url:         `https://e621.net/posts/${id}`,
                color:       0x008000,
                image:       ["webm", "swf"].includes(post.file.ext) ? undefined : {
                    url: post.file.url
                }
            }
        ]);
    }

    if (added !== 0 || removed !== 0) {
        await sendDiscord([
            {
                title:       "Checks Completed",
                color:       0xFFD700,
                timestamp:   new Date().toISOString(),
                description: `There ${added === 1 ? "was" : "were"} **${added}** addition${added === 1 ? "" : "s"} and **${removed}** removal${removed === 1 ? "" : "s"} this time around.`,
                footer:      {
                    text: `Total Cached Posts: ${Object.keys(cache).length}`
                }
            }
        ]);
    }

    await editChannel();
    running = false;
}

const interval = setInterval(() => {
    const d = new Date();
    if ((d.getMinutes() % 5) === 0 && d.getSeconds() === 0) {
        void run();
    }
}, 1e3);
