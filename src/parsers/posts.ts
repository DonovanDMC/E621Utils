type TF = "t" | "f";
export interface RawPost {
    approver_id: string;
    change_seq: string;
    comment_count: string;
    created_at: string;
    description: string;
    down_score: string;
    duration: string;
    fav_count: string;
    file_ext: string;
    file_size: string;
    id: string;
    image_height: string;
    image_width: string;
    is_deleted: TF;
    is_flagged: TF;
    is_note_locked: TF;
    is_pending: TF;
    is_rating_locked: TF;
    is_status_locked: TF;
    locked_tags: string;
    md5: string | null;
    parent_id: string;
    rating: "s" | "q" | "e";
    score: string;
    source: string;
    tag_string: string;
    up_score: string;
    updated_at: string;
    uploader_id: string;
}

export function parse(record: RawPost): PostData {
    return {
        animated_png:     record.tag_string.split(" ").includes("animated_png") && record.file_ext === "png",
        animated:         record.tag_string.split(" ").includes("animated"),
        approver_id:      record.approver_id === "" ? null : Number(record.approver_id),
        change_seq:       Number(record.change_seq),
        comment_count:    Number(record.comment_count),
        created_at:       new Date(record.created_at).toISOString(),
        description:      record.description.replaceAll("\r\n", "\n"),
        down_score:       Number(record.down_score),
        duration:         record.duration === "" ? null : Number(record.duration),
        fav_count:        Number(record.fav_count),
        file_ext:         record.file_ext,
        file_size:        Number(record.file_size),
        height:           Number(record.image_height),
        id:               Number(record.id),
        is_deleted:       record.is_deleted === "t",
        is_flagged:       record.is_flagged === "t",
        is_note_locked:   record.is_note_locked === "t",
        is_pending:       record.is_pending === "t",
        is_rating_locked: record.is_rating_locked === "t",
        is_status_locked: record.is_status_locked === "t",
        locked_tags:      record.locked_tags,
        md5:              record.md5 === "" ? null : record.md5,
        parent_id:        record.parent_id === "" ? null : Number(record.parent_id),
        rating:           record.rating,
        score:            Number(record.score),
        sources:          record.source.replaceAll("\r\n", "\n").split("\n"),
        tags:             record.tag_string.split(" "),
        up_score:         Number(record.up_score),
        updated_at:       record.updated_at === "" ? null : new Date(record.updated_at).toISOString(),
        uploader_id:      record.uploader_id === "" ? null : Number(record.uploader_id),
        width:            Number(record.image_width)
    };
}

export interface PostData {
    animated: boolean;
    animated_png: boolean;
    approver_id: number | null;
    change_seq: number;
    comment_count: number;
    created_at: string;
    description: string;
    down_score: number;
    duration: number | null;
    fav_count: number;
    file_ext: string;
    file_size: number;
    height: number;
    id: number;
    is_deleted: boolean;
    is_flagged: boolean;
    is_note_locked: boolean;
    is_pending: boolean;
    is_rating_locked: boolean;
    is_status_locked: boolean;
    locked_tags: string;
    md5: string | null;
    parent_id: number | null;
    rating: "s" | "q" | "e";
    score: number;
    sources: Array<string>;
    tags: Array<string>;
    up_score: number;
    updated_at: string | null;
    uploader_id: number | null;
    width: number;
}
