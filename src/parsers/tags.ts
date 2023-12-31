export interface RawTag {
    category: string;
    id: string;
    name: string;
    post_count: string;
}

export function parse(record: RawTag): TagData {
    return {
        category:   Number(record.category),
        id:         Number(record.id),
        name:       record.name,
        post_count: Number(record.post_count)
    };
}

export interface TagData {
    category: number;
    id: number;
    name: string;
    post_count: number;
}
