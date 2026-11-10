import { discord } from "./clients.js";
import { DRY_RUN } from "./state.js";
import config from "../config.json" with { type: "json" };
import { DiscordHTTPError, DiscordRESTError } from "oceanic.js";
import { setTimeout as sleep } from "node:timers/promises";
import { format } from "node:util";

// dry runs are for testing locally, so they stay in the console
const channel = DRY_RUN ? null : (config as { logsChannel?: string; }).logsChannel || null;

const colors = { info: 0x008000, warn: 0xFFD700, error: 0xDC143C } as const;
type Level = keyof typeof colors;

interface Embed {
    color: number;
    description: string;
    timestamp: string;
}

// discord allows 10 embeds per message, 4096 characters per description, and 6000 characters across a message's embeds
const MAX_EMBEDS = 10, MAX_LENGTH = 4096, MAX_TOTAL = 6000;
const queue: Array<Embed> = [];
let flushing: Promise<void> | null = null;

async function send(embeds: Array<Embed>) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            // oceanic waits out rate limits itself
            await discord().rest.channels.createMessage(channel!, { embeds, allowedMentions: { everyone: false, roles: false, users: false } });
            return;
        } catch (err) {
            // console only, logging this to discord would just fail again
            console.error(`[logger] Failed to send logs (attempt ${attempt}):`, err);
            // anything other than a server error won't work on a retry
            if ((err instanceof DiscordRESTError || err instanceof DiscordHTTPError) && err.status < 500) {
                return;
            }
        }

        await sleep(attempt * 2000);
    }
    console.error("[logger] Giving up on sending logs");
}

/** sends everything queued, resolves once the queue is empty */
export async function flush(): Promise<void> {
    if (channel === null) {
        return;
    }
    flushing ??= (async() => {
        while (queue.length !== 0) {
            let count = 0, total = 0;
            while (count < queue.length && count < MAX_EMBEDS && total + queue[count]!.description.length <= MAX_TOTAL) {
                total += queue[count++]!.description.length;
            }
            await send(queue.splice(0, count));
        }
    })().finally(() => (flushing = null));
    return flushing;
}

let timer: NodeJS.Timeout | null = null;
function log(level: Level, args: Array<unknown>) {
    const text = format(...args);
    (level === "info" ? console.log : console[level])(text);
    if (channel === null) {
        return;
    }

    queue.push({
        color:       colors[level],
        description: text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 3)}...` : text,
        timestamp:   new Date().toISOString()
    });
    // batched, so a burst of edits doesn't become a burst of requests
    timer ??= setTimeout(() => {
        timer = null;
        void flush();
    }, 2000);
}

/** logs to the console, and to the logs channel if there is one */
const logger = {
    info:  (...args: Array<unknown>) => log("info", args),
    warn:  (...args: Array<unknown>) => log("warn", args),
    error: (...args: Array<unknown>) => log("error", args)
};
export default logger;
