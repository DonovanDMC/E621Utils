/**
 * e621 rewrites sources every time a post is saved (twitter.com to x.com, mobile links, tracking params, etc.), so
 * anyone's edit can change one of ours without them touching it. This is a port of those rules
 * (app/logical/sources/alternates in e621ng) that's only used to tell if two sources are the same, it doesn't have
 * to give exactly what e621 would.
 */

const NITTER_HOSTS = new Set(["nitter.net", "nitter.poast.org", "nitter.space", "xcancel.com", "lightbrd.com", "nitter.tiekoetter.com", "nuku.trabun.org"]);
const TO_X = new Set(["twitter.com", "mobile.twitter.com", "mobile.x.com", "fxtwitter.com", "fixupx.com", "vxtwitter.com", "twittpr.com"]);

const onDomain = (url: URL, domain: string) => url.hostname === domain || url.hostname.endsWith(`.${domain}`);

/** ruby's split drops trailing empty strings */
function splitPath(path: string) {
    const parts = path.split("/");
    while (parts.length !== 0 && parts.at(-1) === "") {
        parts.pop();
    }
    return parts;
}

function deleteParams(url: URL, test: (key: string) => boolean) {
    for (const key of [...url.searchParams.keys()]) {
        if (test(key)) {
            url.searchParams.delete(key);
        }
    }
}

function keepParams(url: URL, keys: Array<string>) {
    deleteParams(url, key => !keys.includes(key));
}

const extname = (path: string) => /(?<!^|\/)\.[^./]*$/.exec(path)?.[0] ?? "";

function twitter(url: URL) {
    if (TO_X.has(url.hostname)) {
        url.hostname = "x.com";
    }
    if (NITTER_HOSTS.has(url.hostname)) {
        if (url.pathname.startsWith("/pic/")) {
            url = new URL(`https://pbs.twimg.com${decodeURIComponent(url.pathname.slice(4))}${url.search}`);
        } else {
            url.hostname = "x.com";
        }
    }
    if (onDomain(url, "x.com")) {
        deleteParams(url, key => ["a", "s", "t"].includes(key) || key.startsWith("utm_"));
        if (url.hash === "#m") {
            url.hash = "";
        }
        const parts = splitPath(url.pathname);
        if (parts.length === 6 && parts[4] === "photo") {
            url.pathname = parts.slice(0, 4).join("/");
        }
    }
    if (url.hostname === "pbs.twimg.com") {
        if (url.pathname.includes(":")) {
            const i = url.pathname.lastIndexOf(":");
            url.searchParams.set("name", url.pathname.slice(i + 1));
            url.pathname = url.pathname.slice(0, i);
        }
        const ext = extname(url.pathname);
        if (ext !== "") {
            url.searchParams.set("format", ext.slice(1));
            url.pathname = url.pathname.slice(0, -ext.length);
        }
    }
    return url;
}

function furaffinity(url: URL) {
    if (url.hostname === "d.facdn.net" || url.hostname === "d2.facdn.net") {
        url.hostname = "d.furaffinity.net";
    } else if (url.hostname === "sfw.furaffinity.net") {
        url.hostname = "www.furaffinity.net";
    }
    if (url.pathname.startsWith("/full/")) {
        url.pathname = `/view/${url.pathname.slice(6)}`;
    }
    if (url.search === "?upload-successful") {
        url.search = "";
    }
    if (url.hash.startsWith("#cid:")) {
        url.hash = "";
    }
    return url;
}

function pixiv(url: URL) {
    if (url.hostname !== "www.pixiv.net") {
        return url;
    }
    const illust = url.pathname === "/member_illust.php" ? url.searchParams.get("illust_id") : /^\/(?:i|(?:en\/)?artworks)\/(\d+)$/i.exec(url.pathname)?.[1];
    if (illust && Number(illust) > 0) {
        return new URL(`https://www.pixiv.net/artworks/${Number(illust)}`);
    }
    const user = url.pathname === "/member.php" ? url.searchParams.get("id") : /^\/(?:en\/)?users\/(\d+)\/?$/i.exec(url.pathname)?.[1];
    if (user && Number(user) > 0) {
        return new URL(`https://www.pixiv.net/users/${Number(user)}`);
    }
    return url;
}

function deviantart(url: URL) {
    if (url.hostname !== "deviantart.com" && url.hostname !== "www.deviantart.com") {
        const username = url.hostname.split(".")[0];
        url.hostname = "www.deviantart.com";
        url.pathname = `/${username}${url.pathname}`;
    }
    return url;
}

