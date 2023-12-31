import { e621, discord } from "./clients.js";
import { type CacheEntry, readCache, writeCache } from "./cache.js";
import tagConfig from "../tags.json" assert { type: "json" };
import config from "../config.json" assert { type: "json" };
import {
    type EmbedOptions,
    MessageFlags,
    ComponentTypes,
    ButtonStyles,
    ComponentInteraction,
    type MessageActionRow,
    type CreateMessageOptions,
    type EditMessageOptions
} from "oceanic.js";
import chunk from "chunk";
import { type Post } from "e621";

discord().on("interactionCreate", async interaction => {
    if (interaction instanceof ComponentInteraction) {
        await interaction.defer(MessageFlags.EPHEMERAL);
        const [command, ...args] = interaction.data.customID.split(":");
        switch (command) {
            case "run-checks": {
                void run();
                return interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: "Running."
                });
            }

            case "list-cache": {
                const cache = await readCache();
                if (cache.posts.length === 0) {
                    return interaction.createFollowup({
                        flags:   MessageFlags.EPHEMERAL,
                        content: "There are currently 0 cached posts."
                    });
                }

                const embeds: Array<EmbedOptions> = [];
                const posts = await e621.posts.search({ tags: `id:${cache.posts.map(c => c.post).join(",")}` });
                for (const entry of cache.posts) {
                    embeds.push(makeEmbed(entry, posts.find(p => p.id === entry.post) ?? null, null));
                }

                const eb = chunk(embeds, 10);
                const initial = eb.shift()!;
                await interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: `There are currently ${cache.posts.length} cached posts.`,
                    embeds:  initial
                });
                for (const e of eb.values()) {
                    await interaction.createFollowup({
                        embeds: e,
                        flags:  MessageFlags.EPHEMERAL
                    });
                }
                break;
            }

            case "clear-cache": {
                const cache = await readCache();
                cache.posts = [];
                await writeCache(cache);
                await interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: "Cache cleared."
                });
                break;
            }

            case "remove-post": {
                const cache = await readCache();
                const index = cache.posts.findIndex(c => c.post === Number(args[0]));
                if (index === -1) {
                    return interaction.createFollowup({
                        flags:   MessageFlags.EPHEMERAL,
                        content: "That post is not cached."
                    });
                }
                cache.posts.splice(index, 1);
                await writeCache(cache);
                await interaction.message.delete();
                await interaction.createFollowup({
                    flags:   MessageFlags.EPHEMERAL,
                    content: "Post removed."
                });
                break;
            }
        }
    }
});

const GREEN = 0x008000, YELLOW = 0xFFD700, RED = 0xDC143C;
async function getMessageContent(added: number, removed: number): Promise<CreateMessageOptions | EditMessageOptions> {
    const cache = await readCache();
    return {
        embeds: [
            {
                title:       "Status",
                description: `Checks were last ran <t:${Math.floor(Date.now() / 1000)}:R>\nThe last run added **${added}** post${added === 1 ? "" : "s"} and removed **${removed}** post${removed === 1 ? "" : "s"}.`,
                footer:      {
                    text: `Total Cached Posts: ${cache.posts.length}`
                },
                color:     cache.posts.length === 0 ? GREEN : (cache.posts.length <= 5 ? YELLOW : RED),
                timestamp: new Date().toISOString()
            }
        ],
        components: [
            {
                type:       ComponentTypes.ACTION_ROW,
                components: [
                    {
                        type:     ComponentTypes.BUTTON,
                        style:    ButtonStyles.PRIMARY,
                        label:    "Run Checks",
                        customID: "run-checks"
                    },
                    {
                        type:     ComponentTypes.BUTTON,
                        style:    ButtonStyles.SUCCESS,
                        label:    "List Cache",
                        customID: "list-cache"
                    },
                    {
                        type:     ComponentTypes.BUTTON,
                        style:    ButtonStyles.DANGER,
                        label:    "Clear Cache",
                        customID: "clear-cache"
                    }
                ]
            }
        ]
    };
}
async function updateMessage(added: number, removed: number, recreate: boolean) {
    const cache = await readCache();
    const oldCache = JSON.stringify(cache);
    const content = await getMessageContent(added, removed);
    if (cache.message !== null) {
        await discord().rest.channels.editMessage(config.tagsChannel, cache.message, content)
            .catch(async () => (recreate = true));
    }
    if (recreate || cache.message === null) {
        if (cache.message !== null) {
            await discord().rest.channels.deleteMessage(config.tagsChannel, cache.message);
        }
        cache.message = (await discord().rest.channels.createMessage(config.tagsChannel, content)).id;
    }
    if (oldCache !== JSON.stringify(cache)) {
        await writeCache(cache);
    }
}

