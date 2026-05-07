import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DofusDataStore } from "../../../../plugins/dofus/lib/data-store";

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
});
