import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { DiskPluginStorage } from "../../../src/core/plugin-storage";
import { HookStore } from "../../../src/plugins/hooks/hook-store";
import type { HookSpec } from "../../../src/plugins/hooks/types";

interface FakeRpc { calls: Array<{ method: string; args: unknown[] }>; nextHookId: number; }

function makeFakeRpc(): { rpc: { call<T>(m: string, a?: unknown[]): Promise<T> }; state: FakeRpc } {
    const state: FakeRpc = { calls: [], nextHookId: 1 };
    return {
        state,
        rpc: {
            call: async <T,>(method: string, args: unknown[] = []): Promise<T> => {
                state.calls.push({ method, args });
                if (method === "installHook") {
                    return { hookId: `h${state.nextHookId++}` } as unknown as T;
                }
                if (method === "revertHook") {
                    return { reverted: true } as unknown as T;
                }
                return undefined as unknown as T;
            },
        },
    };
}

const SPEC: HookSpec = { template: "log", className: "ecu", methodName: "xbe" };

let tmpRoot: string;
let storage: DiskPluginStorage;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-store-"));
    storage = new DiskPluginStorage(tmpRoot, "hooks");
});

describe("HookStore", () => {
    it("starts empty", () => {
        const { rpc } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        expect(store.list()).toEqual([]);
    });

    it("add() persists and returns a StoredHook with id", () => {
        const { rpc } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(stored.installedHookId).toBeNull();
        expect(stored.spec).toEqual(SPEC);

        // reload from disk → still there
        const store2 = new HookStore(storage, rpc);
        expect(store2.list()).toHaveLength(1);
        expect(store2.list()[0].spec).toEqual(SPEC);
        expect(store2.list()[0].installedHookId).toBeNull();  // disarmed at reload
    });

    it("install() calls RPC and stores the agent-assigned hookId", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);

        await store.install(stored.id);

        expect(state.calls[0]).toEqual({ method: "installHook", args: [SPEC] });
        const after = store.list()[0];
        expect(after.installedHookId).toBe("h1");
    });

    it("uninstall() reverts agent-side and clears installedHookId", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        await store.install(stored.id);
        await store.uninstall(stored.id);

        expect(state.calls[1]).toEqual({ method: "revertHook", args: ["h1"] });
        expect(store.list()[0].installedHookId).toBeNull();
    });

    it("update() replaces the spec; if installed, re-installs with new spec", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        await store.install(stored.id);
        const newSpec: HookSpec = { template: "noop", className: "ecu", methodName: "xbe" };

        await store.update(stored.id, newSpec);

        // sequence: install(spec) → revert(h1) → install(newSpec) returns h2
        expect(state.calls.map(c => c.method)).toEqual(["installHook", "revertHook", "installHook"]);
        expect(store.list()[0].spec).toEqual(newSpec);
        expect(store.list()[0].installedHookId).toBe("h2");
    });

    it("update() while disarmed only swaps the spec — no RPC", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        const newSpec: HookSpec = { template: "noop", className: "ecu", methodName: "xbe" };

        await store.update(stored.id, newSpec);
        expect(state.calls).toHaveLength(0);
        expect(store.list()[0].spec).toEqual(newSpec);
    });

    it("remove() reverts if installed and persists removal", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        await store.install(stored.id);

        await store.remove(stored.id);

        expect(state.calls.map(c => c.method)).toEqual(["installHook", "revertHook"]);
        expect(store.list()).toEqual([]);
        const reloaded = new HookStore(storage, rpc);
        expect(reloaded.list()).toEqual([]);
    });

    it("uninstallAll() reverts every installed hook", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const a = store.add({ ...SPEC, methodName: "ma" });
        const b = store.add({ ...SPEC, methodName: "mb" });
        await store.install(a.id);
        await store.install(b.id);

        await store.uninstallAll();

        expect(state.calls.filter(c => c.method === "revertHook")).toHaveLength(2);
        expect(store.list().every(h => h.installedHookId === null)).toBe(true);
    });

    it("emits onChange after add / install / update / uninstall / remove", async () => {
        const { rpc } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        let count = 0;
        store.onChange(() => count++);
        const stored = store.add(SPEC);
        await store.install(stored.id);
        await store.update(stored.id, { ...SPEC, template: "noop" });
        await store.uninstall(stored.id);
        await store.remove(stored.id);
        expect(count).toBe(5);
    });
});
