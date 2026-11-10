import config from "../config.json" with { type: "json" };

const { mysavesURL, mysavesApiKey } = config as { mysavesApiKey?: string; mysavesURL?: string; };
const baseURL = (mysavesURL || "https://saves.furry.cool").replace(/\/$/, "");
/** without a key MySaves can't be read, so reviews are left out of the checks */
export const mysavesEnabled = Boolean(mysavesApiKey);

interface Review {
    id: number;
    post_id: number;
}

interface Page {
    data: Array<Review>;
    pagination: { next: number | null; };
}

async function request<T>(path: string, method = "GET") {
    const res = await fetch(`${baseURL}${path}`, {
        method,
        headers: {
            "Accept":        "application/json",
            "Authorization": `Bearer ${mysavesApiKey}`,
            "User-Agent":    "E621Utils (by donovan_dmc)"
        },
        signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) {
        throw new Error(`MySaves returned ${res.status} for ${method} ${path}: ${(await res.text().catch(() => "")).slice(0, 500)}`);
    }
    return res.json() as Promise<T>;
}

async function getReviewRecords() {
    const reviews: Array<Review> = [];
    for (let page = 1; ; page++) {
        const body = await request<Page>(`/e621/saved/for_review?limit=1000&page=${page}`);
        reviews.push(...body.data);
        if (!body.pagination.next) {
            return reviews;
        }
    }
}

/** every post currently saved for review in MySaves */
export async function getReviews() {
    return new Set((await getReviewRecords()).map(r => r.post_id));
}

/** takes a post out of review in MySaves, returns false if it wasn't under review */
export async function removeReview(postId: number) {
    // deleting goes by the review's own id, which there's no lookup by post for
    const review = (await getReviewRecords()).find(r => r.post_id === postId);
    if (!review) {
        return false;
    }
    await request(`/e621/saved/for_review/${review.id}`, "DELETE");
    return true;
}
