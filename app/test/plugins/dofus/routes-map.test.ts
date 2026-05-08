import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
import { mount as mountDofusRoutes } from "../../../plugins/dofus/routes/index";
import type { PluginBackendDeps } from "../../../backend/plugins/registry";

const fakeSession = {
    instanceRegistry: () => null,
    fridaClient: { call: async () => null },
} as never;

function makeFixtureDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dofus-routes-"));
    fs.mkdirSync(path.join(dir, "maps"));
    fs.writeFileSync(path.join(dir, "maps-information.json"), JSON.stringify([
        { mapId: 100, posX: 0, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M100" },
        { mapId: 200, posX: 1, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M200" },
        { mapId: 300, posX: 0, posY: 0, subAreaId: 5, worldMap: 10, nameId: 0, name: "M300" },
    ]));
    fs.writeFileSync(path.join(dir, "areas.json"), JSON.stringify({
        areas: { "0": { id: 0, name: "A0" } },
        subAreas: {
            "1": { id: 1, areaId: 0, name: "Sub1" },
            "5": { id: 5, areaId: 0, name: "Sub5" },
        },
        worlds: { "1": { id: 1, name: "Amakna" }, "10": { id: 10, name: "Frigost" } },
    }));
    fs.writeFileSync(path.join(dir, "maps", "100.json"), JSON.stringify({
        mapId: 100, n: [1, 2, 3, 4],
        ie: [[10, 100, 42]],
        c: Array(560).fill([0, 0, 0, 0, 0]),
    }));
    return dir;
}

function buildApp(dataDir: string): express.Express {
    const app = express();
    app.use(express.json());
    mountDofusRoutes(app, { session: fakeSession } as PluginBackendDeps, { dataDir });
    return app;
}

describe("dofus routes — map feature", () => {
    let dataDir: string;

    beforeEach(() => { dataDir = makeFixtureDir(); });
    afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

    it("GET /api/dofus/worlds returns worlds with mapCount", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/worlds");
        expect(r.status).toBe(200);
        expect(r.body.worlds).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 1, name: "Amakna", mapCount: 2 }),
            expect.objectContaining({ id: 10, name: "Frigost", mapCount: 1 }),
        ]));
    });

    it("GET /api/dofus/maps/list?world=1 returns the maps for world 1", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/list?world=1");
        expect(r.status).toBe(200);
        expect(r.body.world).toBe(1);
        expect(r.body.maps).toHaveLength(2);
    });

    it("GET /api/dofus/maps/list (missing world) → 400", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/list");
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/world/);
    });

    it("GET /api/dofus/maps/list?world=99 (unknown world) → 404", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/list?world=99");
        expect(r.status).toBe(404);
        expect(r.body.error).toMatch(/unknown world/);
    });

    it("GET /api/dofus/maps/100 returns cells + neighbours + interactives", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/100");
        expect(r.status).toBe(200);
        expect(r.body.mapId).toBe(100);
        expect(r.body.cells).toHaveLength(560);
        expect(r.body.neighbours).toEqual([1, 2, 3, 4]);
        expect(r.body.interactives).toEqual([[10, 100, 42]]);
    });

    it("GET /api/dofus/maps/200 (no JSON file) → 404", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/200");
        expect(r.status).toBe(404);
    });
});
