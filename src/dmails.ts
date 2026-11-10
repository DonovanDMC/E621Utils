import { discord } from "./clients.js";
import { getAvatar } from "./mentions.js";
import { DRY_RUN } from "./state.js";
import { getFileURL } from "./util.js";
import config from "../config.json" with { type: "json" };
import type { DMail } from "e621stream";

const RECEIVED = 0xFFD700, SENT = 0x1E90FF;
const channel = (config as { dmailsChannel?: string; }).dmailsChannel || null;
/**
 * Without a channel there's nowhere to send them, so they aren't subscribed to. Dry runs don't subscribe either, the stream
 * only remembers the newest dmail it's sent per account, so any other connection that gets one means the real one never will.
 */
export const dmailsEnabled = channel !== null && !DRY_RUN;

/** sends a dmail to the dmails channel, both ones we get and ones we send */
export async function handleDMail(dmail: DMail) {
    const sent = dmail.from_id === dmail.owner_id;

    // a missing avatar shouldn't stop the dmail from being sent
    const avatar = await getAvatar(dmail.from_id).catch(() => null);
    await discord().rest.channels.createMessage(channel!, {
        embeds: [
            {
                title:  `${sent ? `Sent DMail to ${dmail.to_name}` : `New DMail from ${dmail.from_name}`}: ${dmail.title}`.slice(0, 256),
                url:    `https://e621.net/dmails/${dmail.id}`,
                author: {
                    name:    dmail.from_name,
                    iconURL: avatar ? getFileURL(avatar) : undefined,
                    url:     `https://e621.net/users/${dmail.from_id}`
                },
                description: dmail.body.length > 4096 ? `${dmail.body.slice(0, 4093)}...` : dmail.body,
                color:       sent ? SENT : RECEIVED,
                timestamp:   dmail.created_at
            }
        ],
        allowedMentions: { everyone: false, roles: false, users: false }
    });
}