function makeEmbed(entry: CacheEntry, post: Post | null, op: "add" | "remove" | null) {
    const color = op === "add" ? GREEN : (op === "remove" ? RED : YELLOW);
    if (post === null) {
        return {
            title:     `Post Destroyed: #${entry.post}`,
            timestamp: new Date().toISOString(),
            color
        };
    }
    return {
        title:       op === "add" ? `Post Added: #${entry.post}` : (op === "remove" ? `Post Removed: #${entry.post}` : `Post #${entry.post}`),
        description: `Rating: **${post.rating === "s" ? "Safe" : (post.rating === "q" ? "Questionable" : "Explicit")}**${op === "remove" ? ` (Old: **${entry.rating === "s" ? "Safe" : (entry.rating === "q" ? "Questionable" : "Explicit")}**)` : ""}\n\nFound For:\n${entry.tags.map(tag => `- \`${tag}\``).join("\n")}`,
        timestamp:   new Date().toISOString(),
        url:         `https://e621.net/posts/${entry.post}`,
        color,
        image:       ["webm", "swf"].includes(post.file.ext) ? undefined : {
            url: post.file.url
        }
    };
}

function getComponents(cache: CacheEntry, post: Post, op: "add" | "remove" | null): Array<MessageActionRow> {
    const base: Array<MessageActionRow> = [
        {
            type:       ComponentTypes.ACTION_ROW,
            components: [
                {
                    type:  ComponentTypes.BUTTON,
                    style: ButtonStyles.LINK,
                    label: "View Post",
                    url:   `https://e621.net/posts/${post.id}`
                }
            ]
        }
    ];

    switch (op) {
        case "remove": return base;
        case null:
        case "add": {
            base[0].components.push({
                type:     ComponentTypes.BUTTON,
                style:    ButtonStyles.DANGER,
                label:    "Remove Post",
                customID: `remove-post:${cache.post}`
            });
            return base;
        }
    }
}

async function sendDiscord(entry: CacheEntry, post: Post, op: "add" | "remove" | null) {
    const embed = makeEmbed(entry, post, op);
    await discord().rest.channels.createMessage(config.tagsChannel, {
        embeds:     [embed],
        components: getComponents(entry, post, op)
    });
}

let running = false;
export default async function run() {
    if (running) {
        return;
    }
    running = true;

    const added: Array<CacheEntry> = [], removed: Array<CacheEntry> = [];
    const cache = await readCache();
    const newCache = [] as Array<CacheEntry>;
    const allPosts: Array<Post> = [];
    for (const { base, groups } of tagConfig) {
        let tags = "";
        if (groups !== null) {
            for (const tag of groups) {
                tags += `~${tag} `;
            }
        }
        tags += base;
        console.log("Checking %s...", groups === null ? `"${base}"` : groups.map(g => `"${g} ${base}"`).join(", "));

        const posts = await e621.posts.search({ tags });
        allPosts.push(...posts);
        if (posts.length === 0) {
            console.log("No posts found.");
        } else {
            console.log("Found %d posts.", posts.length);
            for (const post of posts) {
                const alreadyFound = newCache.findIndex(c => c.post === post.id);
                const foundFor: Array<string> = [];
                if (groups === null) {
                    foundFor.push(base);
                } else {
                    const allTags = new Set([
                        ...post.tags.artist,
                        ...post.tags.character,
                        ...post.tags.copyright,
                        ...post.tags.general,
                        ...post.tags.invalid,
                        ...post.tags.lore,
                        ...post.tags.meta,
                        ...post.tags.species
                    ]);
                    for (const tag of groups) {
                        if (allTags.has(tag)) {
                            foundFor.push(`${tag} ${base}`);
                        }
                    }
                }

                if (alreadyFound === -1) {
                    newCache.push({
                        post:   post.id,
                        rating: post.rating,
                        tags:   foundFor,
                        since:  new Date().toISOString()
                    });
                } else {
                    newCache[alreadyFound].tags = [...newCache[alreadyFound].tags, ...foundFor];
                }
            }
        }
    }

    for (const entry of cache.posts) {
        if (newCache.findIndex(c => c.post === entry.post) === -1) {
            removed.push(entry);
        }
    }

    for (const entry of newCache) {
        if (cache.posts.findIndex(c => c.post === entry.post) === -1) {
            added.push(entry);
        }
    }

    cache.posts = newCache;
    await writeCache(cache);
    if (added.length === 0 && removed.length === 0) {
        await updateMessage(added.length, removed.length, false);
        running = false;
        return;
    }

    for (const entry of added) {
        const post = allPosts.find(p => p.id === entry.post)!;
        await sendDiscord(entry, post, "add");
    }

    if (removed.length !== 0) {
        const posts = await e621.posts.search({ tags: `id:${removed.map(c => c.post).join(",")}` });
        allPosts.push(...posts);
    }

    for (const entry of removed) {
        const post = allPosts.find(p => p.id === entry.post)!;
        await sendDiscord(entry, post, "remove");
    }

    await updateMessage(added.length, removed.length, true);
    running = false;
}
