// Persisted set of muted class names. Used by the network sidebar (toggle UI)
// and the stream filter (hide rows). Reactive so both views stay in sync.

const KEY = "frida.network.muted.classes";

type Listener = (set: Set<string>) => void;

class MuteStore {
    private set: Set<string>;
    private listeners: Listener[] = [];

    constructor() {
        let initial: string[] = [];
        try {
            const raw = localStorage.getItem(KEY);
            if (raw) initial = JSON.parse(raw);
            if (!Array.isArray(initial)) initial = [];
        } catch { initial = []; }
        this.set = new Set(initial.filter((s) => typeof s === "string"));
    }

    has(className: string): boolean { return this.set.has(className); }
    list(): string[] { return [...this.set]; }
    size(): number { return this.set.size; }

    toggle(className: string): boolean {
        if (this.set.has(className)) this.set.delete(className);
        else this.set.add(className);
        this.persist();
        this.emit();
        return this.set.has(className);
    }

    add(className: string): void {
        if (this.set.has(className)) return;
        this.set.add(className);
        this.persist();
        this.emit();
    }

    clear(): void {
        if (this.set.size === 0) return;
        this.set.clear();
        this.persist();
        this.emit();
    }

    onChange(cb: Listener): () => void {
        this.listeners.push(cb);
        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private persist(): void {
        try { localStorage.setItem(KEY, JSON.stringify([...this.set])); } catch {}
    }
    private emit(): void {
        const snap = new Set(this.set);
        for (const l of this.listeners) try { l(snap); } catch {}
    }
}

export const muteStore = new MuteStore();
