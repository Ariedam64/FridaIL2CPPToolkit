import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mountScripts, type ScriptsDeps } from "../../backend/routes/scripts";
import { ScriptValidationError } from "../../backend/core/scripts/script-runner";
import type { ScriptDefinition, RegistryEntry } from "../../backend/core/scripts/types";

const fakeDef = (id: string): ScriptDefinition => ({
    name: id, params: { x: { type: "number", required: true } },
    run: async ({ x }) => `got ${x}`,
});

function makeApp(opts: { running?: boolean; entries?: RegistryEntry[] } = {}) {
    const entries: RegistryEntry[] = opts.entries ?? [
        { id: "echo", filePath: "/p/echo.ts", status: "loaded", definition: { name: "echo", params: { x: { type: "number", required: true } } }, loadedAt: "2026-05-07T00:00:00Z" },
        { id: "broken", filePath: "/p/broken.ts", status: "compile-error", error: "boom", loadedAt: "2026-05-07T00:00:01Z" },
    ];

    const deps: ScriptsDeps = {
        loader: () => ({ list: () => entries, get: (id: string) => entries.find((e) => e.id === id) ?? null, getDefinition: (id: string) => id === "echo" ? fakeDef("echo") : null }) as never,
        runner: () => ({
            start: vi.fn(async (scriptId: string, params: Record<string, unknown>) => ({ runId: "run-1" })),
            isRunning: () => opts.running ?? false,
        }) as never,
    };

    const app = express();
    app.use(express.json());
    mountScripts(app, deps);
    return { app, deps };
}

describe("routes/scripts", () => {
    it("GET /api/scripts returns registry without `run`", async () => {
        const { app } = makeApp();
        const r = await request(app).get("/api/scripts");
        expect(r.status).toBe(200);
        expect(r.body.scripts).toHaveLength(2);
        expect(r.body.scripts[0].definition).not.toHaveProperty("run");
    });

    it("POST /api/scripts/:id/run returns runId", async () => {
        const { app } = makeApp();
        const r = await request(app).post("/api/scripts/echo/run").send({ params: { x: 42 } });
        expect(r.status).toBe(200);
        expect(r.body.runId).toBe("run-1");
    });

    it("POST /api/scripts/:id/run rejects unknown script with 404", async () => {
        const { app } = makeApp();
        const r = await request(app).post("/api/scripts/nope/run").send({ params: {} });
        expect(r.status).toBe(404);
    });

    it("POST /api/scripts/:id/run rejects compile-error script with 422", async () => {
        const { app } = makeApp();
        const r = await request(app).post("/api/scripts/broken/run").send({ params: {} });
        expect(r.status).toBe(422);
    });

    it("POST /api/scripts/:id/run rejects already-running with 409", async () => {
        const { app } = makeApp({ running: true });
        const r = await request(app).post("/api/scripts/echo/run").send({ params: { x: 1 } });
        expect(r.status).toBe(409);
    });

    it("POST /api/scripts/:id/run rejects bad params with 400", async () => {
        const { app, deps } = makeApp();
        deps.runner = () => ({
            start: async () => { throw new ScriptValidationError("missing required param: x"); },
            isRunning: () => false,
        }) as never;
        const r = await request(app).post("/api/scripts/echo/run").send({ params: {} });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/missing required param: x/);
    });

    it("GET /api/scripts returns 200 with empty list when not attached", async () => {
        const deps: ScriptsDeps = { loader: () => null, runner: () => null };
        const app = express();
        app.use(express.json());
        mountScripts(app, deps);
        const r = await request(app).get("/api/scripts");
        expect(r.status).toBe(200);
        expect(r.body.scripts).toEqual([]);
    });

    it("returns 503 when not attached (loader is null)", async () => {
        const deps: ScriptsDeps = {
            loader: () => null,   // not attached
            runner: () => null,
        };
        const app = express();
        app.use(express.json());
        mountScripts(app, deps);
        const r = await request(app).post("/api/scripts/echo/run").send({ params: {} });
        expect(r.status).toBe(503);
        expect(r.body.error).toMatch(/not attached/);
    });
});
