// app/test/backend/routes-hooks.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiskPluginStorage } from "../../backend/core/plugin-storage.js";
import { HookStore } from "../../backend/core/hooks/hook-store.js";
import { mountHooks } from "../../backend/routes/hooks.js";

function fakeRpc(state: { calls: any[]; nextHookId: number }) {
    return {
        async call<T>(method: string, args: unknown[] = []): Promise<T> {
            state.calls.push({ method, args });
            if (method === "installHook") return { hookId: `h${state.nextHookId++}` } as T;
            if (method === "revertHook") return { reverted: true } as T;
            if (method === "clearAllHooks") return { count: 0 } as T;
            return undefined as T;
        },
    };
}

let tmpDir: string;
let store: HookStore;
let state: { calls: any[]; nextHookId: number };
let app: express.Express;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-routes-"));
    state = { calls: [], nextHookId: 1 };
    store = new HookStore(new DiskPluginStorage(tmpDir, "hooks"), fakeRpc(state));
    app = express();
    app.use(express.json());
    const session = {
        hookStore: () => store,
        fridaClient: fakeRpc(state),
    };
    mountHooks(app, { session: session as any });
});

describe("hooks routes", () => {
    const SPEC = { template: "log", className: "ecu", methodName: "xbe" };

    it("POST /api/hooks/add stores a hook", async () => {
        const res = await request(app).post("/api/hooks/add").send({ spec: SPEC });
        expect(res.status).toBe(200);
        expect(res.body.stored.spec).toEqual(SPEC);
        expect(store.list()).toHaveLength(1);
    });

    it("POST /api/hooks/install routes through the store", async () => {
        const stored = store.add(SPEC);
        const res = await request(app).post("/api/hooks/install").send({ id: stored.id });
        expect(res.status).toBe(200);
        expect(state.calls.find(c => c.method === "installHook")).toBeTruthy();
    });

    it("POST /api/hooks/uninstall reverts", async () => {
        const stored = store.add(SPEC);
        await store.install(stored.id);
        await request(app).post("/api/hooks/uninstall").send({ id: stored.id });
        expect(state.calls.find(c => c.method === "revertHook")).toBeTruthy();
    });

    it("POST /api/hooks/remove deletes from disk", async () => {
        const stored = store.add(SPEC);
        await request(app).post("/api/hooks/remove").send({ id: stored.id });
        expect(store.list()).toHaveLength(0);
    });

    it("GET /api/hooks lists all hooks", async () => {
        store.add(SPEC);
        const res = await request(app).get("/api/hooks");
        expect(res.body.hooks).toHaveLength(1);
    });

    it("POST /api/hooks/add validates the spec", async () => {
        const res = await request(app).post("/api/hooks/add")
            .send({ spec: { template: "garbage", className: "x", methodName: "y" } });
        expect(res.status).toBe(400);
    });
});
