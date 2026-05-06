// app/test/frontend/store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../../frontend/core/store.js";

interface S { count: number; name: string; }

let store: Store<S>;
beforeEach(() => { store = new Store<S>({ count: 0, name: "" }); });

describe("Store", () => {
    it("returns initial state", () => {
        expect(store.get()).toEqual({ count: 0, name: "" });
    });

    it("notifies subscribers on update", () => {
        let seen: S | null = null;
        store.subscribe((s) => { seen = s; });
        store.update({ count: 5 });
        expect(seen).toEqual({ count: 5, name: "" });
    });

    it("merges partial updates", () => {
        store.update({ count: 1 });
        store.update({ name: "x" });
        expect(store.get()).toEqual({ count: 1, name: "x" });
    });

    it("unsubscribes cleanly", () => {
        let calls = 0;
        const off = store.subscribe(() => calls++);
        store.update({ count: 1 });
        off();
        store.update({ count: 2 });
        expect(calls).toBe(1);
    });

    it("does not call subscribers on no-op update", () => {
        let calls = 0;
        store.subscribe(() => calls++);
        store.update({ count: 0 });
        expect(calls).toBe(0);
    });
});
