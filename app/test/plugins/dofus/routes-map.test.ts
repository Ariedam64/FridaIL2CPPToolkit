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
        worlds: {
            "1":  { id: 1,  name: "Amakna",
                    dims: { origineX: -85, origineY: -90, mapWidth: 86, mapHeight: 43,
                            totalWidth: 13072, totalHeight: 5418 } },
            "10": { id: 10, name: "Frigost" },
        },
    }));
    fs.writeFileSync(path.join(dir, "tile-mapping.json"), JSON.stringify({
        "1": [
            { index: 0, name: "1", scale: "0.2", address: "0.2/1.jpg",
              guid: "abc", tile: "000422_1.jpg", width: 1024, height: 1024, ambiguous: false },
        ],
    }));
    fs.writeFileSync(path.join(dir, "maps", "100.json"), JSON.stringify({
        mapId: 100, n: [1, 2, 3, 4],
        ie: [[10, 100, 42]],
        c: Array(560).fill([0, 0, 0, 0, 0]),
    }));
    fs.mkdirSync(path.join(dir, "cartography", "tiles"), { recursive: true });
    // Minimum valid JPEG (SOI + EOI markers)
    fs.writeFileSync(path.join(dir, "cartography", "tiles", "000422_1.jpg"),
        Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
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

    it("GET /api/dofus/worlds returns worlds with mapCount + dims when present", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/worlds");
        expect(r.status).toBe(200);
        const w1 = r.body.worlds.find((w: { id: number }) => w.id === 1);
        const w10 = r.body.worlds.find((w: { id: number }) => w.id === 10);
        expect(w1).toMatchObject({ id: 1, name: "Amakna", mapCount: 2 });
        expect(w1.dims).toEqual({
            origineX: -85, origineY: -90, mapWidth: 86, mapHeight: 43,
            totalWidth: 13072, totalHeight: 5418,
        });
        expect(w10).toMatchObject({ id: 10, name: "Frigost", mapCount: 1 });
        expect(w10.dims).toBeUndefined();
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

    it("GET /api/dofus/cartography/tile/000422_1.jpg serves the file", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/cartography/tile/000422_1.jpg");
        expect(r.status).toBe(200);
        expect(r.headers["content-type"]).toMatch(/image\/jpe?g/);
    });

    it("GET /api/dofus/cartography/tile/../etc/passwd → 400", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/cartography/tile/..%2Fetc%2Fpasswd");
        expect(r.status).toBe(400);
    });

    it("GET /api/dofus/cartography/tile/missing.jpg (regex match but not on disk) → 404", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/cartography/tile/999999_1.jpg");
        expect(r.status).toBe(404);
    });

    it("GET /api/dofus/tile-mapping?world=1 returns the tiles slice", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/tile-mapping?world=1");
        expect(r.status).toBe(200);
        expect(r.body.world).toBe(1);
        expect(r.body.tiles).toHaveLength(1);
        expect(r.body.tiles[0].tile).toBe("000422_1.jpg");
    });

    it("GET /api/dofus/tile-mapping (no world) → 400", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/tile-mapping");
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/world/);
    });

    it("GET /api/dofus/tile-mapping?world=99 (unknown world) → 200 with empty tiles", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/tile-mapping?world=99");
        expect(r.status).toBe(200);
        expect(r.body.tiles).toEqual([]);
    });
});
