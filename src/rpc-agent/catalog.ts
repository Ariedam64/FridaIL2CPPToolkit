// Static-catalog extraction RPCs. Each `extract*` walks a DataCenter root
// (MapInformationData, InteractiveData, MonsterData, SubAreaData, etc.)
// via `Il2Cpp.gc.choose` and returns a compact array suitable for JSON
// persistence at `.toolkit-data/catalog/<name>.json`.
//
// These catalogs are session-stable — once extracted they don't change
// until a game update. The panel runs them once per new build.
import "frida-il2cpp-bridge";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function findClass(name: string): Il2Cpp.Class | null {
    for (const asm of Il2Cpp.domain.assemblies) {
        try { for (const k of asm.image.classes) if (k.name === name) return k; } catch {}
    }
    return null;
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
