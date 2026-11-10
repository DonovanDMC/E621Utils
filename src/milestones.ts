import { getClosestMilestone, getMilestoneTime, readCache, writeCache } from "./cache.js";
import { discord, e621 } from "./clients.js";
import logger from "./logger.js";
import { getFileURL, isDirectRun } from "./util.js";
import config from "../config.json" with { type: "json" };

async function notify(id: number) {
    const post = (await e621.posts.get(id, { v2: true }))!;
    await discord().rest.channels.createMessage(config.milestonesChannel, {
        embeds: [
            {
                title:       "New Milestone",
                url:         `https://e621.net/posts/${post.id}`,
                description: `Post #${post.id} has been reached!`,
                image:       {
                    url: getFileURL(post)
                },
                color: 0xFFD700
            }
        ]
    });
}

export async function runMilestones() {
    let time = 5 * 60 * 1000;
    try {
        const [post] = await e621.posts.search({ limit: 1 });
        const milestone = getClosestMilestone(post!.id);
        const cache = await readCache();
        if (milestone > cache.lastMilestone) {
            await notify(milestone);
            cache.lastMilestone = milestone;
            await writeCache(cache);
        }
        time = getMilestoneTime(post!.id);
    } catch (err) {
        logger.error("[milestones] Failed, retrying in 5 minutes:", err);
    } finally {
        // always rescheduled, an error would otherwise stop it for good
        setTimeout(runMilestones, time);
    }
}

if (isDirectRun(import.meta.url)) {
    await runMilestones();
}
