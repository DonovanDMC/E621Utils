// the parts of bun:sqlite that are used, bun-types conflicts with the node types
declare module "bun:sqlite" {
    type Binding = string | number | bigint | boolean | null;
    export class Statement<T = unknown> {
        all(...params: Array<Binding>): Array<T>;
        get(...params: Array<Binding>): T | null;
        run(...params: Array<Binding>): void;
    }
    export class Database {
        constructor(filename: string, options?: { create?: boolean; strict?: boolean; });
        close(): void;
        query<T = unknown>(sql: string): Statement<T>;
        run(sql: string): void;
        transaction<A extends Array<unknown>>(fn: (...args: A) => void): (...args: A) => void;
    }
}
