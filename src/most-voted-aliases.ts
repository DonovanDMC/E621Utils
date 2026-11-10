import { getMostVoted, runCLI, type SortBy, type VoteSource } from "./most-voted.js";
import { isDirectRun } from "./util.js";

interface TagAlias {
    antecedent_name: string;
    consequent_name: string;
    forum_post_id: number | null;
    forum_topic_id: number | null;
    id: number;
}

export const aliases: VoteSource<TagAlias> = {
    label:     "Alias",
    name:      "aliases",
    path:      "tag_aliases",
    toRequest: ({ id, antecedent_name, consequent_name, forum_topic_id, forum_post_id }) => ({ id, title: `${antecedent_name} -> ${consequent_name}`, forum_topic_id, forum_post_id })
};

export default async function getMostVotedAliases(sortBy?: SortBy, count?: number) {
    return getMostVoted(aliases, sortBy, count);
}

if (isDirectRun(import.meta.url)) {
    await runCLI(aliases);
}
