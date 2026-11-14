import { needsTagCheck, recheckPost, trackedPosts } from "./checks.js";
import type { HandlerPost } from "./handler.js";
import logger from "./logger.js";
import { saveState, state } from "./state.js";
import { matchHandlers, runHandlers, runQueued } from "./stream.js";
import E621ExportDownloader, { type PostData } from "e621-export-downloader";
import { type AnyInteractionGateway, CommandInteraction, MessageFlags } from "oceanic.js";

// the file is deleted once it's been fully read
const client = new E621ExportDownloader({ cache: false });

// export rows don't have tag categories, which none of the handlers care about
function toPost(record: PostData): HandlerPost {
    return {
        id:      record.id,
        file:    { ext: record.file_ext },
        sources: record.sources,
        tags:    { artist: [], character: [], contributor: [], copyright: [], general: record.tags, invalid: [], lore: [], meta: [], species: [] }
    };
}

let running = false, requested = false;
/**
 * Goes over the first posts export made after the stream was started, through the same handlers and queue as the
 * stream, so anything from before then is caught. Only done once unless /run-backfill is used, and resumes where it left off after a restart.
 */
export async function runBackfill() {
    const s = state();
    if (running || s.backfill?.done || s.startedAt === undefined) {
        return;
    }
    running = true;

    try {
        const exp = await client.get("posts");
        if (new Date(exp.data.updated_at).getTime() < s.startedAt) {
            console.log(`[backfill] Waiting for an export newer than ${new Date(s.startedAt).toISOString()}, the latest is from ${exp.data.updated_at}`);
            return;
        }

        if (s.backfill?.export !== exp.data.updated_at || !s.backfill.downloaded) {
            logger.info(`[backfill] Downloading the posts export from ${exp.data.updated_at}`);
            await exp.delete();
            await exp.download();
            s.backfill = { done: false, downloaded: true, export: exp.data.updated_at, lastId: 0 };
            await saveState();
        }

        const backfill = s.backfill;
        logger.info(backfill.lastId === 0 ? "[backfill] Starting" : `[backfill] Resuming after post ${backfill.lastId}`);
        let read = 0, matched = 0;
        // cached posts that aren't in the export were destroyed, so they're checked at the end
        const unseen = new Set(trackedPosts());
        for await (const [record, total] of exp.read()) {
            if ((++read % 1_000_000) === 0) {
                console.log(`[backfill] ${read}/${total}`);
            }
            unseen.delete(record.id);
            if (record.id <= backfill.lastId) {
                continue;
            }

            const post = toPost(record);
            const handlers = matchHandlers(post);
            const tagCheck = needsTagCheck({ ...post, rating: record.rating, flags: { deleted: record.is_deleted } });
            if (handlers.length !== 0 || tagCheck) {
                matched++;
                // waited on, so the export is only read as fast as matching posts are handled
                await runQueued(async() => {
                    await runHandlers(post, handlers);
                    if (tagCheck) {
                        await recheckPost(post.id).catch(err => logger.error(`[backfill] Tag check failed on post ${post.id}:`, err));
                    }
                });
            }

            backfill.lastId = record.id;
            if ((read % 100_000) === 0) {
                await saveState();
            }
        }

        for (const id of unseen) {
            await runQueued(async() => recheckPost(id));
        }

        backfill.done = true;
        await saveState();
        logger.info(`[backfill] Finished, ${matched} of ${read} posts needed looking at`);
    } catch (err) {
        logger.error("[backfill] Failed, retrying on the next check:", err);
    } finally {
        running = false;
        if (requested) {
            requested = false;
            void restartBackfill();
        }
    }
}

/** starts over on the latest export, returns false if one is already running (it's ran again once that finishes) */
async function restartBackfill() {
    if (running) {
        requested = true;
        return false;
    }
    // without one it uses the latest export, there's no waiting since startedAt is already behind it
    delete state().backfill;
    await saveState();
    void runBackfill();
    return true;
}

/** for when the handlers change, and posts the backfill already went past need to be looked at again */
export async function onBackfillCommand(interaction: AnyInteractionGateway) {
    if (!(interaction instanceof CommandInteraction) || interaction.data.name !== "run-backfill") {
        return;
    }
    const started = await restartBackfill();
    await interaction.createMessage({
        flags:   MessageFlags.EPHEMERAL,
        content: started ? "Backfill started." : "A backfill is already running, another will start once it's done."
    });
}
