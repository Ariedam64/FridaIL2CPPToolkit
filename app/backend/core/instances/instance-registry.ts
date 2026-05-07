import type { CapturedInstance, RecipeStep } from "./types";

type Listener = () => void;

export class InstanceRegistry {
    private entries = new Map<string, CapturedInstance>();
    private listeners: Listener[] = [];

    set(key: string, className: string, handle: string, via: RecipeStep["op"]): void {
        this.entries.set(key, {
            key, className, handle,
            capturedAt: new Date().toISOString(),
            capturedVia: via,
            isAlive: true,
        });
        this.emit();
    }

    get(key: string): CapturedInstance | null {
        return this.entries.get(key) ?? null;
    }

    list(): CapturedInstance[] {
        return Array.from(this.entries.values());
    }

    delete(key: string): void {
        if (this.entries.delete(key)) this.emit();
    }

    clear(): void {
        if (this.entries.size === 0) return;
        this.entries.clear();
        this.emit();
    }

    setAlive(key: string, alive: boolean): void {
        const entry = this.entries.get(key);
        if (!entry || entry.isAlive === alive) return;
        entry.isAlive = alive;
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
