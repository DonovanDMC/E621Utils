import runAutomated from "./automated.js";
import runChecks from "./checks.js";
import { discord } from "./clients.js";
import runMentions from "./mentions.js";
import statusServer from "@uwu-codes/status-server";

setInterval(async() => {
    const d = new Date();

    if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
        await runAutomated();
    }

    if (d.getMinutes() === 0 && d.getSeconds() === 0) {
        await runMentions();
    }

    if (d.getMinutes() % 5 === 0 && d.getSeconds() === 0) {
        await runChecks();
    }
}, 1000);

const server = statusServer(() => discord.ready);
process.once("SIGTERM", () => {
    discord.disconnect();
    server.close();
    process.kill(process.pid, "SIGTERM");
});
