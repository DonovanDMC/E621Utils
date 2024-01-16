import { e621 } from "./clients";
import { getExport } from "./exports";

const whitelisted = new Set([
    "2:1", "3:1", "3:2", "4:3", "5:3",
    "5:4", "6:5", "7:3", "21:9", "7:4",
    "8:5", "16:10", "11:8", "14:9", "16:9",
    "256:135", "1:2", "9:18", "1:3", "2:3",
    "3:4", "3:5", "4:5", "4:7", "5:6",
    "5:8", "10:16", "6:13", "18:39", "9:14",
    "9:16", "135:256", "1:1"
]);

export default async function runRatios() {
    const r = /^\d+:\d+$/;
    const aliased: Record<string, string> = {};
    await getExport("tag_aliases", async record => {
        if (r.test(record.antecedent_name)) {
            aliased[record.antecedent_name] = record.consequent_name;
        }
    });

    const totals: Record<string, number> = {};
    const list: Array<string> = [];
    await getExport("tags", async record => {
        if (record.post_count > 0 && r.test(record.name) && !whitelisted.has(record.name)) {
            console.log(`Found ${record.name}`);
            list.push(record.name);
            totals[record.name] = record.post_count;
        }
    });

    await getExport("posts", async record => {
        const tags = list.filter(tag => record.tags.split(" ").includes(tag));
        if (tags.length !== 0) {
            for (const tag of tags) {
                console.log("Removed %s (%d) from %d", tag, --totals[tag], record.id);
            }

            await e621.posts.modify(record.id, { remove_tags: tags });
        }
    });
}
