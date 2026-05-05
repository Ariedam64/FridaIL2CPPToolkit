// Map state RPCs — minimal surface used by the travel panel and the
// zaap helpers. Reads the Dofus runtime's MapRenderer + the DataCenter
// catalog for static map/interactive lookups.
import "frida-il2cpp-bridge";
import { findClassExact as findClass } from "../lib/search";
import { getSingleton } from "./singleton-cache";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

export interface MapCell {
    id: number;
    mov: boolean;
    los: boolean;
    speed: number;
    floor: number;
    arrow: number;
    red: boolean;
    blue: boolean;
    mapChangeData: number;
    nonWalkableRp: boolean;
    nonWalkableFight: boolean;
    farmCell: boolean;
    visible: boolean;
    havenbagCell: boolean;
}

export interface MapState {
    mapId: number;
    posX: number;
    posY: number;
    subAreaId: number;
    worldMap: number;
    nameId: number;
    name?: string;
    neighbors: { top: number; bottom: number; left: number; right: number };
    arrowCells: { top: number[]; bottom: number[]; left: number[]; right: number[] };
    cells: MapCell[];
}

function readListInt32(list: any): number[] {
    const out: number[] = [];
    if (!list) return out;
    try {
        const count = list.method("get_Count").invoke() as number;
        for (let i = 0; i < count; i++) {
            try { out.push(Number(list.method("get_Item").invoke(i))); } catch {}
        }
    } catch {}
    return out;
}

function getRenderer(): Il2Cpp.Object | null {
    return getSingleton("MapRenderer");
}

/** Fast current-map id read. <1ms after first call. Used by plan arrival polling. */
export function getCurrentMapId(): Promise<number | null> {
    return inVm(() => {
        const r = getRenderer();
        if (!r) return null;
        try { return Number(r.field("cywa").value); } catch { return null; }
    });
}

/** Read the full current-map state in one round-trip. 10-50ms. */
export function getMapState(): Promise<MapState | null> {
    return inVm(() => {
        const renderer = getRenderer();
        if (!renderer) return null;

        let mapInfo: any = null, mapMeta: any = null;
        try { mapInfo = renderer.field("cywh").value; } catch {}
        try { mapMeta = renderer.field("cywo").value; } catch {}
        if (!mapMeta) { try { mapMeta = renderer.field("cyvz").value; } catch {} }
        if (!mapInfo || !mapMeta) return null;

        const mapId = Number(renderer.field("cywa").value);
        const posX = Number(mapInfo.field("posX").value);
        const posY = Number(mapInfo.field("posY").value);
        const subAreaId = Number(mapInfo.field("subAreaId").value);
        const worldMap = Number(mapInfo.field("worldMap").value);
        const nameId = Number(mapInfo.field("nameId").value);

        let name: string | undefined;
        try {
            const n = mapInfo.method("get_name").invoke();
            if (n) name = String(n).replace(/^"|"$/g, "");
        } catch {}

        const mapData = mapMeta.field("mapData").value as any;
        if (!mapData) return null;

        const neighbors = {
            top: Number(mapData.field("topNeighbourId").value),
            bottom: Number(mapData.field("bottomNeighbourId").value),
            left: Number(mapData.field("leftNeighbourId").value),
            right: Number(mapData.field("rightNeighbourId").value),
        };
        const arrowCells = {
            top:    readListInt32(mapData.field("topArrowCellList").value),
            bottom: readListInt32(mapData.field("bottomArrowCellList").value),
            left:   readListInt32(mapData.field("leftArrowCellList").value),
            right:  readListInt32(mapData.field("rightArrowCellList").value),
        };

        const cellsList = mapData.field("cellsData").value as any;
        const cells: MapCell[] = [];
        try {
            const count = cellsList.method("get_Count").invoke() as number;
            for (let i = 0; i < count; i++) {
                try {
                    const cell = cellsList.method("get_Item").invoke(i) as any;
                    cells.push({
                        id: Number(cell.field("cellNumber").value),
                        mov: Boolean(cell.field("mov").value),
                        los: Boolean(cell.field("los").value),
                        speed: Number(cell.field("speed").value),
                        floor: Number(cell.field("floor").value),
                        arrow: Number(cell.field("arrow").value),
                        red: Boolean(cell.field("red").value),
                        blue: Boolean(cell.field("blue").value),
                        mapChangeData: Number(cell.field("mapChangeData").value),
                        nonWalkableRp: Boolean(cell.field("nonWalkableDuringRP").value),
                        nonWalkableFight: Boolean(cell.field("nonWalkableDuringFight").value),
                        farmCell: Boolean(cell.field("farmCell").value),
                        visible: Boolean(cell.field("visible").value),
                        havenbagCell: Boolean(cell.field("havenbagCell").value),
                    });
                } catch {}
            }
        } catch {}

        return { mapId, posX, posY, subAreaId, worldMap, nameId, name, neighbors, arrowCells, cells };
    });
}

// -----------------------------------------------------------------------------
// Coord → mapId index (session-cached)
// -----------------------------------------------------------------------------

