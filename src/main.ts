import runSources from "./sources.js";
import runChecks from "./checks.js";
import { discord } from "./clients.js";
import runMentions from "./mentions.js";
import runRatios from "./ratios.js";
import { runMilestones } from "./milestones.js";
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

await runMilestones();
setInterval(async() => {
    const d = new Date();

    if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
        await runIf("sources", runSources);
        await runIf("ratios", runRatios);
    }

    if (d.getMinutes() === 0 && d.getSeconds() === 0) {
        await runIf("mentions", runMentions);
    }

    if (d.getMinutes() % 5 === 0 && d.getSeconds() === 0) {
        await runIf("checks", runChecks);
    }
}, 1000);

const server = statusServer(() => discord().ready);
process.once("SIGTERM", () => {
    discord().disconnect();
    server.close();
    process.kill(process.pid, "SIGTERM");
});