function inkbunny(url: URL) {
    url.hash = "";
    if (url.pathname.endsWith("-")) {
        url.pathname = url.pathname.slice(0, -1);
    }
    const id = Math.trunc(Number(url.searchParams.get("id")));
    if (url.hostname === "inkbunny.net" && url.pathname === "/submissionview.php" && id > 0) {
        const page = Math.trunc(Number(url.searchParams.get("page")));
        return new URL(`https://inkbunny.net/s/${id}${page > 1 ? `-p${page}` : ""}`);
    }
    return url;
}

function youtube(url: URL) {
    if (url.hostname === "youtu.be") {
        const id = url.pathname.slice(1);
        url.hostname = "www.youtube.com";
        url.pathname = "/watch";
        url.search = "";
        url.searchParams.set("v", id);
    }
    if (url.hostname.includes("youtube.com")) {
        if (url.pathname.startsWith("/shorts/")) {
            const id = url.pathname.split("/").at(-1)!;
            url.pathname = "/watch";
            url.search = "";
            url.searchParams.set("v", id);
        }
        url.hostname = "www.youtube.com";
    }
    if (url.pathname === "/watch" && url.searchParams.get("v")) {
        keepParams(url, ["v"]);
    } else {
        deleteParams(url, key => key.startsWith("utm_") || ["si", "list", "index", "t", "feature"].includes(key));
    }
    return url;
}

function derpibooru(url: URL) {
    if (url.hostname === "derpibooru.org" && url.pathname.startsWith("/images/")) {
        url.search = "";
    }
    if (url.hostname === "derpicdn.net" && url.pathname.includes("/img/")) {
        const parts = url.pathname.split("/");
        const download = parts.indexOf("download");
        if (download !== -1) {
            parts[download] = "view";
        }
        const id = /^(\d+)__/.exec(parts.at(-1)!)?.[1];
        if (id) {
            parts[parts.length - 1] = `${id}${extname(parts.at(-1)!)}`;
        }
        url.pathname = parts.join("/");
    }
    return url;
}

function facebook(url: URL) {
    if (url.hostname === "m.facebook.com" || url.hostname === "web.facebook.com") {
        url.hostname = "www.facebook.com";
    }
    if (/^\/photo\/?$/.test(url.pathname)) {
        url.pathname = "/photo.php";
    }
    if (url.pathname === "/photo.php" && url.searchParams.has("fbid")) {
        keepParams(url, ["fbid"]);
    }
    if (url.pathname === "/story.php" && url.searchParams.has("story_fbid")) {
        keepParams(url, ["story_fbid", "id"]);
    }
    return url;
}

function mobileHost(from: string, to: string) {
    return (url: URL) => {
        if (url.hostname === from) {
            url.hostname = to;
        }
        return url;
    };
}

function tumblr(url: URL) {
    deleteParams(url, key => key === "source" || key === "redirect_to");
    return url;
}

// in e621's order, the first one with a matching domain is used
const ALTERNATES: Array<[domains: Array<string>, rewrite: (url: URL) => URL]> = [
    [["furaffinity.net", "facdn.net"], furaffinity],
    [["pixiv.net", "pximg.net"], pixiv],
    [["deviantart.com"], deviantart],
    [["twitter.com", "x.com", "twimg.com", "fxtwitter.com", "fixupx.com", "vxtwitter.com", "twittpr.com", ...NITTER_HOSTS], twitter],
    [["inkbunny.net", "metapix.net"], inkbunny],
    [["youtube.com", "youtu.be"], youtube],
    [["derpibooru.org", "derpicdn.net"], derpibooru],
    [["facebook.com"], facebook],
    [["webtoons.com"], mobileHost("m.webtoons.com", "www.webtoons.com")],
    [["tapas.io"], mobileHost("m.tapas.io", "tapas.io")],
    [["imgur.com"], mobileHost("m.imgur.com", "imgur.com")],
    [["tumblr.com"], tumblr]
];

/** the same for a source and whatever e621 turns it into */
export function canonicalSource(source: string) {
    const trimmed = source.normalize("NFC").trim();
    // removed sources ("-https://...") are kept as is
    if (trimmed.startsWith("-")) {
        return trimmed;
    }
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    } catch {
        return trimmed;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return trimmed;
    }
    const alternate = ALTERNATES.find(([domains]) => domains.some(d => onDomain(url, d)));
    if (alternate) {
        try {
            url = alternate[1](url);
        } catch {
            // e621 leaves it alone if anything goes wrong
        }
    }
    url.searchParams.sort();
    // e621 forces https on most sites and query params can come back in a different order, so neither is compared
    return `${url.host}${url.pathname}${url.search}${url.hash}`;
}

export const canonicalSources = (sources: Iterable<string>) => new Set([...sources].map(canonicalSource));
