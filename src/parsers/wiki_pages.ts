type TF = "t" | "f";
export interface RawWikiPage {
    body: string;
    created_at: string;
    creator_id: string;
    id: string;
    is_locked: TF;
    title: string;
    updated_at: string;
    updater_id: string;
}

export function parse(record: RawWikiPage): WikiPageData {
    return {
        body:       record.body.replaceAll("\r\n", "\n"),
        created_at: new Date(record.created_at).toISOString(),
        creator_id: record.creator_id === "" ? null : Number(record.creator_id),
        id:         Number(record.id),
        is_locked:  record.is_locked === "t",
        title:      record.title,
        updated_at: record.updated_at === "" ? null : new Date(record.updated_at).toISOString(),
        updater_id: record.updater_id === "" ? null : Number(record.updater_id)
    };
}

export interface WikiPageData {
    body: string;
    created_at: string;
    creator_id: number | null;
    id: number;
    is_locked: boolean;
    title: string;
    updated_at: string | null;
    updater_id: number | null;
}
