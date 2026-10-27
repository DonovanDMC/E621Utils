import { e621 } from "./clients.js";

await e621.posts.update(5000000, { tag_string_diff: "male" })
