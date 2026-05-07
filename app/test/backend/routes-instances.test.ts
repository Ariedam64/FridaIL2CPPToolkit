import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mountInstances } from "../../backend/routes/instances.js";
import { InstanceRegistry } from "../../backend/core/instances/instance-registry.js";
import { HistoryStore } from "../../backend/core/instances/history-store.js";
import { RecipeStore } from "../../backend/core/instances/recipe-store.js";
import { DiskPluginStorage } from "../../backend/core/plugin-storage.js";

interface AgentMock {
    [k: string]: (...args: any[]) => Promise<any>;
}

function buildApp(opts: { agent?: AgentMock; readOnly?: boolean } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-instances-"));
    const registry = new InstanceRegistry();
    const history = new HistoryStore();
    const storage = new DiskPluginStorage(tmpDir, "instances");
    const recipes = new RecipeStore(storage);
    let readOnly = opts.readOnly ?? true;
    const session: any = {
        instanceRegistry: () => registry,
        historyStore: () => history,
        recipeStore: () => recipes,
        agentCall: async (method: string, args: unknown[]) => {
            const fn = opts.agent?.[method];
            if (!fn) throw new Error(`agent mock missing: ${method}`);
            return fn(...(args ?? []));
        },
        getReadOnly: () => readOnly,
        setReadOnly: (v: boolean) => { readOnly = v; },
        emit: () => {},
    };
    const app = express();
    app.use(express.json());
    mountInstances(app, { session });
    return { app, registry, history, recipes, session };
}

describe("instances routes — list / capture / delete", () => {
    it("GET /api/instances/list returns the registry", async () => {
        const { app, registry } = buildApp();
        registry.set("player", "Player", "0x1", "captureViaGC");
        const res = await request(app).get("/api/instances/list");
        expect(res.status).toBe(200);
        expect(res.body.instances).toHaveLength(1);
        expect(res.body.instances[0].key).toBe("player");
    });

    it("POST /api/instances/capture (via GC) calls agent and stores in registry", async () => {
        const { app, registry } = buildApp({
            agent: { captureViaGC: async (className: string, index: number) => `${className}@0xABC[${index}]` },
        });
        const res = await request(app)
            .post("/api/instances/capture")
            .send({ op: "captureViaGC", className: "Player", index: 0, asKey: "player" });
        expect(res.status).toBe(200);
        expect(res.body.key).toBe("player");
        expect(registry.get("player")).not.toBeNull();
    });

    it("POST /api/instances/capture (via Hook) calls agent.capture", async () => {
        const { app, registry } = buildApp({
            agent: { capture: async (className: string, tickMethod: string) => `${className}@0xHK_${tickMethod}` },
        });
        const res = await request(app)
            .post("/api/instances/capture")
            .send({ op: "captureViaHook", className: "Player", tickMethod: "Update", timeoutMs: 5000, asKey: "p" });
        expect(res.status).toBe(200);
        expect(registry.get("p")).not.toBeNull();
    });

    it("POST /api/instances/capture (chain field) calls agent and stores", async () => {
        const { app, registry } = buildApp({
            agent: { captureFieldValue: async () => "Inv@0xFV" },
        });
        registry.set("player", "Player", "0x1", "captureViaGC");
        const res = await request(app)
            .post("/api/instances/capture")
            .send({ op: "captureFieldValue", ownerKey: "player", fieldName: "inv", asKey: "inv" });
        expect(res.status).toBe(200);
        expect(registry.get("inv")).not.toBeNull();
    });

    it("POST /api/instances/capture rejects unknown op with 400", async () => {
        const { app } = buildApp();
        const res = await request(app).post("/api/instances/capture").send({ op: "wat" });
        expect(res.status).toBe(400);
    });

    it("DELETE /api/instances/:key removes from registry", async () => {
        const { app, registry } = buildApp();
        registry.set("p", "P", "0x1", "captureViaGC");
        const res = await request(app).delete("/api/instances/p");
        expect(res.status).toBe(200);
        expect(registry.get("p")).toBeNull();
    });

    it("DELETE /api/instances/:key returns 404 for missing key", async () => {
        const { app } = buildApp();
        const res = await request(app).delete("/api/instances/missing");
        expect(res.status).toBe(404);
    });
});

describe("instances routes — read / write / call", () => {
    it("POST /api/instances/:key/read-fields returns FieldRead[]", async () => {
        const { app, registry } = buildApp({
            agent: {
                readAllFieldsStructured: async () => [
                    { name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true },
                    { name: "name",   typeName: "String", kind: "string", preview: '"foo"', rawValue: "foo", isWritable: true },
                ],
            },
        });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/read-fields");
        expect(res.status).toBe(200);
        expect(res.body.alive).toBe(true);
        expect(res.body.fields).toHaveLength(2);
    });

    it("POST /api/instances/:key/read-fields → 404 if key missing", async () => {
        const { app } = buildApp();
        const res = await request(app).post("/api/instances/missing/read-fields");
        expect(res.status).toBe(404);
    });

    it("POST /api/instances/:key/write-field requires Read-Only OFF", async () => {
        const { app, registry } = buildApp({ readOnly: true });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/write-field").send({ fieldName: "health", value: 9999 });
        expect(res.status).toBe(403);
    });

    it("POST /api/instances/:key/write-field happy path snapshots before/after + history", async () => {
        const reads: any[] = [];
        const { app, registry, history } = buildApp({
            readOnly: false,
            agent: {
                readField: async (_k: string, fieldName: string) => { reads.push(fieldName); return reads.length === 1 ? "100" : "9999"; },
                writeField: async () => "9999",
            },
        });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/write-field").send({ fieldName: "health", value: 9999 });
        expect(res.status).toBe(200);
        expect(res.body.before).toBe("100");
        expect(res.body.after).toBe("9999");
        const entries = history.list();
        expect(entries).toHaveLength(1);
        expect(entries[0].action).toBe("write");
        expect(entries[0].before).toBe("100");
        expect(entries[0].after).toBe("9999");
    });

    it("POST /api/instances/:key/call requires Read-Only OFF", async () => {
        const { app, registry } = buildApp({ readOnly: true });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/call").send({ methodName: "Heal", args: [] });
        expect(res.status).toBe(403);
    });

    it("POST /api/instances/:key/call happy path returns result + history entry", async () => {
        const { app, registry, history } = buildApp({
            readOnly: false,
            agent: { callInstance: async () => "void" },
        });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/call").send({ methodName: "Heal", args: [] });
        expect(res.status).toBe(200);
        expect(res.body.result).toBe("void");
        const entries = history.list();
        expect(entries).toHaveLength(1);
        expect(entries[0].action).toBe("call");
        expect(entries[0].callResult).toBe("void");
    });
});
