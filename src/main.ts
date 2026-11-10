import runSources from "./sources.js";
import runChecks from "./checks.js";
import { discord } from "./clients.js";
import runMentions from "./mentions.js";
import runRatios from "./ratios.js";
import { runMilestones } from "./milestones.js";
import statusServer from "@uwu-codes/status-server";
import { spawn } from "node:child_process";

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

// same as `bun run manual`, each script in its own process
const manualScripts = ["discord-cdn-params", "ratios", "nuke-tags"];
async function runManual() {
    for (const script of manualScripts) {
        const code = await new Promise<number | null>(resolve => {
            spawn("bun", [`src/${script}.ts`], { env: { ...process.env, DEBUG: "*" }, stdio: "inherit" })
                .once("error", err => {
                    console.error(`Failed to start ${script}:`, err);
                    resolve(null);
                })
                .once("exit", resolve);
        });
        if (code !== 0) {
            console.error(`${script} exited with code ${code}, skipping the rest`);
            return;
        }
    }
}

await runMilestones();
setInterval(async() => {
    const d = new Date();

    if ((d.getMinutes() % 15) === 0 && d.getSeconds() === 0) {
        await runIf("mentions", runMentions);
    }

    if (d.getHours() === 5 && d.getMinutes() === 0 && d.getSeconds() === 0) {
        await runIf("manual", runManual);
    }
}, 1000);

const server = statusServer(() => discord().ready);
process.once("SIGTERM", () => {
    discord().disconnect();
    server.close();
    process.kill(process.pid, "SIGTERM");
});
