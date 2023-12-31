export interface RawTagAlias {
    antecedent_name: string;
    consequent_name: string;
    created_at: string;
    id: string;
    status: string;
}

export function parse(record: RawTagAlias): TagAliasData {
    return {
        antecedent_name: record.antecedent_name,
        consequent_name: record.consequent_name,
        created_at:      record.created_at === "" ? null : new Date(record.created_at).toISOString(),
        id:              Number(record.id),
        status:          record.status
    };
}

export interface TagAliasData {
    antecedent_name: string;
    consequent_name: string;
    created_at: string | null;
    id: number;
    status: string;
}
