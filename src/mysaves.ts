import config from "../config.json" with { type: "json" };

const { mysavesURL, mysavesApiKey } = config as { mysavesApiKey?: string; mysavesURL?: string; };
const baseURL = (mysavesURL || "https://saves.furry.cool").replace(/\/$/, "");
/** without a key MySaves can't be read, so reviews are left out of the checks */
export const mysavesEnabled = Boolean(mysavesApiKey);

interface Page {
    data: Array<{ post_id: number; }>;
    pagination: { next: number | null; };
}

/** every post currently saved for review in MySaves */
export async function getReviews() {
    const ids = new Set<number>();
    for (let page = 1; ; page++) {
        const res = await fetch(`${baseURL}/e621/saved/for_review?limit=1000&page=${page}`, {
            headers: {
                "Accept":        "application/json",
                "Authorization": `Bearer ${mysavesApiKey}`,
                "User-Agent":    "E621Utils (by donovan_dmc)"
            },
            signal: AbortSignal.timeout(30_000)
        });
        if (!res.ok) {
            throw new Error(`MySaves returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 500)}`);
        }

        const body = await res.json() as Page;
        for (const review of body.data) {
            ids.add(review.post_id);
        }
        if (!body.pagination.next) {
            return ids;
        }
    }
}
