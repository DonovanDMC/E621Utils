import config from "../config.json" assert { type: "json" };
import { ApplicationCommandTypes, Client } from "oceanic.js";
import E621 from "e621";

export const e621 = new E621({
    authUser: config.authUser,
    authKey:  config.authKey
});


let client: Client | undefined;
export function discord() {
    if (client === undefined) {
        client = new Client({
            auth:    config.token,
            gateway: {
                intents: 0
            },
            disableCache: "no-warning"
        });
        client.on("debug", info => console.debug("[Oceanic Debug]:", info));
        client.on("ready", async() => {
            await client!.restMode();
            console.debug("[Oceanic]: Ready as %s#%s", client!.user.tag);
            await client!.application.bulkEditGuildCommands(config.guild, [
                { type: ApplicationCommandTypes.CHAT_INPUT, name: "run-checks", description: "Force run the checks now." },
                { type: ApplicationCommandTypes.CHAT_INPUT, name: "dump-cache", description: "List the currently cached posts." }
            ]);
        });
        void client.connect();
    }
    return client;
}
