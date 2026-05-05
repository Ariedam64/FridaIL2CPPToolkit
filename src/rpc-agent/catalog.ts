// Static-catalog extraction RPCs. Each `extract*` walks a DataCenter root
// (MapInformationData, InteractiveData, MonsterData, SubAreaData, etc.)
// via `Il2Cpp.gc.choose` and returns a compact array suitable for JSON
// persistence at `.toolkit-data/catalog/<name>.json`.
//
// These catalogs are session-stable — once extracted they don't change
// until a game update. The panel runs them once per new build.
import "frida-il2cpp-bridge";
import { findClassExact as findClass } from "../lib/search";
import { scheduleMainThread } from "./sender";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function readString(obj: any, fieldName: string): string {
    try {
        const v = obj.field(fieldName).value;
        if (v === null || v === undefined) return "";
        return String(v).replace(/^"|"$/g, "");
    } catch { return ""; }
}

function readStringGetter(obj: any, getterName: string): string {
    try {
        const v = obj.method(getterName).invoke();
        if (v === null || v === undefined) return "";
        return String(v).replace(/^"|"$/g, "");
    } catch { return ""; }
}

function readIntField(obj: any, name: string): number {
    try { return Number(obj.field(name).value); } catch { return 0; }
}

// -----------------------------------------------------------------------------
// Maps — full ~15k catalog
// -----------------------------------------------------------------------------

export interface MapCatalogEntry {
    id: number;
    posX: number;
    posY: number;
    subAreaId: number;
    worldMap: number;
    nameId: number;
    name: string;
}

