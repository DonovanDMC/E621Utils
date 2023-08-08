import { e621 } from "./clients";
import { setTimeout } from "node:timers/promises";


async function removeBlobSources() {
    const posts = await e621.posts.search({
        tags:  "source:blob*",
        limit: 320
    });

    if (posts.length === 0) {
        console.log("[RemoveBlobSources] No posts found.");
        return;
    }

    let i = 0;
    for (const post of posts) {
        const start = process.hrtime.bigint();
        const remove_sources = post.sources.filter(source => source.startsWith("blob:"));
        await e621.posts.modify(post.id, {
            remove_sources
        });
        console.log("[%d/%d] Removed \"%s\" from #%d", ++i, posts.length, remove_sources.join(", "), post.id);
        const end = process.hrtime.bigint();
        const ms = Number((end - start) / 1000000n);
        // take as close to 750ms as possible per request
        if (ms <= 750) {
            await setTimeout(750 - ms);
        }
    }

    if (posts.length === 320) {
        await removeBlobSources();
    }
}

export default async function run() {
    await removeBlobSources();
}
