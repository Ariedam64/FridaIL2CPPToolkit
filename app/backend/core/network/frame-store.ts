import { EventEmitter } from "node:events";
import type { NetworkFrame, TypeKey } from "./types.js";
import { sameTypeKey } from "./types.js";

export interface ListOpts {
    limit?: number;
    sinceId?: string;
    filter?: string;
    direction?: "in" | "out";
}

export class FrameStore extends EventEmitter {
    private ring: (NetworkFrame | undefined)[];
    private head = 0;     // next write index
    private size = 0;     // number of valid entries currently in the ring
    private nextSeq = 0;
    private readonly capacity: number;

    constructor(capacity: number) {
        super();
        if (capacity <= 0) throw new Error("capacity must be > 0");
        this.capacity = capacity;
        this.ring = new Array(capacity);
    }

    push(partial: Omit<NetworkFrame, "id">): NetworkFrame {
        const frame: NetworkFrame = { id: `f-${this.nextSeq++}`, ...partial };
        this.ring[this.head] = frame;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) this.size++;
        this.emit("frame-added", frame);
        return frame;
    }

    /**
     * Returns frames in oldest-to-newest order (chronological).
     * Filters are AND-combined.
     */
    list(opts: ListOpts = {}): NetworkFrame[] {
        const out: NetworkFrame[] = [];
        const tail = this.size < this.capacity ? 0 : this.head;
        for (let i = 0; i < this.size; i++) {
            const idx = (tail + i) % this.capacity;
            const f = this.ring[idx];
            if (!f) continue;
            if (opts.direction && f.direction !== opts.direction) continue;
            if (opts.filter) {
                const needle = opts.filter.toLowerCase();
                const hay = `${f.typeKey.ns ?? ""}.${f.typeKey.className}`.toLowerCase();
                if (!hay.includes(needle)) continue;
            }
            if (opts.sinceId !== undefined) {
                const sinceSeq = parseInt(opts.sinceId.replace(/^f-/, ""), 10);
                const fSeq = parseInt(f.id.replace(/^f-/, ""), 10);
                if (!(fSeq > sinceSeq)) continue;
            }
            out.push(f);
        }
        if (opts.limit !== undefined && out.length > opts.limit) {
            return out.slice(out.length - opts.limit);
        }
        return out;
    }

    byType(key: TypeKey, limit: number): NetworkFrame[] {
        const out: NetworkFrame[] = [];
        for (const f of this.list()) {
            if (sameTypeKey(f.typeKey, key)) out.push(f);
        }
        return out.slice(-limit);
    }

    clear(): void {
        this.ring = new Array(this.capacity);
        this.head = 0;
        this.size = 0;
        this.emit("cleared");
    }

    count(): number {
        return this.size;
    }

    snapshotAll(): NetworkFrame[] {
        return this.list();
    }
}
