import { getClosestMilestone, getMilestoneTime, readCache, writeCache } from "./cache.js";
import { discord, e621 } from "./clients.js";
import { isDirectRun } from "./util.js";
import config from "../config.json" assert { type: "json" };

async function notify(id: number) {
    const post = (await e621.posts.get(id))!;
    await discord().rest.channels.createMessage(config.milestonesChannel, {
        embeds: [
            {
                title:       "New Milestone",
                url:         `https://e621.net/posts/${post.id}`,
                description: `Post #${post.id} has been reached!`,
                image:       {
                    url: post.file.url
                },
                color: 0xFFD700
            }
        ]
    });
}

export async function runMilestones() {
    const [post] = await e621.posts.search({ limit: 1 });
    const milestone = getClosestMilestone(post.id);
    const cache = await readCache();
    if (milestone > cache.lastMilestone) {
        await notify(milestone);
        cache.lastMilestone = milestone;
        await writeCache(cache);
    }
    const time = getMilestoneTime(post.id);
    setTimeout(runMilestones, time);
}

if (isDirectRun(import.meta.url)) {
    await runMilestones();
}
