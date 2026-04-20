// Minimal observable store. No deps.
export interface Store<T> {
    get(): T;
    set(value: T): void;
    update(patch: Partial<T>): void;
    subscribe(fn: (value: T) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
    let state = initial;
    const subs = new Set<(v: T) => void>();
    return {
        get: () => state,
        set: (value: T) => {
            state = value;
            for (const s of subs) { try { s(state); } catch (e) { console.error("[store] subscriber err", e); } }
        },
        update: (patch: Partial<T>) => {
            state = { ...state, ...patch };
            for (const s of subs) { try { s(state); } catch (e) { console.error("[store] subscriber err", e); } }
        },
        subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    };
}
