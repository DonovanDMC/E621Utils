import { parse as parsePost } from "./parsers/posts.js";
import type { PostData, RawPost } from "./parsers/posts.js";
import { parse as parseTagAlias } from "./parsers/tag_aliases.js";
import type { TagAliasData, RawTagAlias } from "./parsers/tag_aliases.js";
import { parse as parseTagImplication } from "./parsers/tag_implications.js";
import type { TagImplicationData, RawTagImplication } from "./parsers/tag_implications.js";
import { parse as parseTag } from "./parsers/tags.js";
import type { TagData, RawTag } from "./parsers/tags.js";
import { parse as parseWikiPage } from "./parsers/wiki_pages.js";
import type { WikiPageData, RawWikiPage } from "./parsers/wiki_pages.js";
import { parse as parsePool } from "./parsers/pools.js";
import type { RawPool, PoolData } from "./parsers/pools.js";
import { DAY } from "./util.js";
import { parse } from "csv-parse";
import { tmpdir } from "node:os";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream, type PathLike } from "node:fs";
import { exec } from "node:child_process";

const exists = async(path: PathLike) => access(path).then(() => true, () => false);

const types = ["pools", "posts", "tag_aliases", "tag_implications", "tags", "wiki_pages"] as const;
type ExportType = typeof types[number];

type ExportConversion<T extends ExportType> =
    T extends "pools" ? PoolData :
        T extends "posts" ? PostData :
            T extends "tag_aliases" ? TagAliasData :
                T extends "tag_implications" ? TagImplicationData :
                    T extends "tags" ? TagData :
                        T extends "wiki_pages" ? WikiPageData :
                            never;

async function download(type: string, date = new Date(), rewind = 0, originalDate: Date | null = null): Promise<[date: Date, file: string]> {
    const d = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${(date.getDate()).toString().padStart(2, "0")}`;
    console.log(`Checking for export ${type}-${d}`);
    const file = `${tmpdir()}/${type}-${d}.csv`;
    if (await exists(file)) {
        console.log(`export ${type}-${d} found locally, skipping download`);
        return [date, file];
    }

    const url = `https://e621.net/db_export/${type}-${d}.csv.gz`;
    const test = await fetch(url, {
        method: "HEAD"
    });

    if (test.status === 404) {
        if (rewind >= 2) {
            originalDate ??= date;
            const dd = `${originalDate.getFullYear()}-${(originalDate.getMonth() + 1).toString().padStart(2, "0")}-${(originalDate.getDate()).toString().padStart(2, "0")}`;
            throw new Error(`Export ${type}-${dd} does not exist, and nothing within 2 days before could be found.`);
        }
        console.log(`Export ${type}-${d} does not exist, attempting to rewind to a day earlier..`);
        return download(type, new Date(date.getTime() - DAY), ++rewind, originalDate ?? date);
    }

    const prevDate = new Date(date.getTime() - DAY);
    const pd = `${prevDate.getFullYear()}-${(prevDate.getMonth() + 1).toString().padStart(2, "0")}-${(prevDate.getDate()).toString().padStart(2, "0")}`;
    const prevFile = `${tmpdir()}/${type}-${pd}.csv`;
    const prevStrCount = `${tmpdir()}/${type}-${pd}.count`;
    if (await exists(prevFile)) {
        console.log(`Removing previous export file ${type}-${pd}`);
        await rm(prevFile);
    }

    if (await exists(prevStrCount)) {
        await rm(prevStrCount);
    }

    console.log(`Starting download of export ${type}-${d}`);
    await new Promise<void>((resolve, reject) => {
        exec(`wget -q -O - ${url} | gunzip > ${file}`, err => err ? reject(err) : resolve());
    });
    console.log(`Finished downloading export ${type}-${d}`);

    return [date, file];
}

function parseRecord<T extends ExportType>(type: T, record: RawPool | RawPost | RawTagAlias | RawTagImplication | RawTag | RawWikiPage): ExportConversion<T> {
    switch (type) {
        case "pools": return parsePool(record as RawPool) as ExportConversion<T>;
        case "posts": return parsePost(record as RawPost) as ExportConversion<T>;
        case "tag_aliases": return parseTagAlias(record as RawTagAlias) as ExportConversion<T>;
        case "tag_implications": return parseTagImplication(record as RawTagImplication) as ExportConversion<T>;
        case "tags": return parseTag(record as RawTag) as ExportConversion<T>;
        case "wiki_pages": return parseWikiPage(record as RawWikiPage) as ExportConversion<T>;
        default: throw new TypeError(`Unknown export type: ${type}`);
    }
}

export async function getExport<T extends ExportType>(type: T, cb: (record: ExportConversion<T>, rowCount: number) => Promise<void>, date = new Date()) {
    const parser = parse({
        columns:  true,
        onRecord: parseRecord.bind(null, type)
    });
    parser.on("readable", async() => {
        let record: unknown;
        while ((record = parser.read() as unknown)) {
            await cb(record as unknown as ExportConversion<T>, rowCount);
        }
    });
    const [dd, file] = await download(type, date);
    if (dd.getTime() !== date.getTime()) {
        console.log(`Rewound to ${dd.toISOString()} for ${type}`);
        date = dd;
    }
    const d = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${(date.getDate()).toString().padStart(2, "0")}`;
    const strCount = `${tmpdir()}/${type}-${d}.count`;
    const rowCount = (await exists(strCount)) ?
        Number(await readFile(strCount, "utf8")) :
        (await new Promise<number>((resolve, reject) => {
            exec(`python -c "import sys; import csv; csv.field_size_limit(sys.maxsize); print(sum(1 for i in csv.reader(open('${file}'))))"`, (err, out) => {
                if (err) {
                    reject(err);
                } else {
                    void writeFile(strCount, out).then(() => {
                        resolve(Number(out));
                    }, reject);
                }
            });
        }));
    console.log("Counted %d rows for %s-%s", rowCount, type, d);
    return new Promise<void>(resolve => {
        const read = createReadStream(file);
        parser.on("error", err => console.error(err.message));
        parser.on("end", () => {
            read.close();
            parser.end();
            resolve();
        });
        read.pipe(parser);
    });
}
