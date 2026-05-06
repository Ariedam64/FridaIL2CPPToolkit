// app/frontend/core/store.ts
type Listener<S> = (state: S) => void;

export class Store<S extends object> {
    private state: S;
    private listeners = new Set<Listener<S>>();

    constructor(initial: S) { this.state = { ...initial }; }

    get(): S { return this.state; }

    update(patch: Partial<S>): void {
        let changed = false;
        for (const k of Object.keys(patch) as (keyof S)[]) {
            if (this.state[k] !== patch[k]) {
                changed = true;
                break;
            }
        }
        if (!changed) return;
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners) {
            try { l(this.state); } catch (e) { console.error(e); }
        }
    }

    subscribe(fn: Listener<S>): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}
