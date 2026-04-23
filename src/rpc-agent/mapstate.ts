// Purpose-built RPCs that bundle Dofus map runtime state into shapes tailored
// for the host-side map panel. Relies on the runtimeMap we discovered in
// Ankama.Dofus.Core.World: MapRenderer (singleton) → MapMetadata → ClientMapData → cellsData.
import "frida-il2cpp-bridge";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

export interface MapCell {
    id: number;
    mov: boolean;             // walkable
    los: boolean;             // line of sight blocker absent
    speed: number;            // movement cost modifier
    floor: number;            // height / staircase layer
    arrow: number;            // 0 = none, else encodes exit direction
    red: boolean;             // fight red spawn
    blue: boolean;            // fight blue spawn
    mapChangeData: number;    // bitfield of which edges this cell can exit through
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

function firstInstance(klass: Il2Cpp.Class): Il2Cpp.Object | null {
    try {
        const arr = Il2Cpp.gc.choose(klass);
        return arr.length ? arr[0] : null;
    } catch { return null; }
}

/**
 * Read the full current-map state in one round-trip. Panel calls this on mount
 * and on "refresh". Expect 10–50ms depending on cell count.
 */
export function getMapState(): Promise<MapState | null> {
    return inVm(() => {
        const renderer = (() => {
            for (const asm of Il2Cpp.domain.assemblies) {
                try {
                    for (const k of asm.image.classes) {
                        if (k.name === "MapRenderer") {
                            const inst = firstInstance(k);
                            if (inst) return inst;
                        }
                    }
                } catch {}
            }
            return null;
        })();
        if (!renderer) return null;

        // Reach: renderer.cywh (MapInformationData), renderer.cywo (MapMetadata) → mapData (ClientMapData)
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

/**
 * Dump every MapInformationData instance currently loaded in the DataCenter —
 * typically the whole ~15k map catalog. Returned as parallel arrays to keep
 * the JSON payload small (~100 KB for 15k maps instead of ~750 KB of objects).
 */
export function dumpWorldMap(): Promise<{
    count: number;
    ids: number[];
    posX: number[];
    posY: number[];
    subAreaId: number[];
    worldMap: number[];
}> {
    return inVm(() => {
        let klass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "MapInformationData") { klass = k; break; }
                }
            } catch {}
            if (klass) break;
        }
        const empty = { count: 0, ids: [] as number[], posX: [] as number[], posY: [] as number[], subAreaId: [] as number[], worldMap: [] as number[] };
        if (!klass) return empty;

        let instances: Il2Cpp.Object[] = [];
        try { instances = Il2Cpp.gc.choose(klass); } catch { return empty; }

        const ids: number[] = [], posX: number[] = [], posY: number[] = [], subAreaId: number[] = [], worldMap: number[] = [];
        for (const inst of instances) {
            try {
                ids.push(Number(inst.field("id").value));
                posX.push(Number(inst.field("posX").value));
                posY.push(Number(inst.field("posY").value));
                subAreaId.push(Number(inst.field("subAreaId").value));
                worldMap.push(Number(inst.field("worldMap").value));
            } catch {}
        }
        console.log(`[mapstate] dumped ${ids.length} maps from DataCenter`);
        return { count: ids.length, ids, posX, posY, subAreaId, worldMap };
    });
}

/**
 * Resolve (posX, posY, worldMap) → mapId. Multiple maps share the same
 * coord (indoors/subAreas); we return all matches and prefer the same
 * worldMap as the caller's current map.
 *
 * Tried the game's native `MapsCoordinateData.GetMapCoordinatesByCoords` but
 * its backing `mapIds` list has a null backing pointer at runtime (either
 * lazy-loaded elsewhere or stripped — access violates). Falling back to a
 * one-shot gc.choose over MapInformationData built into an agent-side
 * `(x,y) → [maps]` index. First call: ~500ms-1s, cached thereafter.
 */
interface MapCoordEntry { mapId: number; subAreaId: number; worldMap: number; }
let mapCoordIndex: Map<string, MapCoordEntry[]> | null = null;

