type TF = "t" | "f";
export interface RawPool {
    category: "series" | "collection";
    created_at: string;
    creator_id: string;
    description: string;
    id: string;
    is_active: TF;
    name: string;
    post_ids: string;
    updated_at: string;
}

export function parse(record: RawPool): PoolData {
    return {
        category:    record.category,
        created_at:  new Date(record.created_at).toISOString(),
        creator_id:  Number(record.creator_id),
        description: record.description,
        id:          Number(record.id),
        is_active:   record.is_active === "t",
        name:        record.name,
        // they're in the raw postgres array format ({1,2,3})
        post_ids:    record.post_ids.slice(1, -1),
        updated_at:  record.updated_at === "" ? null : new Date(record.updated_at).toISOString()
    };
}

export interface PoolData {
    category: "series" | "collection";
    created_at: string;
    creator_id: number;
    description: string;
    id: number;
    is_active: boolean;
    name: string;
    post_ids: string;
    updated_at: string | null;
}