interface MapCoordEntry { mapId: number; subAreaId: number; worldMap: number; }
let mapCoordIndex: Map<string, MapCoordEntry[]> | null = null;

function buildCoordIndex(): number {
    if (mapCoordIndex) return mapCoordIndex.size;
    const klass = findClass("MapInformationData");
    mapCoordIndex = new Map<string, MapCoordEntry[]>();
    if (!klass) return 0;
    for (const inst of Il2Cpp.gc.choose(klass)) {
        try {
            const px = Number(inst.field("posX").value);
            const py = Number(inst.field("posY").value);
            const key = `${px},${py}`;
            const entry: MapCoordEntry = {
                mapId: Number(inst.field("id").value),
                subAreaId: Number(inst.field("subAreaId").value),
                worldMap: Number(inst.field("worldMap").value),
            };
            if (!mapCoordIndex.has(key)) mapCoordIndex.set(key, []);
            mapCoordIndex.get(key)!.push(entry);
        } catch {}
    }
    return mapCoordIndex.size;
}

export function findMapIdByCoords(
    posX: number, posY: number, preferredWorldMap?: number,
): Promise<{ matches: MapCoordEntry[]; best: MapCoordEntry | null }> {
    return inVm(() => {
        buildCoordIndex();
        const matches = mapCoordIndex!.get(`${posX},${posY}`) ?? [];
        let best: MapCoordEntry | null = null;
        if (preferredWorldMap !== undefined) best = matches.find(m => m.worldMap === preferredWorldMap) ?? null;
        if (!best) best = matches[0] ?? null;
        return { matches, best };
    });
}

export function primeMapCoordIndex(): Promise<{ built: boolean; coords: number }> {
    return inVm(() => {
        const already = !!mapCoordIndex;
        const coords = buildCoordIndex();
        return { built: !already, coords };
    });
}

// -----------------------------------------------------------------------------
// Current-map interactives
// -----------------------------------------------------------------------------

export interface InteractiveOnMap {
    elementId: string;    // map-scoped instance id (Int64 as string)
    cell: number;
    typeId: number;       // InteractiveData.id — the catalog key
    name: string;         // localized (e.g. "Frêne", "Ortie")
}

export function getInteractivesOnMap(): Promise<InteractiveOnMap[]> {
    return inVm(() => {
        const dvi = getSingleton("dvi");
        if (!dvi) return [];

        const dict = dvi.field("<dexl>k__BackingField").value as any;
        if (!dict) return [];

        const rootInst = getSingleton("InteractivesDataRoot");

        const resolveName = (typeId: number): string => {
            if (!rootInst) return "";
            try {
                const m = rootInst.method("GetInteractiveById") as any;
                if (!m) return "";
                const data = m.invoke(typeId) as any;
                if (!data) return "";
                const n = data.method("get_name").invoke();
                return n ? String(n).replace(/^"|"$/g, "") : "";
            } catch { return ""; }
        };

        const out: InteractiveOnMap[] = [];
        try {
            const entries = dict.field("_entries").value as any;
            const count = Number(dict.field("_count").value);
            const length = entries && typeof entries.length === "number" ? entries.length : count;
            const N = Math.min(count, length);
            for (let i = 0; i < N; i++) {
                try {
                    const entry = entries.get(i);
                    if (Number(entry.field("hashCode").value) < 0) continue;
                    const key = entry.field("key").value;
                    const val = entry.field("value").value as any;
                    if (!val) continue;
                    const element = val.field("element").value as any;
                    const pos = val.field("position").value as any;
                    let cutm = 0, cutn = 0;
                    try { cutm = Number(element.field("cutm").value); } catch {}
                    try { cutn = Number(element.field("cutn").value); } catch {}
                    let typeId = cutn, name = resolveName(cutn);
                    if (!name && cutm) { const n2 = resolveName(cutm); if (n2) { typeId = cutm; name = n2; } }
                    let cell = -1;
                    try { cell = Number(pos.field("dphm").value); } catch {}
                    out.push({ elementId: String(key), cell, typeId, name });
                } catch {}
            }
        } catch {}
        return out;
    });
}

/** Static lookup for a map in the DataCenter. */
export function getMapInfo(mapId: number): Promise<{
    id: number; posX: number; posY: number; subAreaId: number; worldMap: number; nameId: number; name?: string;
} | null> {
    return inVm(() => {
        const klass = findClass("MapInformationData");
        if (!klass) return null;
        const getter = klass.methods.find(m =>
            m.isStatic && m.name === "GetMapInformationById" && m.parameters.length === 1
        );
        if (!getter) return null;

        let info: any;
        try { info = getter.invoke(mapId); } catch { return null; }
        if (!info) return null;

        let name: string | undefined;
        try { const n = info.method("get_name").invoke(); if (n) name = String(n).replace(/^"|"$/g, ""); } catch {}
        return {
            id: Number(info.field("id").value),
            posX: Number(info.field("posX").value),
            posY: Number(info.field("posY").value),
            subAreaId: Number(info.field("subAreaId").value),
            worldMap: Number(info.field("worldMap").value),
            nameId: Number(info.field("nameId").value),
            name,
        };
    });
}