export function findMapIdByCoords(posX: number, posY: number, preferredWorldMap?: number): Promise<{
    matches: MapCoordEntry[];
    best: MapCoordEntry | null;
}> {
    return inVm(() => {
        if (!mapCoordIndex) {
            let klass: Il2Cpp.Class | null = null;
            for (const asm of Il2Cpp.domain.assemblies) {
                try {
                    for (const k of asm.image.classes) {
                        if (k.name === "MapInformationData") { klass = k; break; }
                    }
                } catch {}
                if (klass) break;
            }
            mapCoordIndex = new Map<string, MapCoordEntry[]>();
            if (klass) {
                const instances = Il2Cpp.gc.choose(klass);
                for (const inst of instances) {
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
                console.log(`[mapstate] coord index: ${instances.length} maps → ${mapCoordIndex.size} coords`);
            }
        }
        const matches = mapCoordIndex.get(`${posX},${posY}`) ?? [];
        let best: MapCoordEntry | null = null;
        if (preferredWorldMap !== undefined) best = matches.find(m => m.worldMap === preferredWorldMap) ?? null;
        if (!best) best = matches[0] ?? null;
        return { matches, best };
    });
}

/**
 * Force-build the coord index now. UI calls this at panel-load time so the
 * first click on "GO" doesn't pay the ~1s gc.choose cost.
 */
export function primeMapCoordIndex(): Promise<{ built: boolean; coords: number }> {
    return inVm(() => {
        if (mapCoordIndex) return { built: false, coords: mapCoordIndex.size };
        // Trigger the build via a no-op lookup.
        // (We can't call findMapIdByCoords directly — it's wrapped in inVm.)
        let klass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "MapInformationData") { klass = k; break; }
                }
            } catch {}
            if (klass) break;
        }
        mapCoordIndex = new Map<string, MapCoordEntry[]>();
        if (klass) {
            const instances = Il2Cpp.gc.choose(klass);
            for (const inst of instances) {
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
        }
        return { built: true, coords: mapCoordIndex.size };
    });
}

export interface ActorOnMap {
    id: string;        // Int64 as string (JS number precision loss risk)
    cell: number;      // current cellId (0..559)
    speed: number;     // movement speed (from EntityPhysics)
    kindEnum: string;  // raw Entity.czoz enum-member name (e.g. "czrs", "czrt" — the discriminator)
    kindDefCls: string;// runtime class name of Entity.czor (ewb subtype — another discriminator)
}

/**
 * Walk every live Core.Rendering.Entity.Entity in the heap and return actor id
 * + current cell id. The runtime store has ~50-100 Entity objects (all actors
 * currently rendered), much cleaner than parsing protobuf batch messages.
 */
export function listActorsOnMap(): Promise<ActorOnMap[]> {
    return inVm(() => {
        let entKlass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "Entity" && k.namespace === "Core.Rendering.Entity") {
                        entKlass = k; break;
                    }
                }
            } catch {}
            if (entKlass) break;
        }
        if (!entKlass) return [];

        let insts: Il2Cpp.Object[] = [];
        try { insts = Il2Cpp.gc.choose(entKlass); } catch { return []; }

        // Stage 1: collect every candidate (heap has ~70 entities, many are stale
        // clones of despawned/wandering groups). We'll filter ghosts in stage 2.
        interface RawEntity {
            id: string; cell: number; speed: number; kindEnum: string; kindDefCls: string;
            meshEnabled: boolean; gact: boolean;
        }
        const raw: RawEntity[] = [];
        for (const ent of insts) {
            try {
                const idRaw = ent.field("<czpe>k__BackingField").value as any;
                const id = String(idRaw);
                const phys = ent.field("czox").value as any;
                if (!phys || !phys.class) continue;
                let cell = -1, speed = 0;
                try { cell = Number(phys.field("<czuk>k__BackingField").value); } catch {}
                try { speed = Number(phys.field("czuh").value); } catch {}
                if (cell < 0 || cell > 600) continue;

                let kindEnum = "";
                try { kindEnum = String(ent.field("czoz").value).replace(/^"|"$/g, ""); } catch {}
                let kindDefCls = "";
                try {
                    const def = ent.field("czor").value as any;
                    if (def && def.class) kindDefCls = String(def.class.name);
                } catch {}

                // "Is this entity currently drawn in the Unity scene" — the cleanest
                // live-vs-ghost signal we've found. Players use Animator2D so their
                // MeshRenderer is disabled even when world-active — that's why we
                // keep them via the self-flag escape hatch below.
                let meshEnabled = false, gact = false;
                try {
                    const disp = ent.field("czov").value as any;
                    if (disp && disp.class) {
                        const mr = disp.field("dabz").value as any;
                        if (mr) {
                            try { meshEnabled = Boolean(mr.method("get_enabled").invoke()); } catch {}
                            try {
                                const go = mr.method("get_gameObject").invoke() as any;
                                if (go) gact = Boolean(go.method("get_activeInHierarchy").invoke());
                            } catch {}
                        }
                    }
                } catch {}

                raw.push({ id, cell, speed, kindEnum, kindDefCls, meshEnabled, gact });
            } catch {}
        }

        // Stage 2: dedupe by actorId + drop ghost groups.
        // A group is live iff ≥1 entry has a live signal (mesh|gact|self-flag). Inside
        // a live group, pick the "best" entry: self-flag wins, then mesh=true, then
        // the richer kindEnum, else first.
        const byId = new Map<string, RawEntity>();
        const hasSelfFlag = (e: RawEntity) => {
            const f = e.kindEnum;
            return f.indexOf("czsd") >= 0 || f.indexOf("czsf") >= 0;
        };
        const score = (e: RawEntity): number => {
            let s = 0;
            if (hasSelfFlag(e)) s += 1000;
            if (e.meshEnabled) s += 100;
            if (e.gact) s += 10;
            s += e.kindEnum.split(",").length;
            return s;
        };
        const groups = new Map<string, RawEntity[]>();
        for (const e of raw) {
            const arr = groups.get(e.id);
            if (arr) arr.push(e); else groups.set(e.id, [e]);
        }
        let ghostGroupsDropped = 0;
        for (const [id, arr] of groups) {
            const alive = arr.some(e => e.meshEnabled || e.gact || hasSelfFlag(e));
            if (!alive) { ghostGroupsDropped++; continue; }
            // Pick the highest-scoring entry within the group.
            let best = arr[0], bestScore = score(best);
            for (let i = 1; i < arr.length; i++) {
                const s = score(arr[i]);
                if (s > bestScore) { best = arr[i]; bestScore = s; }
            }
            byId.set(id, best);
        }

        const out: ActorOnMap[] = [];
        for (const e of byId.values()) {
            out.push({ id: e.id, cell: e.cell, speed: e.speed, kindEnum: e.kindEnum, kindDefCls: e.kindDefCls });
        }
        console.log(`[mapstate] listActorsOnMap: ${raw.length} raw → ${out.length} kept (${ghostGroupsDropped} ghost groups dropped)`);
        return out;
    });
}

