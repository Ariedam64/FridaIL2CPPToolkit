import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Hardcoded known world names — used as a fallback when areas.json has
 * unresolved nameId refs (the runtime DataCenter dump may not include
 * m_name strings for WorldMaps).
 */
const KNOWN_WORLD_NAMES: Record<number, string> = {
    "-1": "Caves",
    1: "Amakna",
    10: "Frigost",
    12: "Otomai",
    13: "Saharach",
    14: "Brakmar",
    15: "Pandala",
    16: "Bonta",
    17: "Astrub",
    18: "Incarnam",
} as Record<number, string>;

const PLACEHOLDER_NAME_RE = /^(#\d+|id-\d+|World \d+)$/;

export interface MapInfoEntry {
    mapId: number; posX: number; posY: number;
    subAreaId: number; worldMap: number;
    nameId: number; name: string;
}

export interface AreasFile {
    areas: Record<string, { id: number; name: string }>;
    subAreas: Record<string, { id: number; areaId: number; name: string }>;
    worlds: Record<string, { id: number; name: string }>;
}

export interface WorldMeta { id: number; name: string; mapCount: number }

export interface WorldMap {
    mapId: number; posX: number; posY: number;
    subAreaId: number; areaId: number; name: string;
}

export interface MapDetail extends WorldMap {
    neighbours: number[];
    cells: Array<[number, number, number, number, number]>;
}

const LRU_MAX = 50;

export class DofusDataStore {
    public dataReady = false;
    private mapsIndex: MapInfoEntry[] = [];
    private areasIndex: AreasFile = { areas: {}, subAreas: {}, worlds: {} };
    private worldsIndex: WorldMeta[] = [];
    private mapsByWorld = new Map<number, WorldMap[]>();
    private mapsById = new Map<number, MapInfoEntry>();
    private detailCache = new Map<number, MapDetail>();   // insertion-order LRU

    constructor(private readonly dataDir: string) {
        try {
            this.mapsIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "maps-information.json"), "utf8"));
            this.areasIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "areas.json"), "utf8"));
            this.indexByWorld();
            this.dataReady = true;
        } catch (err) {
            console.error("[dofus] DofusDataStore failed to load:", (err as Error).message);
        }
    }

    private indexByWorld(): void {
        const counts = new Map<number, number>();
        for (const m of this.mapsIndex) {
            this.mapsById.set(m.mapId, m);
            counts.set(m.worldMap, (counts.get(m.worldMap) ?? 0) + 1);
            const arr = this.mapsByWorld.get(m.worldMap) ?? [];
            const subArea = this.areasIndex.subAreas[String(m.subAreaId)];
            arr.push({
                mapId: m.mapId, posX: m.posX, posY: m.posY,
                subAreaId: m.subAreaId, areaId: subArea?.areaId ?? 0,
                name: m.name,
            });
            this.mapsByWorld.set(m.worldMap, arr);
        }
        this.worldsIndex = Array.from(counts.entries()).map(([id, mapCount]) => {
            const dataName = this.areasIndex.worlds[String(id)]?.name;
            let name: string;
            if (dataName && !PLACEHOLDER_NAME_RE.test(dataName)) {
                name = dataName;
            } else if (KNOWN_WORLD_NAMES[id]) {
                name = KNOWN_WORLD_NAMES[id];
            } else {
                name = `World ${id}`;
            }
            return { id, mapCount, name };
        }).sort((a, b) => a.id - b.id);
    }

    listWorlds(): WorldMeta[] {
        return this.worldsIndex.slice();
    }

    knowsWorld(worldId: number): boolean {
        return this.mapsByWorld.has(worldId);
    }

    listMapsByWorld(worldId: number): WorldMap[] {
        return this.mapsByWorld.get(worldId)?.slice() ?? [];
    }

    async loadMapDetail(mapId: number): Promise<MapDetail | null> {
        const cached = this.detailCache.get(mapId);
        if (cached) {
            // Refresh LRU position
            this.detailCache.delete(mapId);
            this.detailCache.set(mapId, cached);
            return cached;
        }
        const meta = this.mapsById.get(mapId);
        if (!meta) return null;
        const file = path.join(this.dataDir, "maps", `${mapId}.json`);
        if (!fs.existsSync(file)) return null;
        let raw: { n?: number[]; c: Array<[number, number, number, number, number]> };
        try {
            raw = JSON.parse(await fs.promises.readFile(file, "utf8"));
        } catch (err) {
            console.error(`[dofus] failed to read/parse map ${mapId}.json:`, (err as Error).message);
            return null;
        }
        const subArea = this.areasIndex.subAreas[String(meta.subAreaId)];
        const detail: MapDetail = {
            mapId: meta.mapId, posX: meta.posX, posY: meta.posY,
            subAreaId: meta.subAreaId, areaId: subArea?.areaId ?? 0,
            name: meta.name,
            neighbours: raw.n ?? [],
            cells: raw.c,
        };
        // LRU insert + evict oldest if over capacity
        this.detailCache.set(mapId, detail);
        if (this.detailCache.size > LRU_MAX) {
            const oldest = this.detailCache.keys().next().value;
            if (oldest !== undefined) this.detailCache.delete(oldest);
        }
        return detail;
    }
}
