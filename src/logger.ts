import { DRY_RUN } from "./state.js";
import { isDocker } from "./util.js";
import config from "../config.json" with { type: "json" };
import { setTimeout as sleep } from "node:timers/promises";
import { format } from "node:util";

const { logWebhook, discordWebhookBaseURL } = config as { discordWebhookBaseURL?: string; logWebhook?: string; };
// the webhook queue server keeps us under discord's rate limits, same as Websites
const baseURL = discordWebhookBaseURL || (isDocker ? "http://discord.webhooks.local" : "https://discord.com");
const webhook = /^https:\/\/(?:canary\.|ptb\.)?discord\.com\/api\/webhooks\/(\d+)\/([^/?]+)/.exec(logWebhook ?? "");
// dry runs are for testing locally, so they stay in the console
const url = webhook && !DRY_RUN ? `${baseURL}/api/webhooks/${webhook[1]}/${webhook[2]}` : null;
if (logWebhook && !webhook) {
    console.error("[logger] logWebhook isn't a discord webhook url, webhook logging is disabled");
}

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
        const res = await fetch(url!, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ username: "E621Utils", embeds, allowed_mentions: { parse: [] } })
        }).catch(err => err as Error);
        if (!(res instanceof Error) && res.ok) {
            return;
        }

        if (!(res instanceof Error) && res.status === 429) {
            const body = await res.json().catch(() => ({})) as { retry_after?: number; };
            await sleep((body.retry_after ?? 1) * 1000);
            continue;
        }

        // anything other than a rate limit or a server error won't work on a retry
        if (!(res instanceof Error) && res.status < 500) {
            console.error(`[logger] Webhook returned ${res.status}: ${await res.text().catch(() => "")}`);
            return;
        }

        await sleep(attempt * 2000);
    }
    console.error("[logger] Giving up on sending to the webhook");
}

/** sends everything queued, resolves once the queue is empty */
export async function flush(): Promise<void> {
    if (url === null) {
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
    if (url === null) {
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

/** logs to the console, and to the log webhook if there is one */
const logger = {
    info:  (...args: Array<unknown>) => log("info", args),
    warn:  (...args: Array<unknown>) => log("warn", args),
    error: (...args: Array<unknown>) => log("error", args)
};
export default logger;