export interface InteractiveOnMap {
    elementId: string;    // map-scoped instance id (Int64 as string)
    cell: number;         // cellId where it sits
    typeId: number;       // InteractiveData.id — the catalogue key
    name: string;         // localized name (e.g. "Ortie", "Frêne")
}

/**
 * Atomically dump every monster-group info bucket (`eik` instances) in the
 * heap — each eik holds djcr (leader `ev`) + djcs (list of underling `ev`).
 * Each `ev` has (cuzt=monsterId, cuzu=?, cuzv=level?) plus an EntityLook.
 * Returns one entry per eik with a sum of the "level-like" field so we can
 * correlate with the in-game tooltip totals (94, 96, 50, 17, …).
 */
export function dumpMonsterGroups(): Promise<Array<{
    handle: string;
    leader: { cuzt: number; cuzu: number; cuzv: number };
    underlings: Array<{ cuzt: number; cuzu: number; cuzv: number }>;
    sum_cuzu: number;
    sum_cuzv: number;
}>> {
    return inVm(() => {
        let eikKlass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "eik") { eikKlass = k; break; }
                }
            } catch {}
            if (eikKlass) break;
        }
        const out: Array<any> = [];
        if (!eikKlass) return out;
        let insts: Il2Cpp.Object[] = [];
        try { insts = Il2Cpp.gc.choose(eikKlass); } catch { return out; }

        const readEv = (ev: any) => {
            const r = { cuzt: 0, cuzu: 0, cuzv: 0 };
            if (!ev) return r;
            try { r.cuzt = Number(ev.field("cuzt").value); } catch {}
            try { r.cuzu = Number(ev.field("cuzu").value); } catch {}
            try { r.cuzv = Number(ev.field("cuzv").value); } catch {}
            return r;
        };

        for (const eik of insts) {
            try {
                const leaderObj = eik.field("djcr").value as any;
                const leader = readEv(leaderObj);
                const underlings: any[] = [];
                try {
                    const list = eik.field("djcs").value as any;
                    if (list) {
                        const n = Number(list.method("get_Count").invoke());
                        for (let i = 0; i < n; i++) {
                            try {
                                const u = list.method("get_Item").invoke(i) as any;
                                underlings.push(readEv(u));
                            } catch {}
                        }
                    }
                } catch {}
                const sum_cuzu = leader.cuzu + underlings.reduce((s, u) => s + u.cuzu, 0);
                const sum_cuzv = leader.cuzv + underlings.reduce((s, u) => s + u.cuzv, 0);
                out.push({ handle: String(eik.handle), leader, underlings, sum_cuzu, sum_cuzv });
            } catch {}
        }
        return out;
    });
}

