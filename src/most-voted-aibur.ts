import { get, getMostVoted, MAX_IDS, runCLI, type SortBy, type VoteRequest, type VoteSource } from "./most-voted.js";
import { isDirectRun } from "./util.js";

interface BUR {
    forum_post_id: number | null;
    forum_topic_id: number | null;
    id: number;
    title: string;
}

// some burs don't have a title, so use the forum topic's title instead
async function fillTitles(burs: Array<VoteRequest>) {
    const missing = burs.filter(b => !b.title);

    const noTopic = missing.filter(b => !b.forum_topic_id && b.forum_post_id);
    for (let i = 0; i < noTopic.length; i += MAX_IDS) {
        const chunk = noTopic.slice(i, i + MAX_IDS);
        const posts = await get<Array<{ id: number; topic_id: number; }>>(`https://e621.net/forum_posts.json?limit=${MAX_IDS}&search[id]=${chunk.map(b => b.forum_post_id).join(",")}`, true);
        const postToTopic = new Map(posts.map(p => [p.id, p.topic_id]));
        for (const bur of chunk) {
            bur.forum_topic_id = postToTopic.get(bur.forum_post_id!) ?? null;
        }
    }

    const topicIds = [...new Set(missing.map(b => b.forum_topic_id).filter(id => id !== null))];
    const titles = new Map<number, string>();
    for (let i = 0; i < topicIds.length; i += MAX_IDS) {
        const topics = await get<Array<{ id: number; title: string; }>>(`https://e621.net/forum_topics.json?limit=${MAX_IDS}&search[id]=${topicIds.slice(i, i + MAX_IDS).join(",")}`, true);
        for (const topic of topics) {
            titles.set(topic.id, topic.title);
        }
    }

    for (const bur of missing) {
        bur.title = (bur.forum_topic_id && titles.get(bur.forum_topic_id)) || `BUR #${bur.id}`;
    }
}

export const burs: VoteSource<BUR> = {
    label:     "BUR",
    name:      "aibur",
    path:      "bulk_update_requests",
    fillTitles,
    toRequest: ({ id, title, forum_topic_id, forum_post_id }) => ({ id, title, forum_topic_id, forum_post_id })
};

export default async function getMostVotedAIBURs(sortBy?: SortBy, count?: number) {
    return getMostVoted(burs, sortBy, count);
}

if (isDirectRun(import.meta.url)) {
    await runCLI(burs);
}