export function extractMapsCatalog(): Promise<{ count: number; items: MapCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("MapInformationData");
        if (!klass) return { count: 0, items: [] };
        const items: MapCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                items.push({
                    id: readIntField(inst, "id"),
                    posX: readIntField(inst, "posX"),
                    posY: readIntField(inst, "posY"),
                    subAreaId: readIntField(inst, "subAreaId"),
                    worldMap: readIntField(inst, "worldMap"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                });
            } catch {}
        }
        console.log(`[catalog] maps: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// Interactive types — typeId → name (Zaap, Ortie, Frêne, etc.)
// -----------------------------------------------------------------------------

export interface InteractiveCatalogEntry {
    id: number;
    nameId: number;
    name: string;
}

export function extractInteractivesCatalog(): Promise<{ count: number; items: InteractiveCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("InteractiveData");
        if (!klass) return { count: 0, items: [] };
        const items: InteractiveCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                items.push({
                    id: readIntField(inst, "id"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                });
            } catch {}
        }
        console.log(`[catalog] interactives: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// World maps — id + dimensions used to stitch cartography tiles into a
// background image per worldmap.
// -----------------------------------------------------------------------------

export interface WorldMapCatalogEntry {
    id: number; nameId: number; name: string;
    origineX: number; origineY: number;
    mapWidth: number; mapHeight: number;
    totalWidth: number; totalHeight: number;
    visibleOnMap: boolean;
}

export function extractWorldMapsCatalog(): Promise<{ count: number; items: WorldMapCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("WorldMapData");
        if (!klass) return { count: 0, items: [] };
        const items: WorldMapCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                items.push({
                    id: readIntField(inst, "id"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                    origineX: readIntField(inst, "origineX"),
                    origineY: readIntField(inst, "origineY"),
                    mapWidth: Number((inst as any).field("mapWidth").value),
                    mapHeight: Number((inst as any).field("mapHeight").value),
                    totalWidth: readIntField(inst, "totalWidth"),
                    totalHeight: readIntField(inst, "totalHeight"),
                    visibleOnMap: Boolean((inst as any).field("visibleOnMap").value),
                });
            } catch {}
        }
        console.log(`[catalog] worldmaps: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// Skill names — skillId → name (for resources: "Collecter une Ortie" etc.)
// -----------------------------------------------------------------------------

export function extractSkillNamesCatalog(): Promise<{ count: number; items: Array<{ id: number; name: string }> }> {
    return inVm(() => {
        const klass = findClass("SkillNameData");
        if (!klass) return { count: 0, items: [] };
        const items: Array<{ id: number; name: string }> = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                items.push({ id: readIntField(inst, "id"), name: readStringGetter(inst, "get_name") });
            } catch {}
        }
        console.log(`[catalog] skill names: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// Monsters
// -----------------------------------------------------------------------------

export interface MonsterCatalogEntry {
    id: number;
    iconId: number;  // monsters store the picto sprite id in `gfxId`
    nameId: number;
    name: string;
    raceId?: number;
    isBoss?: boolean;
    isMiniBoss?: boolean;
    isQuestMonster?: boolean;
}

export function extractMonstersCatalog(): Promise<{ count: number; items: MonsterCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("MonsterData");
        if (!klass) return { count: 0, items: [] };
        const items: MonsterCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                const entry: MonsterCatalogEntry = {
                    id: readIntField(inst, "id"),
                    iconId: readIntField(inst, "gfxId"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                };
                // Optional fields — silently skip if absent.
                try { entry.raceId = readIntField(inst, "race"); } catch {}
                try { entry.isBoss = Boolean(inst.field("isBoss").value); } catch {}
                try { entry.isMiniBoss = Boolean(inst.field("isMiniBoss").value); } catch {}
                try { entry.isQuestMonster = Boolean(inst.field("isQuestMonster").value); } catch {}
                items.push(entry);
            } catch {}
        }
        console.log(`[catalog] monsters: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// Sub-areas + areas (for naming regions on the world map)
// -----------------------------------------------------------------------------

export interface SubAreaCatalogEntry {
    id: number;
    nameId: number;
    name: string;
    areaId: number;
    worldmapId?: number;
    level?: number;
}

export function extractSubAreasCatalog(): Promise<{ count: number; items: SubAreaCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("SubAreaData");
        if (!klass) return { count: 0, items: [] };
        const items: SubAreaCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                const entry: SubAreaCatalogEntry = {
                    id: readIntField(inst, "id"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                    areaId: readIntField(inst, "areaId"),
                };
                try { entry.worldmapId = readIntField(inst, "worldmapId"); } catch {}
                try { entry.level = readIntField(inst, "level"); } catch {}
                items.push(entry);
            } catch {}
        }
        console.log(`[catalog] sub-areas: ${items.length}`);
        return { count: items.length, items };
    });
}

export interface AreaCatalogEntry {
    id: number;
    nameId: number;
    name: string;
    superAreaId?: number;
    worldmapId?: number;
}

export function extractAreasCatalog(): Promise<{ count: number; items: AreaCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("AreaData");
        if (!klass) return { count: 0, items: [] };
        const items: AreaCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                const entry: AreaCatalogEntry = {
                    id: readIntField(inst, "id"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                };
                try { entry.superAreaId = readIntField(inst, "superAreaId"); } catch {}
                try { entry.worldmapId = readIntField(inst, "worldmapId"); } catch {}
                items.push(entry);
            } catch {}
        }
        console.log(`[catalog] areas: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// Items (resources drop from interactives — we'll link later)
// -----------------------------------------------------------------------------

export interface ItemCatalogEntry {
    id: number;
    iconId: number;
    nameId: number;
    name: string;
    typeId: number;
    level?: number;
}

export function extractItemsCatalog(): Promise<{ count: number; items: ItemCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("ItemData");
        if (!klass) return { count: 0, items: [] };
        const items: ItemCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                const entry: ItemCatalogEntry = {
                    id: readIntField(inst, "id"),
                    iconId: readIntField(inst, "iconId"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                    typeId: readIntField(inst, "typeId"),
                };
                try { entry.level = readIntField(inst, "level"); } catch {}
                items.push(entry);
            } catch {}
        }
        console.log(`[catalog] items: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// Jobs (the skill → job relationship is in SkillData.parentJobId)
// -----------------------------------------------------------------------------

export interface JobCatalogEntry {
    id: number;
    nameId: number;
    name: string;
}

export function extractJobsCatalog(): Promise<{ count: number; items: JobCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("JobData");
        if (!klass) return { count: 0, items: [] };
        const items: JobCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                items.push({
                    id: readIntField(inst, "id"),
                    nameId: readIntField(inst, "nameId"),
                    name: readStringGetter(inst, "get_name"),
                });
            } catch {}
        }
        console.log(`[catalog] jobs: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// Skills (job/resource skills) — links skillId → gatheredResourceItem
// -----------------------------------------------------------------------------

export interface SkillCatalogEntry {
    id: number;
    nameId: number;
    parentJobId: number;
    gatheredResourceItem: number;
    elementActionId: number;
    levelMin: number;
    name: string;
}

export function extractSkillsCatalog(): Promise<{ count: number; items: SkillCatalogEntry[] }> {
    return inVm(() => {
        const klass = findClass("SkillData");
        if (!klass) return { count: 0, items: [] };
        const items: SkillCatalogEntry[] = [];
        for (const inst of Il2Cpp.gc.choose(klass)) {
            try {
                items.push({
                    id: readIntField(inst, "id"),
                    nameId: readIntField(inst, "nameId"),
                    parentJobId: readIntField(inst, "parentJobId"),
                    gatheredResourceItem: readIntField(inst, "gatheredRessourceItem"),
                    elementActionId: readIntField(inst, "elementActionId"),
                    levelMin: readIntField(inst, "levelMin"),
                    name: readStringGetter(inst, "get_name"),
                });
            } catch {}
        }
        console.log(`[catalog] skills: ${items.length}`);
        return { count: items.length, items };
    });
}

// -----------------------------------------------------------------------------
// One-shot orchestrator
// -----------------------------------------------------------------------------
// The UI calls this once to dump everything via broadcast `send()` events.
// Server-side handler persists each to `.toolkit-data/catalog/<name>.json`.

// Enumerate tile names for each worldmap in eat.dggm — each Texture2D in
// the cache carries its bundle-side name (e.g. "tile_01", "12"), which is
// what offline bundle extraction uses to name its files. Returning the
// name→(wmId, index) mapping lets the extraction script group tiles by
// worldmap deterministically.
export function listCartographyTileNames(): Promise<any> {
    return inVm(() => {
        const eat = findClass("eat");
        if (!eat) return { ok: false, reason: "eat not found" };
        try { (eat as any).initialize?.(); } catch {}
        const dggm = (eat.field("dggm") as any).value;
        if (!dggm) return { ok: true, worldmaps: [] };
        const out: Array<{ worldMapId: number; tiles: Array<{ index: number; name: string; width: number; height: number }> }> = [];
        try {
            const entries = dggm.field("_entries").value as any;
            const count = Number(dggm.field("_count").value);
            for (let i = 0; i < count; i++) {
                try {
                    const e = entries.get(i);
                    if (Number(e.field("hashCode").value) < 0) continue;
                    const wmId = Number(e.field("key").value);
                    const list = e.field("value").value as any;
                    if (!list) continue;
                    const n = Number(list.method("get_Count").invoke());
                    const tiles: Array<{ index: number; name: string; width: number; height: number }> = [];
                    for (let j = 0; j < n; j++) {
                        try {
                            const tex = list.method("get_Item").invoke(j) as any;
                            tiles.push({
                                index: j,
                                name: String(tex.method("get_name").invoke()).replace(/^"|"$/g, ""),
                                width: Number(tex.method("get_width").invoke()),
                                height: Number(tex.method("get_height").invoke()),
                            });
                        } catch {}
                    }
                    out.push({ worldMapId: wmId, tiles });
                } catch {}
            }
        } catch (e) { return { ok: false, reason: String(e).slice(0, 200) }; }
        return { ok: true, worldmaps: out };
    });
}

// Inspect the Ankama cartography texture cache (eat.dggm) — a static
// Dictionary<Int32, List<Texture2D>> mapping worldMapId → rendered map
// images. Populated when the player opens the in-game world map UI.
export function listCartographyTextures(): Promise<any> {
    return inVm(() => {
        const eat = findClass("eat");
        if (!eat) return { ok: false, reason: "eat class not found" };
        try { (eat as any).initialize?.(); } catch {}
        let dggm: any = null;
        try { dggm = (eat.field("dggm") as any).value; } catch (e) { return { ok: false, reason: `field read: ${String(e).slice(0, 120)}` }; }
        if (!dggm) return { ok: true, worldmaps: [], reason: "dggm null — open cartography once in game" };
        const out: Array<{ worldMapId: number; count: number; sizes: Array<{ width: number; height: number }> }> = [];
        try {
            const entries = dggm.field("_entries").value as any;
            const count = Number(dggm.field("_count").value);
            for (let i = 0; i < count; i++) {
                try {
                    const e = entries.get(i);
                    if (Number(e.field("hashCode").value) < 0) continue;
                    const wmId = Number(e.field("key").value);
                    const list = e.field("value").value as any;
                    if (!list) continue;
                    const n = Number(list.method("get_Count").invoke());
                    const sizes: Array<{ width: number; height: number }> = [];
                    for (let j = 0; j < Math.min(n, 5); j++) {
                        try {
                            const tex = list.method("get_Item").invoke(j) as any;
                            sizes.push({
                                width: Number(tex.method("get_width").invoke()),
                                height: Number(tex.method("get_height").invoke()),
                            });
                        } catch {}
                    }
                    out.push({ worldMapId: wmId, count: n, sizes });
                } catch {}
            }
        } catch (e) { return { ok: false, reason: String(e).slice(0, 200) }; }
        return { ok: true, worldmaps: out };
    });
}

// Extract every Texture2D from a worldmap's tile list as a PNG, streamed
// over the Frida IPC channel as binary send() payloads. Server-side
// handler persists to .toolkit-data/cartography/wm<id>/tile_<n>.png.
// Uses UnityEngine.ImageConversion.EncodeToPNG which handles the GPU
// readback + encoding for us.
export function exportCartographyTextures(worldMapId: number): Promise<{
    ok: boolean; reason?: string; worldMapId?: number; exported?: number; tiles?: number; firstErr?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const eat = findClass("eat");
        if (!eat) { resolve({ ok: false, reason: "eat class not found" }); return; }
        try { (eat as any).initialize?.(); } catch {}
        const dggm = (eat.field("dggm") as any).value;
        if (!dggm) { resolve({ ok: false, reason: "cartography cache empty — open world map in game once" }); return; }

        let list: any = null;
        try {
            const entries = dggm.field("_entries").value as any;
            const count = Number(dggm.field("_count").value);
            for (let i = 0; i < count; i++) {
                const e = entries.get(i);
                if (Number(e.field("hashCode").value) < 0) continue;
                if (Number(e.field("key").value) === worldMapId) { list = e.field("value").value; break; }
            }
        } catch (e) { resolve({ ok: false, reason: `dict walk: ${String(e).slice(0, 120)}` }); return; }
        if (!list) { resolve({ ok: false, reason: `worldMapId ${worldMapId} not in cache` }); return; }

        const icv = findClass("ImageConversion");
        if (!icv) { resolve({ ok: false, reason: "UnityEngine.ImageConversion not found" }); return; }
        const encodeToJPG = icv.methods.find(m =>
            m.isStatic && m.name === "EncodeToJPG" && m.parameters.length === 2
            && m.parameters[0].type.name === "UnityEngine.Texture2D"
        );
        if (!encodeToJPG) { resolve({ ok: false, reason: "EncodeToJPG(Texture2D,int) not found" }); return; }

        const n = Number(list.method("get_Count").invoke());

        // EncodeToJPG requires Unity main thread — dispatch the whole loop
        // via sender's shared dtt.tjz interceptor.
        // GPU-only textures (readable=false). We need a round-trip through
        // RenderTexture + ReadPixels to get CPU bytes, then EncodeToJPG.
        const rtKlass = findClass("RenderTexture");
        const gKlass = findClass("Graphics");
        const texKlass = findClass("Texture2D");
        const rectKlass = findClass("Rect");
        if (!rtKlass || !gKlass || !texKlass || !rectKlass) { resolve({ ok: false, reason: "RenderTexture/Graphics/Texture2D/Rect not found" }); return; }
        const getTemp = rtKlass.methods.find(m => m.isStatic && m.name === "GetTemporary" && m.parameters.length === 3);
        const releaseTemp = rtKlass.methods.find(m => m.isStatic && m.name === "ReleaseTemporary");
        const getActive = rtKlass.methods.find(m => m.isStatic && m.name === "get_active");
        const setActive = rtKlass.methods.find(m => m.isStatic && m.name === "set_active");
        const blit = gKlass.methods.find(m => m.isStatic && m.name === "Blit" && m.parameters.length === 2);
        if (!getTemp || !releaseTemp || !getActive || !setActive || !blit) { resolve({ ok: false, reason: "GPU readback API incomplete" }); return; }

        const scheduled = scheduleMainThread(() => {
            let exported = 0, firstErr = "";
            try {
                const tex0 = list.method("get_Item").invoke(0) as any;
                const readable = Boolean(tex0.method("get_isReadable").invoke());
                console.log(`[cartography] readable=${readable} — ${readable ? "direct" : "GPU readback"} path`);
            } catch {}

            const prevActive = getActive.invoke() as any;
            for (let i = 0; i < n; i++) {
                let rt: any = null, readable: any = null;
                try {
                    const tex = list.method("get_Item").invoke(i) as any;
                    if (!tex) { if (!firstErr) firstErr = `tile ${i}: null tex`; continue; }
                    const width = Number(tex.method("get_width").invoke());
                    const height = Number(tex.method("get_height").invoke());

                    // 1. temp RT same size
                    rt = getTemp.invoke(width, height, 0) as any;
                    // 2. blit GPU texture onto RT
                    blit.invoke(tex, rt);
                    // 3. bind RT as active render target
                    setActive.invoke(rt);
                    // 4. allocate readable Texture2D
                    readable = (texKlass as any).new(width, height);
                    // 5. ReadPixels(rect, 0, 0)
                    const rect = (rectKlass as any).new();
                    rect.method(".ctor").invoke(0, 0, width, height);
                    readable.method("ReadPixels").invoke(rect, 0, 0, false);
                    readable.method("Apply").invoke();

                    // 6. encode the now-readable copy
                    const bytes = encodeToJPG.invoke(readable, 90) as Il2Cpp.Array<number>;
                    if (!bytes) { if (!firstErr) firstErr = `tile ${i}: encode null`; continue; }
                    const len = Number(bytes.length);
                    const buf = Memory.alloc(len);
                    for (let k = 0; k < len; k++) buf.add(k).writeU8(Number(bytes.get(k)));
                    const ab = buf.readByteArray(len);
                    send({ type: "cartography-tile", worldMapId, tileIndex: i, width, height, len, format: "jpg", ts: Date.now() }, ab as any);
                    exported++;
                } catch (e) { if (!firstErr) firstErr = `tile ${i}: ${String(e).slice(0, 150)}`; }
                finally {
                    try { if (rt) releaseTemp.invoke(rt); } catch {}
                }
            }
            try { setActive.invoke(prevActive); } catch {}
            console.log(`[cartography] wm=${worldMapId} exported ${exported}/${n}${firstErr ? " · " + firstErr : ""}`);
            resolve({ ok: true, worldMapId, exported, tiles: n, firstErr });
        });
        if (!scheduled) resolve({ ok: false, reason: "main-thread dispatcher unavailable" });
    }));
}

// Walk a MapMetadata ScriptableObject and extract the static interactive
// element IDs. Each `ClientInteractiveElement` has only `get_interactionId()
// → UInt32` — this is the eckv (element catalog id). The skill id (eckt)
// is server-provided, not in the static asset.
export function extractInteractivesFromMapMetadata(mapMetaHandle?: string): Promise<{
    ok: boolean; reason?: string; mapId?: number; interactives: Array<{ elementId: number }>;
}> {
    return inVm(() => {
        // If no handle given, pick the first live MapMetadata.
        let mapMeta: Il2Cpp.Object | null = null;
        if (mapMetaHandle) {
            try { mapMeta = new (Il2Cpp as any).Object(ptr(mapMetaHandle)); } catch {}
        } else {
            const klass = findClass("MapMetadata");
            if (!klass) return { ok: false, reason: "MapMetadata class not found", interactives: [] };
            const live = Il2Cpp.gc.choose(klass);
            if (!live.length) return { ok: false, reason: "no live MapMetadata", interactives: [] };
            mapMeta = live[0];
        }
        if (!mapMeta) return { ok: false, reason: "no MapMetadata", interactives: [] };

        try {
            const mapData = mapMeta.field("mapData").value as any;
            if (!mapData) return { ok: false, reason: "mapData null", interactives: [] };
            const list = mapData.field("interactiveElements").value as any;
            if (!list) return { ok: true, interactives: [] };
            const n = Number(list.method("get_Count").invoke());
            const out: Array<{ elementId: number }> = [];
            for (let i = 0; i < n; i++) {
                try {
                    const elem = list.method("get_Item").invoke(i) as any;
                    if (!elem) continue;
                    const id = Number(elem.method("get_interactionId").invoke());
                    out.push({ elementId: id });
                } catch {}
            }
            return { ok: true, interactives: out };
        } catch (e) { return { ok: false, reason: String(e).slice(0, 200), interactives: [] }; }
    });
}

// Peek at the Ankama asset cache (gtx.ducb) — maps "set → id → address → asset".
// Used to understand the addressing scheme the game uses for MapMetadata.
export function dumpAssetCache(): Promise<any> {
    return inVm(() => {
        const gtx = findClass("gtx");
        if (!gtx) return { ok: false, reason: "gtx not found" };
        try { (gtx as any).initialize?.(); } catch {}
        let ducb: any = null;
        try { ducb = (gtx.field("ducb") as any).value; } catch (e) { return { ok: false, reason: `field read: ${String(e).slice(0, 120)}` }; }
        if (!ducb) return { ok: false, reason: "ducb null" };
        const out: Array<{ set: string; id: string; address: string; assetClass: string }> = [];
        try {
            // ducb is Dictionary<gtv, Dictionary<String, Dictionary<String, Object>>>
            const setEntries = ducb.field("_entries").value as any;
            const setCount = Number(ducb.field("_count").value);
            for (let i = 0; i < setCount; i++) {
                try {
                    const e = setEntries.get(i);
                    if (Number(e.field("hashCode").value) < 0) continue;
                    const setVal = String(e.field("key").value);
                    const idDict = e.field("value").value as any;
                    if (!idDict) continue;
                    const idEntries = idDict.field("_entries").value as any;
                    const idCount = Number(idDict.field("_count").value);
                    for (let j = 0; j < idCount; j++) {
                        try {
                            const ee = idEntries.get(j);
                            if (Number(ee.field("hashCode").value) < 0) continue;
                            const id = String(ee.field("key").value).replace(/^"|"$/g, "");
                            const addrDict = ee.field("value").value as any;
                            if (!addrDict) continue;
                            const addrEntries = addrDict.field("_entries").value as any;
                            const addrCount = Number(addrDict.field("_count").value);
                            for (let k = 0; k < addrCount; k++) {
                                try {
                                    const eee = addrEntries.get(k);
                                    if (Number(eee.field("hashCode").value) < 0) continue;
                                    const addr = String(eee.field("key").value).replace(/^"|"$/g, "");
                                    const asset = eee.field("value").value as any;
                                    out.push({ set: setVal, id, address: addr, assetClass: asset?.class?.name ?? "null" });
                                } catch {}
                            }
                        } catch {}
                    }
                } catch {}
            }
        } catch (e) { return { ok: false, reason: String(e).slice(0, 200), partial: out }; }
        return { ok: true, entries: out };
    });
}

export function extractAllCatalogs(): Promise<{ counts: Record<string, number> }> {
    return inVm(async () => {
        const dumps: Array<[string, () => Promise<{ count: number; items: any[] }>]> = [
            ["maps",          () => extractMapsCatalog()],
            ["worldmaps",     () => extractWorldMapsCatalog()],
            ["interactives",  () => extractInteractivesCatalog()],
            ["skillNames",    () => extractSkillNamesCatalog()],
            ["subareas",      () => extractSubAreasCatalog()],
            ["areas",         () => extractAreasCatalog()],
            ["items",         () => extractItemsCatalog()],
            ["jobs",          () => extractJobsCatalog()],
            ["skills",        () => extractSkillsCatalog()],
            ["monsters",      () => extractMonstersCatalog()],
        ];
        const counts: Record<string, number> = {};
        for (const [name, fn] of dumps) {
            try {
                const r = await fn();
                counts[name] = r.count;
                try { send({ type: "catalog-dump", name, items: r.items, ts: Date.now() }); } catch {}
            } catch (e) {
                counts[name] = 0;
                console.log(`[catalog] ${name} failed: ${String(e).slice(0, 120)}`);
            }
        }
        return { counts };
    });
}

// -----------------------------------------------------------------------------
// Worldmap Addressables dump — walk Unity's loaded resource locators to
// extract the authoritative `worldmaps/<wmId>` label → tile addresses map.
//
// The worldmap catalog (StreamingAssets/Content/Picto/Worldmaps/catalog_1.0.bin)
// is parsed by Unity into a ResourceLocationMap (Dictionary<object,
// IList<IResourceLocation>>) where a key like "worldmaps/32" maps to every
// resource tagged with that label. Each IResourceLocation carries the
// PrimaryKey (e.g. "34/1/5.jpg"). Cross-referencing this with the bundle's
// extracted tiles gives us a definitive (wmId, address, tile_file) mapping.
// -----------------------------------------------------------------------------

interface AddressablesDump {
    ok: boolean;
    reason?: string;
    worldmaps?: Array<{ worldMapId: number; entries: Array<{ address: string; internalId: string }> }>;
    locatorCount?: number;
    totalEntries?: number;
}

function walkList(list: any, fn: (item: any, i: number) => void): void {
    try {
        const count = Number(list.method("get_Count").invoke());
        for (let i = 0; i < count; i++) {
            try { fn(list.method("get_Item").invoke(i) as any, i); } catch {}
        }
    } catch {}
}

function walkDict(dict: any, fn: (key: any, value: any) => void): void {
    try {
        const entries = dict.field("_entries").value as any;
        const count = Number(dict.field("_count").value);
        for (let i = 0; i < count; i++) {
            try {
                const e = entries.get(i);
                if (Number(e.field("hashCode").value) < 0) continue;
                fn(e.field("key").value as any, e.field("value").value as any);
            } catch {}
        }
    } catch {}
}

export function dumpWorldmapAddressables(): Promise<AddressablesDump> {
    return inVm(() => {
        // Chain: Addressables.m_AddressablesInstance → m_ResourceLocators
        // (List<ResourceLocatorInfo>) → unwrap each Info's inner IResourceLocator.
        // The Worldmaps catalog's locator has its addressable keys in a
        // Dictionary<Object, UInt32> called `keyData`. Ankama stores labels
        // and addresses as a single string `worldmaps/<wmId>/<scale>/<n>.jpg`,
        // so we parse the wmId out directly and call Locate(key) on the
        // locator to get the InternalId (bundle GUID) per address.
        const addr = findClass("Addressables");
        if (!addr) return { ok: false, reason: "Addressables class not found" };
        const instance = (addr.field("m_AddressablesInstance") as any).value;
        if (!instance) return { ok: false, reason: "m_AddressablesInstance null" };
        const locators = instance.field("m_ResourceLocators").value as any;
        if (!locators) return { ok: false, reason: "m_ResourceLocators not found" };

        const worldmapMap: Map<number, Map<string, string>> = new Map();
        let totalEntries = 0;
        let locatorCount = 0;

        walkList(locators, (info) => {
            // Unwrap ResourceLocatorInfo → inner IResourceLocator.
            let locator: any = info;
            try {
                const u = info.field("<Locator>k__BackingField").value;
                if (u) locator = u;
            } catch {}

            let keyData: any;
            try { keyData = locator.field("keyData").value; } catch { return; }
            if (!keyData) return;

            const wmKeys: Array<{ wmId: number; suffix: string; raw: string }> = [];
            walkDict(keyData, (key) => {
                totalEntries++;
                const s = String(key).replace(/^"|"$/g, "");
                const m = s.match(/^worldmaps\/(\d+)\/(.+\.jpg)$/);
                if (m) wmKeys.push({ wmId: parseInt(m[1], 10), suffix: m[2], raw: s });
            });
            if (!wmKeys.length) return;
            locatorCount++;

            const locate = locator.method("Locate");
            for (const { wmId, suffix, raw } of wmKeys) {
                let internalId = "";
                try {
                    const outPtr = Memory.alloc(8);
                    outPtr.writePointer(NULL);
                    locate.invoke(Il2Cpp.string(raw), NULL, outPtr);
                    const listPtr = outPtr.readPointer();
                    if (!listPtr.isNull()) {
                        const list = new Il2Cpp.Object(listPtr);
                        if (Number(list.method("get_Count").invoke()) > 0) {
                            const first = list.method("get_Item").invoke(0) as any;
                            internalId = String(first.method("get_InternalId").invoke()).replace(/^"|"$/g, "");
                        }
                    }
                } catch {}
                const entries = worldmapMap.get(wmId) ?? new Map<string, string>();
                entries.set(suffix, internalId);
                worldmapMap.set(wmId, entries);
            }
        });

        const out = [...worldmapMap.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([wmId, entries]) => ({
                worldMapId: wmId,
                entries: [...entries.entries()]
                    .map(([address, internalId]) => ({ address, internalId }))
                    .sort((a, b) => a.address.localeCompare(b.address)),
            }));
        const resolved = out.reduce((a, w) => a + w.entries.filter(e => e.internalId).length, 0);
        console.log(`[addr] ${out.length} worldmaps, ${resolved} internalIds resolved (${locatorCount} locators, ${totalEntries} keys)`);
        if (!out.length) return { ok: false, reason: "no worldmaps/* keys — open the in-game cartography first" };
        return { ok: true, worldmaps: out, locatorCount, totalEntries };
    });
}