/**
 * Read EntityInfo.djae (Dictionary<dqo, String>) for each requested actorId.
 * The djae map holds the entity's localized strings — name, tooltip, kind-label.
 * Stays in VM (single perform call) so GC ordering can't shift mid-read.
 */
export function getEntityInfoByActorIds(actorIds: string[]): Promise<Record<string, { props: Record<string, string>; valueCount: number }>> {
    return inVm(() => {
        // Locate the eic class (dict holder).
        let eicKlass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "eic") { eicKlass = k; break; }
                }
            } catch {}
            if (eicKlass) break;
        }
        const out: Record<string, { props: Record<string, string>; valueCount: number }> = {};
        if (!eicKlass) return out;
        const inst = Il2Cpp.gc.choose(eicKlass);
        if (!inst.length) return out;
        const eic = inst[0];
        const dict = eic.field("djbp").value as any;
        if (!dict) return out;

        // Walk the dict's _entries — only live slots (hashCode >= 0).
        let entries: any, count = 0;
        try { entries = dict.field("_entries").value; count = Number(dict.field("_count").value); } catch { return out; }
        const want = new Set(actorIds);

        for (let i = 0; i < count; i++) {
            try {
                const e = entries.get(i);
                let hashCode = 0;
                try { hashCode = Number(e.field("hashCode").value); } catch {}
                if (hashCode < 0) continue;
                const key = String(e.field("key").value);
                if (!want.has(key)) continue;
                const einfo = e.field("value").value as any;
                if (!einfo) continue;

                // Read EntityInfo.djae (Dictionary<dqo, String>) — the string bag.
                const props: Record<string, string> = {};
                let valueCount = 0;
                try {
                    const djae = einfo.field("djae").value as any;
                    if (djae) {
                        valueCount = Number(djae.method("get_Count").invoke());
                        const innerEntries = djae.field("_entries").value as any;
                        const innerCount = Number(djae.field("_count").value);
                        for (let j = 0; j < innerCount; j++) {
                            try {
                                const ie = innerEntries.get(j);
                                let ih = 0;
                                try { ih = Number(ie.field("hashCode").value); } catch {}
                                if (ih < 0) continue;
                                const k = String(ie.field("key").value).replace(/^"|"$/g, "");
                                const v = String(ie.field("value").value).replace(/^"|"$/g, "");
                                props[k] = v.slice(0, 200);
                            } catch {}
                        }
                    }
                } catch {}

                // Also pull the djbf UInt64 (the "djbf" field we saw on EntityInfo).
                try { props["_djbf"] = String(einfo.field("djbf").value); } catch {}
                try { props["_class"] = einfo.class?.name ?? ""; } catch {}

                out[key] = { props, valueCount };
                if (Object.keys(out).length >= want.size) break;
            } catch {}
        }
        return out;
    });
}

/**
 * Debug helper: atomically snapshot the raw Entity fields for a list of actor
 * ids, within a single VM perform() call so GC ordering can't shift between
 * reads. Useful for comparing two or more entities side by side when hunting
 * what distinguishes kind-A from kind-B (e.g. jyz enum values).
 */
export function dumpEntitiesByActorId(actorIds: string[]): Promise<Record<string, Record<string, string>>> {
    return inVm(() => {
        const want = new Set(actorIds);
        let entKlass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "Entity" && k.namespace === "Core.Rendering.Entity") {
                        entKlass = k; break;
                    }
                }
            } catch {}
            if (entKlass) break;
        }
        const out: Record<string, Record<string, string>> = {};
        if (!entKlass) return out;
        let insts: Il2Cpp.Object[] = [];
        try { insts = Il2Cpp.gc.choose(entKlass); } catch { return out; }
        for (const ent of insts) {
            try {
                const idRaw = ent.field("<czpe>k__BackingField").value as any;
                const id = String(idRaw);
                if (!want.has(id)) continue;
                const dump: Record<string, string> = {};
                for (const f of entKlass.fields) {
                    if (f.isStatic) continue;
                    try {
                        const v = ent.field(f.name).value;
                        if (v === null || v === undefined) { dump[f.name] = "null"; continue; }
                        const t = typeof v;
                        if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
                            dump[f.name] = String(v);
                        } else if ((v as any).class) {
                            dump[f.name] = `${(v as any).class.name}@${(v as any).handle}`;
                        } else {
                            dump[f.name] = String(v);
                        }
                    } catch (e) { dump[f.name] = `<err ${String(e).slice(0, 40)}>`; }
                }
                // Also add kcp-style info from physics.
                try {
                    const phys = ent.field("czox").value as any;
                    if (phys && phys.class) {
                        dump["_phys_cell"] = String(phys.field("<czuk>k__BackingField").value);
                        dump["_phys_speed"] = String(phys.field("czuh").value);
                    }
                } catch {}
                out[id] = dump;
                if (Object.keys(out).length >= want.size) break;
            } catch {}
        }
        return out;
    });
}

