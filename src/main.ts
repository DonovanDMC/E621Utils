import runSources from "./sources.js";
import { runBackfill } from "./backfill.js";
import { initChecks } from "./checks.js";
import { discord } from "./clients.js";
import logger, { flush } from "./logger.js";
import { runMilestones } from "./milestones.js";
import { runRevertsBackfill } from "./reverts.js";
import { startStream } from "./stream.js";
import statusServer from "@uwu-codes/status-server";

const running: Array<string> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runIf(type: string, func: (...args: Array<any>) => any) {
    if (running.includes(type)) {
        console.log(`Skipped running ${type} since it's already running`);
        return;
    }

    running.push(type);
    try {
        await func();
    } catch (err) {
        logger.error(`${type} failed:`, err);
    } finally {
        // without this, one error would leave it "running" forever
        running.splice(running.indexOf(type), 1);
    }
}

process.on("unhandledRejection", err => logger.error("Unhandled rejection:", err));
process.once("uncaughtException", async err => {
    logger.error("Uncaught exception, exiting:", err);
    await flush();
    process.exit(1);
});

logger.info("Starting");
await runMilestones();
await initChecks();
await startStream();
void runIf("backfill", runBackfill);
// waits for a new enough export, then does nothing once it's done
setInterval(() => void runIf("backfill", runBackfill), 60 * 60 * 1000);
// crawls our post versions once, retried hourly if it fails partway
void runIf("reverts", runRevertsBackfill);
setInterval(() => void runIf("reverts", runRevertsBackfill), 60 * 60 * 1000);

const server = statusServer(() => discord().ready);
process.once("SIGTERM", () => {
    discord().disconnect();
    server.close();
    process.kill(process.pid, "SIGTERM");
});
