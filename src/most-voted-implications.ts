import { getMostVoted, runCLI, type SortBy, type VoteSource } from "./most-voted.js";
import { isDirectRun } from "./util.js";

interface TagImplication {
    antecedent_name: string;
    consequent_name: string;
    forum_post_id: number | null;
    forum_topic_id: number | null;
    id: number;
}

export const implications: VoteSource<TagImplication> = {
    label:     "Implication",
    name:      "implications",
    path:      "tag_implications",
    toRequest: ({ id, antecedent_name, consequent_name, forum_topic_id, forum_post_id }) => ({ id, title: `${antecedent_name} -> ${consequent_name}`, forum_topic_id, forum_post_id })
};

export default async function getMostVotedImplications(sortBy?: SortBy, count?: number) {
    return getMostVoted(implications, sortBy, count);
}

if (isDirectRun(import.meta.url)) {
    await runCLI(implications);
}
