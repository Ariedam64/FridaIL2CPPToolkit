import type { PluginStorage } from "../plugin-storage.js";
import type { SerializerConfig, SerializerEntry } from "./types.js";

const STORAGE_KEY = "serializer-config";

export interface EntryRef {
    className: string;
    methodName: string;
    direction: "send" | "recv";
    ns?: string | null;  // optional — when provided, refines the match
}

type Listener = () => void;

export class SerializerConfigStore {
    private cfg: SerializerConfig;
    private listeners: Listener[] = [];

    constructor(private readonly storage: PluginStorage) {
        const raw = storage.get<SerializerConfig>(STORAGE_KEY);
        if (raw && raw.schemaVersion === 1 && Array.isArray(raw.entries)) {
            this.cfg = { schemaVersion: 1, entries: raw.entries.map(sanitize) };
        } else {
            this.cfg = { schemaVersion: 1, entries: [] };
        }
    }

    get(): SerializerConfig {
        return { schemaVersion: 1, entries: this.cfg.entries.map((e) => ({ ...e })) };
    }

    add(entry: SerializerEntry): void {
        this.cfg.entries.push(sanitize(entry));
        this.persist();
        this.emit();
    }

    remove(ref: EntryRef): void {
        const before = this.cfg.entries.length;
        this.cfg.entries = this.cfg.entries.filter((e) => !match(e, ref));
        if (this.cfg.entries.length !== before) {
            this.persist();
            this.emit();
        }
    }

    replace(entries: SerializerEntry[]): void {
        this.cfg.entries = entries.map(sanitize);
        this.persist();
        this.emit();
    }

    setDisabled(ref: EntryRef, disabled: boolean): void {
        const e = this.cfg.entries.find((x) => match(x, ref));
        if (!e) return;
        if (e.disabled === disabled) return;
        e.disabled = disabled;
        this.persist();
        this.emit();
    }

    markStale(ref: EntryRef, stale: boolean): void {
        const e = this.cfg.entries.find((x) => match(x, ref));
        if (!e) return;
        if (e.stale === stale) return;
        e.stale = stale;
        if (!stale) e.lastValidatedAt = new Date().toISOString();
        this.persist();
        this.emit();
    }

    onChange(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* swallow */ }
        }
    }

    private persist(): void {
        this.storage.set(STORAGE_KEY, this.cfg);
    }
}

function match(e: SerializerEntry, ref: EntryRef): boolean {
    if (e.className !== ref.className) return false;
    if (e.methodName !== ref.methodName) return false;
    if (e.direction !== ref.direction) return false;
    if (ref.ns !== undefined && e.ns !== ref.ns) return false;
    return true;
}

function sanitize(e: SerializerEntry): SerializerEntry {
    return {
        source: e.source === "auto" ? "auto" : "manual",
        direction: e.direction === "recv" ? "recv" : "send",
        className: String(e.className ?? ""),
        ns: e.ns == null ? null : String(e.ns),
        methodName: String(e.methodName ?? ""),
        methodSignature: String(e.methodSignature ?? ""),
        paramIndex: typeof e.paramIndex === "number" ? e.paramIndex : undefined,
        outputListIndex: typeof e.outputListIndex === "number" ? e.outputListIndex : undefined,
        disabled: e.disabled === true ? true : undefined,
        stale: e.stale === true ? true : undefined,
        addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
        lastValidatedAt: typeof e.lastValidatedAt === "string" ? e.lastValidatedAt : undefined,
    };
}
