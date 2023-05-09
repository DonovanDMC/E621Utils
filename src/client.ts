import config from "../config.json" assert { type: "json" };
import E621 from "e621";

const e621 = new E621({
    authUser: config.authUser,
    authKey:  config.authKey
});
export default e621;
