import { setTimeout } from "node:timers/promises";

export default class RequestQueue {
    private static processing = false;
    private static queue: Array<{ exec(this: void): Promise<unknown>; reject(this: void, reason?: unknown): void; resolve(this: void, value?: unknown): void; }> = [];

    private static async run() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        const start = Date.now();
        const entry = this.queue.shift();
        if (entry) {
            await entry.exec().then(entry.resolve, entry.reject);
            const time = Date.now() - start;
            const diff = Math.max(0, 700 - time);
            if (diff > 0) {
                await setTimeout(diff);
            }
        }
        this.processing = false;
        void this.run();
    }

    static async add<T = unknown>(exec: (this: void) => Promise<T>) {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ exec, reject, resolve });
            void this.run();
        });
    }
}
