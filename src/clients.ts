import config from "../config.json" assert { type: "json" };
import { ApplicationCommandTypes, Client } from "oceanic.js";
import E621 from "e621";

export const e621 = new E621({
    authUser: config.authUser,
    authKey:  config.authKey
});

export const discord = new Client({
    auth:    config.token,
    gateway: {
        intents: 0
    },
    disableCache: "no-warning"
});
discord.on("debug", info => console.debug("[Oceanic Debug]:", info));
discord.on("ready", async() => {
    await discord.restMode();
    console.debug("[Oceanic]: Ready as %s#%s", discord.user.username, discord.user.discriminator);
    await discord.application.bulkEditGuildCommands(config.guild, [
        { type: ApplicationCommandTypes.CHAT_INPUT, name: "run-checks", description: "Force run the checks now." },
        { type: ApplicationCommandTypes.CHAT_INPUT, name: "dump-cache", description: "List the currently cached posts." }
    ]);
});
void discord.connect();
