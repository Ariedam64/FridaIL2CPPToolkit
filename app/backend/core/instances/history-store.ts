import type { HistoryEntry } from "./types";

type Listener = () => void;

export class HistoryStore {
    private static readonly MAX = 50;
    private entries: HistoryEntry[] = [];
    private listeners: Listener[] = [];

    append(entry: HistoryEntry): void {
        this.entries.push(entry);
        if (this.entries.length > HistoryStore.MAX) {
            this.entries.splice(0, this.entries.length - HistoryStore.MAX);
        }
        this.emit();
    }

    list(): HistoryEntry[] {
        return this.entries.slice().reverse();
    }

    clear(): void {
        if (this.entries.length === 0) return;
        this.entries.length = 0;
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
}