/**
 * Walk the runtime "interactive elements" store on the current map and resolve
 * each to its catalogue entry (InteractiveData.name). The store's exact name
 * is obfuscated (Ankama class `dvi` holding a Dictionary<Int64, InteractiveElementData>)
 * but we recognize it by its unique field type. Only elements with active
 * skills/state are in this dict — passive visuals (zaaps, doors) are not.
 */
export function getInteractivesOnMap(): Promise<InteractiveOnMap[]> {
    return inVm(() => {
        // Locate the obfuscated `dvi` class (has a Dictionary<Int64, InteractiveElementData>).
        let dviKlass: Il2Cpp.Class | null = null;
        let rootKlass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (!dviKlass && k.name === "dvi") dviKlass = k;
                    if (!rootKlass && k.name === "InteractivesDataRoot") rootKlass = k;
                }
            } catch {}
            if (dviKlass && rootKlass) break;
        }
        if (!dviKlass) return [];
        const dviInsts = Il2Cpp.gc.choose(dviKlass);
        if (!dviInsts.length) return [];
        const dvi = dviInsts[0];

        const dict = dvi.field("<dexl>k__BackingField").value as any;
        if (!dict) return [];

        // For name resolution: find the DataCenter root singleton.
        let rootInst: Il2Cpp.Object | null = null;
        let getById: Il2Cpp.Method<any> | null = null;
        if (rootKlass) {
            try {
                const arr = Il2Cpp.gc.choose(rootKlass);
                if (arr.length) rootInst = arr[0];
                getById = rootKlass.methods.find(m =>
                    m.name === "GetInteractiveById" && m.parameters.length === 1
                ) ?? null;
            } catch {}
        }

        const resolveName = (typeId: number): string => {
            if (!rootInst) return "";
            try {
                // For instance methods, bind to the instance — `klass.method().invoke()` would
                // treat it as static and fail.
                const m = rootInst.method("GetInteractiveById") as any;
                if (!m) return "";
                const data = m.invoke(typeId) as any;
                if (!data) return "";
                const n = data.method("get_name").invoke();
                return n ? String(n).replace(/^"|"$/g, "") : "";
            } catch { return ""; }
        };

        // Walk the Dictionary's internal `_entries` array — each slot holds
        // { hashCode, next, key, value } and slots with hashCode >= 0 are live.
        const out: InteractiveOnMap[] = [];
        try {
            const entries = dict.field("_entries").value as any;
            const count = Number(dict.field("_count").value);
            const length = entries && typeof entries.length === "number" ? entries.length : count;
            const N = Math.min(count, length);
            for (let i = 0; i < N; i++) {
                try {
                    const entry = entries.get(i);
                    let hashCode = 0;
                    try { hashCode = Number(entry.field("hashCode").value); } catch {}
                    if (hashCode < 0) continue;
                    const key = entry.field("key").value;
                    const val = entry.field("value").value as any;
                    if (!val) continue;
                    const element = val.field("element").value as any;
                    const pos = val.field("position").value as any;
                    // Try both cutm and cutn — resolveName returns "" for misses, so first
                    // hit with a non-empty name wins. cutn is usually elementTypeId but cutm
                    // can match on some element types; include both in the debug output.
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
        console.log(`[mapstate] getInteractivesOnMap: ${out.length} entries`);
        return out;
    });
}

/**
 * Quick lookup for any map in the DataCenter (no loading). Returns null if the
 * mapId isn't known to the client.
 */
export function getMapInfo(mapId: number): Promise<{
    id: number; posX: number; posY: number; subAreaId: number; worldMap: number; nameId: number; name?: string;
} | null> {
    return inVm(() => {
        // Find the MapInformationData class
        let klass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "MapInformationData") { klass = k; break; }
                }
            } catch {}
            if (klass) break;
        }
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
