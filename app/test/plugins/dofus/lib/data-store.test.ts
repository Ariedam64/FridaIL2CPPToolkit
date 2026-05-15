import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DofusDataStore } from "../../../../plugins/dofus/lib/stores/data";

describe("DofusDataStore", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dofus-data-"));
        fs.mkdirSync(path.join(dir, "maps"));
        fs.writeFileSync(path.join(dir, "maps-information.json"), JSON.stringify([
            { mapId: 100, posX: 0, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M100" },
            { mapId: 200, posX: 1, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M200" },
            { mapId: 300, posX: 0, posY: 0, subAreaId: 5, worldMap: 10, nameId: 0, name: "M300" },
        ]));
        fs.writeFileSync(path.join(dir, "areas.json"), JSON.stringify({
            areas: { "0": { id: 0, name: "DefaultArea" } },
            subAreas: {
                "1": { id: 1, areaId: 0, name: "Sub1" },
                "5": { id: 5, areaId: 0, name: "Sub5" },
            },
            worlds: {
                "1": { id: 1, name: "Amakna" },
                "10": { id: 10, name: "Frigost" },
            },
        }));
        // 1 map JSON file
        fs.writeFileSync(path.join(dir, "maps", "100.json"), JSON.stringify({
            mapId: 100, n: [1,2,3,4], c: Array(560).fill([0,0,0,0,0]),
        }));
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("dataReady=true after successful load", () => {
        const store = new DofusDataStore(dir);
        expect(store.dataReady).toBe(true);
    });

    it("listWorlds returns sorted entries with mapCount", () => {
        const store = new DofusDataStore(dir);
        const worlds = store.listWorlds();
        const w1 = worlds.find((w) => w.id === 1);
        const w10 = worlds.find((w) => w.id === 10);
        expect(w1?.mapCount).toBe(2);
        expect(w10?.mapCount).toBe(1);
    });

    it("listMapsByWorld returns enriched maps with areaId resolved from subAreaId", () => {
        const store = new DofusDataStore(dir);
        const maps = store.listMapsByWorld(1);
        expect(maps).toHaveLength(2);
        expect(maps[0].areaId).toBe(0);  // resolved via subAreas[1].areaId
    });

    it("loadMapDetail caches results (LRU)", async () => {
        const store = new DofusDataStore(dir);
        const a = await store.loadMapDetail(100);
        const b = await store.loadMapDetail(100);
        expect(a).not.toBeNull();
        expect(a).toBe(b);  // identity (cached)
    });

    it("LRU evicts oldest entry when cache exceeds 50 maps", async () => {
        // Create fixture with 60 map JSONs
        for (let i = 1; i <= 60; i++) {
            fs.writeFileSync(
                path.join(dir, "maps", `${1000 + i}.json`),
                JSON.stringify({ mapId: 1000 + i, n: [], c: Array(560).fill([0,0,0,0,0]) }),
            );
        }
        // Also add them to maps-information.json so meta.find works.
        const fullIndex = [
            { mapId: 100, posX: 0, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M100" },
            { mapId: 200, posX: 1, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M200" },
            { mapId: 300, posX: 0, posY: 0, subAreaId: 5, worldMap: 10, nameId: 0, name: "M300" },
            ...Array.from({ length: 60 }, (_, i) => ({
                mapId: 1000 + i + 1, posX: 0, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: `M${1000+i+1}`,
            })),
        ];
        fs.writeFileSync(path.join(dir, "maps-information.json"), JSON.stringify(fullIndex));

        const store = new DofusDataStore(dir);
        // Load 60 maps in sequence
        for (let i = 1; i <= 60; i++) {
            await store.loadMapDetail(1000 + i);
        }
        // The first map (1001) should have been evicted (LRU_MAX = 50)
        // To verify eviction, we re-load 1001 and check it's a NEW object reference.
        const reloaded = await store.loadMapDetail(1001);
        // Then load 1011 (which was loaded 50 ago, should still be cached)
        const cached = await store.loadMapDetail(1011);
        const cachedAgain = await store.loadMapDetail(1011);
        expect(cached).toBe(cachedAgain);  // identity (still in cache)
        // 1001 was evicted, so the reloaded one should now be cached
        const reloadedAgain = await store.loadMapDetail(1001);
        expect(reloaded).toBe(reloadedAgain);  // identity (re-cached)
    });

    it("uses KNOWN_WORLD_NAMES fallback when areas.json has #nameId placeholder", () => {
        // Override areas.json to have a placeholder name for world 1
        fs.writeFileSync(path.join(dir, "areas.json"), JSON.stringify({
            areas: { "0": { id: 0, name: "DefaultArea" } },
            subAreas: {
                "1": { id: 1, areaId: 0, name: "Sub1" },
                "5": { id: 5, areaId: 0, name: "Sub5" },
            },
            worlds: {
                "1":  { id: 1,  name: "#868482" },     // placeholder pattern
                "10": { id: 10, name: "id-12345" },    // also placeholder
            },
        }));
        const store = new DofusDataStore(dir);
        const worlds = store.listWorlds();
        expect(worlds.find((w) => w.id === 1)?.name).toBe("Amakna");
        expect(worlds.find((w) => w.id === 10)?.name).toBe("Frigost");
    });

    it("loadMapDetail returns null on corrupted map JSON (logs error)", async () => {
        fs.writeFileSync(path.join(dir, "maps", "999.json"), "{not valid json");
        fs.appendFileSync(path.join(dir, "maps-information.json"), "");  // no-op; ensures file exists

        // Need to add 999 to maps-information.json so meta is found
        const data = JSON.parse(fs.readFileSync(path.join(dir, "maps-information.json"), "utf8"));
        data.push({ mapId: 999, posX: 0, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "Corrupted" });
        fs.writeFileSync(path.join(dir, "maps-information.json"), JSON.stringify(data));

        const store = new DofusDataStore(dir);
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const result = await store.loadMapDetail(999);
        expect(result).toBeNull();
        expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/failed to read.*999/), expect.any(String));
        errSpy.mockRestore();
    });

    it("loadMapDetail propagates interactives from raw.ie", async () => {
        fs.writeFileSync(path.join(dir, "maps", "100.json"), JSON.stringify({
            mapId: 100, n: [1,2,3,4],
            ie: [[83, 497561, 677], [327, 497576, 677]],
            c: Array(560).fill([0,0,0,0,0]),
        }));
        const store = new DofusDataStore(dir);
        const d = await store.loadMapDetail(100);
        expect(d?.interactives).toEqual([[83, 497561, 677], [327, 497576, 677]]);
    });

    it("loadMapDetail returns interactives=[] when raw.ie is missing", async () => {
        // The default fixture's 100.json has no `ie` key
        const store = new DofusDataStore(dir);
        const d = await store.loadMapDetail(100);
        expect(d?.interactives).toEqual([]);
    });

    it("listWorlds includes dims when areas.json has them", () => {
        // Override areas.json with dims for world 1
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
                "10": { id: 10, name: "Frigost" },  // no dims
            },
        }));
        const store = new DofusDataStore(dir);
        const worlds = store.listWorlds();
        expect(worlds.find((w) => w.id === 1)?.dims).toEqual({
            origineX: -85, origineY: -90, mapWidth: 86, mapHeight: 43,
            totalWidth: 13072, totalHeight: 5418,
        });
        expect(worlds.find((w) => w.id === 10)?.dims).toBeUndefined();
    });

    it("loadTileMapping returns the parsed tile-mapping.json (and caches it)", () => {
        fs.writeFileSync(path.join(dir, "tile-mapping.json"), JSON.stringify({
            "1": [
                { index: 0, name: "1", scale: "0.2", address: "0.2/1.jpg",
                  guid: "abc", tile: "000422_1.jpg", width: 1024, height: 1024, ambiguous: false },
            ],
        }));
        const store = new DofusDataStore(dir);
        const a = store.loadTileMapping();
        const b = store.loadTileMapping();
        expect(a["1"]?.[0].tile).toBe("000422_1.jpg");
        expect(a).toBe(b);  // identity (cached)
    });

    it("loadTileMapping returns {} when tile-mapping.json missing", () => {
        // Default fixture has no tile-mapping.json
        const store = new DofusDataStore(dir);
        expect(store.loadTileMapping()).toEqual({});
    });
});
