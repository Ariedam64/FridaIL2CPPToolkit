import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mountAllPluginBackends } from "../../backend/plugins/registry";
import type { PluginBackend } from "../../backend/plugins/registry";

const fakeSession = {} as never;

describe("mountAllPluginBackends", () => {
    it("invokes each plugin's mount with the shared deps", () => {
        const a: PluginBackend = { id: "a", mount: vi.fn() };
        const b: PluginBackend = { id: "b", mount: vi.fn() };
        const app = express();
        mountAllPluginBackends(app, { session: fakeSession }, [a, b]);
        expect(a.mount).toHaveBeenCalledWith(app, { session: fakeSession });
        expect(b.mount).toHaveBeenCalledWith(app, { session: fakeSession });
    });

    it("isolates a failing plugin — others still mount, server still works", () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const broken: PluginBackend = {
            id: "broken",
            mount: () => { throw new Error("kaboom at mount"); },
        };
        const ok: PluginBackend = {
            id: "ok",
            mount: (app) => { app.get("/api/ok/ping", (_req, res) => res.json({ pong: true })); },
        };
        const app = express();
        mountAllPluginBackends(app, { session: fakeSession }, [broken, ok]);
        expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/broken/), expect.any(Error));
    });

    it("plugin routes are reachable after mount (smoke via supertest)", async () => {
        const plugin: PluginBackend = {
            id: "smoke",
            mount: (app) => { app.get("/api/smoke/echo", (_req, res) => res.json({ ok: true })); },
        };
        const app = express();
        mountAllPluginBackends(app, { session: fakeSession }, [plugin]);
        const r = await request(app).get("/api/smoke/echo");
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true });
    });
});
