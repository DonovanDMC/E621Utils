import { e621 } from "./clients.js";
import { getExport } from "./exports.js";
import { isDirectRun } from "./util.js";

const whitelisted = new Set([
    "1:1",
    "2:1", "3:1", "3:2", "4:3", "5:3",
    "5:4", "6:5", "7:3", "21:9", "7:4",
    "8:5", "16:10", "11:8", "14:9", "16:9",
    "256:135", "1:2", "9:18", "1:3", "2:3",
    "3:4", "3:5", "4:5", "4:7", "5:6",
    "5:8", "9:14", "9:16", "135:256", "6:13"
]);

export default async function runRatios() {
    const r = /^\d+:\d+$/;
    const aliased: Record<string, string> = {};
    await getExport("tag_aliases", async record => {
        if (r.test(record.antecedent_name)) {
            aliased[record.antecedent_name] = record.consequent_name;
        }

        if (r.test(record.consequent_name)) {
            aliased[record.consequent_name] = record.antecedent_name;
        }
    });

    const totals: Record<string, number> = {};
    const list: Array<string> = [];
    await getExport("tags", async record => {
        if (record.post_count > 0 && r.test(record.name) && !whitelisted.has(record.name) && !whitelisted.has(aliased[record.name])) {
            if (record.post_count > 25) {
                console.log(`Skipping ${record.name} (${record.post_count})`);
                return;
            }
            console.log(`Found ${record.name} (${record.post_count})`);
            list.push(record.name);
            totals[record.name] = record.post_count;
        }
    });

    await getExport("posts", async record => {
        const tags = list.filter(tag => record.tags.includes(tag));
        if (tags.length !== 0) {
            for (const tag of tags) {
                console.log("Removed %s (%d) from %d", tag, --totals[tag], record.id);
            }

            await e621.posts.modify(record.id, { remove_tags: tags });
        }
    });
}

if (isDirectRun(import.meta.url)) {
    await runRatios();
}
