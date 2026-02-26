import E621ExportDownloader, { ExportName, DefaultParsers } from "e621-export-downloader";

const client = new E621ExportDownloader({
    cache: true,
    rewindOnNotFound: 2,
});

type ExportConversion<T extends ExportName> =
    T extends "pools" ? DefaultParsers.PoolData :
        T extends "posts" ? DefaultParsers.PostData :
            T extends "tag_aliases" ? DefaultParsers.TagAliasData :
                T extends "tag_implications" ? DefaultParsers.TagImplicationData :
                    T extends "tags" ? DefaultParsers.TagData :
                        T extends "wiki_pages" ? DefaultParsers.WikiPageData :
                            never;

export async function getExport<T extends ExportName>(type: T, cb: (record: ExportConversion<T>, rowCount: number) => Promise<void>, date = new Date()) {
    const helper = client.get(type);
    for await (const [record, rowCount] of helper.read(date)) {
        await cb(record as ExportConversion<T>, rowCount);
    }
}
