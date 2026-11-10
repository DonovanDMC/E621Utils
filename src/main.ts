import runSources from "./sources.js";
import { runBackfill } from "./backfill.js";
import runChecks from "./checks.js";
import { discord } from "./clients.js";
import logger, { flush } from "./logger.js";
import runMentions from "./mentions.js";
import { runMilestones } from "./milestones.js";
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
    await func();
    running.splice(running.indexOf(type), 1);
}

process.on("unhandledRejection", err => logger.error("Unhandled rejection:", err));
process.once("uncaughtException", async err => {
    logger.error("Uncaught exception, exiting:", err);
    await flush();
    process.exit(1);
});

logger.info("Starting");
await runMilestones();
await startStream();
void runIf("backfill", runBackfill);
setInterval(async() => {
    const d = new Date();

    if ((d.getMinutes() % 15) === 0 && d.getSeconds() === 0) {
        await runIf("mentions", runMentions);
    }

    // waits for a new enough export, then does nothing once it's done
    if (d.getMinutes() === 0 && d.getSeconds() === 0) {
        await runIf("backfill", runBackfill);
    }
}, 1000);

const server = statusServer(() => discord().ready);
process.once("SIGTERM", () => {
    discord().disconnect();
    server.close();
    process.kill(process.pid, "SIGTERM");
});
