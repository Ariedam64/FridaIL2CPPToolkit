import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.ts";

test("createStore returns initial state via get()", () => {
    const s = createStore({ count: 0 });
    assert.deepEqual(s.get(), { count: 0 });
});

test("set() updates state and notifies subscribers", () => {
    const s = createStore({ count: 0 });
    let received: unknown = null;
    s.subscribe((state) => { received = state; });
    s.set({ count: 5 });
    assert.deepEqual(received, { count: 5 });
});

test("subscribe returns an unsubscribe function", () => {
    const s = createStore({ count: 0 });
    let count = 0;
    const unsub = s.subscribe(() => { count++; });
    s.set({ count: 1 });
    unsub();
    s.set({ count: 2 });
    assert.equal(count, 1);
});

test("update() applies a partial patch", () => {
    const s = createStore<{ a: number; b: number }>({ a: 1, b: 2 });
    s.update({ a: 10 });
    assert.deepEqual(s.get(), { a: 10, b: 2 });
});
