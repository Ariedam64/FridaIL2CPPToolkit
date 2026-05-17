// World pathfinding — host-driven path injection auto-travel.
//
// The game's natural autotravel (tkw → bapj → walker) fails cold-fresh because
// `bapj` (the worker's A*) does a worldmap viewport validation that rejects
// destinations outside the currently-loaded region. We sidestep the validator
// entirely:
//   1. Host computes the path via JS A* over the cached world graph (see
//      app/plugins/dofus/lib/movement/world-path.ts) — pure topology, no
//      viewport check.
//   2. Agent allocates IL2CPP Edge/Vertex objects from that JSON path,
//      builds a fresh `List<Edge>`.
//   3. Agent writes the list into `worker.resultEdges`, kicks the state
//      machine with `tkw(dck)` (subscribes the walker even if bapj would
//      otherwise reject), and immediately fires `deliverResult(list)`. The
//      walker receives our forged path and walks it natively — isa per cell,
//      ito for map changes, iev for doors/zaaps/NPCs, client-desync recovery.
//
// Companion utilities exported from this module:
//   • triggerPathFindingDataLoad — preloads the PathFindingData asset on cold
//     attach so extractWorldGraph can read m_vertices / m_outgoingEdges.
//   • extractWorldGraph — flattens the in-memory graph for the host A*.

import "frida-il2cpp-bridge";
import { inVm, findClass } from "./_runtime";
import { getSingleton } from "../../../singleton-cache";

export interface WorldPathfindingProto {
    classes: {
        WorldPathfinder:        string;
        WorldPathfindingWorker: string;
        AutoTravelUiController: string;
        AutoTravelRequest:      string;
        MapRenderer:            string;
        Edge:                   string;
        Vertex:                 string;
    };
    fields: {
        WorldPathfindingWorker_resultEdges:  string;
        WorldPathfinder_pathFindingData:     string;
    };
    methods: {
        WorldPathfindingWorker_deliverResult:    string;
        WorldPathfinder_init:                    string;
        WorldPathfindingWorker_registerData1:    string;
        WorldPathfindingWorker_registerData2:    string;
        AutoTravelUiController_start:            string;
        MapRenderer_Update:                      string;
        Edge_addTransition:                      string;
    };
}

// =============================================================================
// Path edge shape — JSON contract with the host (matches
// app/plugins/dofus/lib/movement/world-path.ts:PathEdgeOut).
// =============================================================================

export interface PathTransitionJson {
    cellId:          number;
    direction:       number | null;   // pn enum; null → 0
    skillId:         number;
    transitionMapId: string;          // long, stringified host-side
    type:            number;
    criterion:       string | null;
    id:              string;          // long, stringified host-side
}
export interface PathVertexJson {
    mapId:  string;   // long
    zoneId: number;
    uid:    string;   // ulong
}
export interface PathEdgeJson {
    from:        PathVertexJson;
    to:          PathVertexJson;
    transitions: PathTransitionJson[];
}

// =============================================================================
// Unity main-thread dispatcher.
//
// Frida's `Il2Cpp.perform` attaches a worker thread that is NOT Unity main —
// so UniTask continuations enqueued from forged invokes never fire. We hook
// `Core.Rendering.MapRenderer.Update` (always alive in-world, name never
// obfuscated) and drain a queue of pending tasks inside its `onLeave`, which
// runs on Unity main thread.
// =============================================================================

interface MainThreadTask { run: () => unknown; resolve: (v: unknown) => void; reject: (e: Error) => void; }
const _mainThreadQueue: MainThreadTask[] = [];
let _mainDispatchInstalled = false;
const MAIN_DISPATCH_TIMEOUT_MS = 2_000;

function ensureMainThreadDispatcher(proto: WorldPathfindingProto): boolean {
    if (_mainDispatchInstalled) return true;
    let target: Il2Cpp.Class | null = null;
    try {
        for (const asm of (Il2Cpp.domain as any).assemblies) {
            const k = asm.image.tryClass?.(proto.classes.MapRenderer);
            if (k) { target = k; break; }
        }
    } catch { /* fall through */ }
    if (!target) return false;
    const m = (target as any).tryMethod(proto.methods.MapRenderer_Update);
    if (!m || m.virtualAddress.isNull()) return false;
    Interceptor.attach(m.virtualAddress, {
        onLeave() {
            if (_mainThreadQueue.length === 0) return;
            const batch = _mainThreadQueue.splice(0, _mainThreadQueue.length);
            for (const task of batch) {
                try { task.resolve(task.run()); }
                catch (e) { task.reject(e instanceof Error ? e : new Error(String(e))); }
            }
        },
    });
    _mainDispatchInstalled = true;
    return true;
}

function dispatchOnMainThread<T>(proto: WorldPathfindingProto, fn: () => T): Promise<T> {
    if (!ensureMainThreadDispatcher(proto)) {
        return Promise.reject(new Error("main-thread dispatcher not installable"));
    }
    return new Promise<T>((resolve, reject) => {
        const task: MainThreadTask = {
            run: fn as () => unknown,
            resolve: resolve as (v: unknown) => void,
            reject,
        };
        _mainThreadQueue.push(task);
        // Safety net: if Update doesn't fire in time (loading screen, paused
        // tab, scene swap) the task would hang forever otherwise.
        setTimeout(() => {
            const idx = _mainThreadQueue.indexOf(task);
            if (idx >= 0) {
                _mainThreadQueue.splice(idx, 1);
                reject(new Error(`main-thread dispatch timeout (no Update in ${MAIN_DISPATCH_TIMEOUT_MS}ms)`));
            }
        }, MAIN_DISPATCH_TIMEOUT_MS);
    });
}

// =============================================================================
// IL2CPP object builders.
//
// Schema (per dumpClassAsString on the live build):
//   Vertex     { long m_mapId; int m_zoneId; ulong m_uid }
//                ctor(long, int, ulong)
//   Transition { int m_type; pn m_direction; int m_skillId; string m_criterion;
//                long m_transitionMapId; int m_cellId; long m_id }
//   Edge       { Vertex m_from; Vertex m_to; List<Transition> m_transitions }
//                ctor(Vertex, Vertex)
//                bgux(pn dir, int type, int skillId, string criterion,
//                     long transMapId, int cellId, long id)
//                  ← builds+appends a Transition. Saves us from resolving the
//                    generic `List<Transition>` concrete class for Add().
// =============================================================================

function buildVertex(vertexKlass: any, v: PathVertexJson): any {
    const inst = vertexKlass.new();
    inst.method(".ctor").invoke(
        new Int64(v.mapId),
        v.zoneId,
        new UInt64(v.uid),
    );
    return inst;
}

function buildEdge(
    edgeKlass: any,
    vertexKlass: any,
    addTransitionName: string,
    e: PathEdgeJson,
): any {
    const from = buildVertex(vertexKlass, e.from);
    const to   = buildVertex(vertexKlass, e.to);
    const edge = edgeKlass.new();
    edge.method(".ctor").invoke(from, to);
    const addTrans = edge.method(addTransitionName);
    for (const t of e.transitions) {
        // direction is a `pn` enum (Int32). null → 0 (walk-off-edge sentinel).
        const dir = t.direction == null ? 0 : t.direction;
        // Criterion is usually null — `NULL` for the native pointer slot.
        const criterion = t.criterion != null
            ? (Il2Cpp as any).string(t.criterion)
            : NULL;
        addTrans.invoke(
            dir,
            t.type,
            t.skillId,
            criterion,
            new Int64(t.transitionMapId),
            t.cellId,
            new Int64(t.id),
        );
    }
    return edge;
}

/** Allocate a fresh `List<Edge>` using the worker's resultEdges field type as
 *  the source-of-truth for the concrete generic instantiation. */
function buildEmptyEdgeList(workerInst: any, resultEdgesFieldName: string): any {
    const fieldRef = workerInst.field(resultEdgesFieldName);
    // Prefer the runtime type of the current value (set after any path
    // compute), fall back to the field's declared type for cold-fresh.
    let listClass: any = null;
    try {
        const cur = fieldRef.value;
        if (cur && cur.class && cur.class.type) listClass = cur.class;
    } catch { /* */ }
    if (!listClass) {
        try { listClass = (fieldRef as any).type?.class ?? null; } catch { /* */ }
    }
    if (!listClass) {
        throw new Error(`could not resolve List<Edge> generic class from worker.${resultEdgesFieldName}`);
    }
    const inst = listClass.new();
    inst.method(".ctor").invoke();
    return inst;
}

// =============================================================================
// Auto-travel — fire-and-walk.
// =============================================================================

/** Start an auto-travel with the host-computed edge list. The game's native
 *  walker handles every step (move + transitions) after we deliver the list. */
export function startAutoTravel(
    proto: WorldPathfindingProto,
    destMapId: number,
    edgesJson: PathEdgeJson[],
): Promise<{ ok: boolean; reason?: string; edgeCount?: number }> {
    return inVm(() => {
        const workerInst = getSingleton(proto.classes.WorldPathfindingWorker);
        if (!workerInst) return Promise.resolve({ ok: false, reason: `no live ${proto.classes.WorldPathfindingWorker}` });

        const edgeKlass = findClass(proto.classes.Edge);
        if (!edgeKlass)   return Promise.resolve({ ok: false, reason: `class ${proto.classes.Edge} not found` });
        const vertexKlass = findClass(proto.classes.Vertex);
        if (!vertexKlass) return Promise.resolve({ ok: false, reason: `class ${proto.classes.Vertex} not found` });

        const dckK = findClass(proto.classes.AutoTravelRequest);
        if (!dckK) return Promise.resolve({ ok: false, reason: `${proto.classes.AutoTravelRequest} class not found` });
        const controller = getSingleton(proto.classes.AutoTravelUiController);
        if (!controller) return Promise.resolve({ ok: false, reason: `no live ${proto.classes.AutoTravelUiController}` });

        let forgedList: any;
        try {
            forgedList = buildEmptyEdgeList(workerInst as any, proto.fields.WorldPathfindingWorker_resultEdges);
        } catch (e) {
            return Promise.resolve({ ok: false, reason: `alloc List<Edge> failed: ${String(e).slice(0, 200)}` });
        }

        const addEdge = (forgedList as any).method("Add");
        try {
            for (const ej of edgesJson) {
                const edge = buildEdge(edgeKlass, vertexKlass, proto.methods.Edge_addTransition, ej);
                addEdge.invoke(edge);
            }
        } catch (e) {
            return Promise.resolve({ ok: false, reason: `build edges failed: ${String(e).slice(0, 200)}` });
        }

        let dckReq: any;
        try {
            dckReq = (dckK as any).new();
            dckReq.method(".ctor").invoke(new Int64(destMapId.toString()), true);
        } catch (e) {
            return Promise.resolve({ ok: false, reason: `dck build failed: ${String(e).slice(0, 200)}` });
        }

        return dispatchOnMainThread(proto, () => {
            // (a) install the forged list as the worker's result
            (workerInst as any).field(proto.fields.WorldPathfindingWorker_resultEdges).value = forgedList;

            // (b) wake the state machine. tkw may throw "system error" if bapj
            //     would reject — fine, the walker still subscribed in tkw's
            //     preamble before bapj ran.
            try {
                (controller as any).method(proto.methods.AutoTravelUiController_start).invoke(dckReq);
            } catch { /* expected on rejected destinations */ }

            // (c) fire deliverResult with our list — walker picks it up.
            try {
                (workerInst as any).method(proto.methods.WorldPathfindingWorker_deliverResult).invoke(forgedList, true);
                return { ok: true, edgeCount: edgesJson.length } as { ok: boolean; reason?: string; edgeCount?: number };
            } catch (e) {
                return { ok: false, reason: `deliverResult: ${String((e as any)?.message ?? e).slice(0, 200)}` };
            }
        }).catch((e: Error) => ({ ok: false, reason: `dispatch failed: ${e.message}` }));
    });
}

// =============================================================================
// PathFindingData loader. Calls `ell.bapg()` (Init UniTask) and waits for the
// static `dkdy` to become non-null. Replicates the manual auto-travel's
// side-effect by calling the two static setters bgul + gmj so the worker's
// static `dplc` stays consistent with `dkdy` even though our extraction reads
// from `dkdy` only.
// =============================================================================

export interface TriggerLoadResult {
    ok: boolean;
    reason?: string;
    alreadyLoaded?: boolean;
    invokeThrew?: boolean;
    invokeError?: string;
    elapsedMs?: number;
    dkdyAfter?: string;
}

export async function triggerPathFindingDataLoad(req: { proto: WorldPathfindingProto; timeoutMs?: number }): Promise<TriggerLoadResult> {
    const timeoutMs = req.timeoutMs ?? 8000;
    const dkdyName = req.proto.fields.WorldPathfinder_pathFindingData;
    const initName = req.proto.methods.WorldPathfinder_init;
    const setter1Name = req.proto.methods.WorldPathfindingWorker_registerData1;
    const setter2Name = req.proto.methods.WorldPathfindingWorker_registerData2;

    const setup = await inVm(() => {
        const ell = getSingleton(req.proto.classes.WorldPathfinder);
        if (!ell) return { ok: false, reason: `no live ${req.proto.classes.WorldPathfinder}`, alreadyLoaded: false, invokeThrew: false, invokeError: "" };

        const klass: any = (ell as any).class;
        const dkdyBefore = klass.field(dkdyName)?.value;
        const alreadyLoaded = !!(dkdyBefore && !(dkdyBefore.isNull && dkdyBefore.isNull()));
        if (alreadyLoaded) {
            return { ok: true, alreadyLoaded: true, invokeThrew: false, invokeError: "" };
        }

        const initMethod = (ell as any).tryMethod(initName);
        if (!initMethod) {
            return { ok: false, reason: `method ${initName} not found on WorldPathfinder`, alreadyLoaded: false, invokeThrew: false, invokeError: "" };
        }

        let invokeThrew = false;
        let invokeError = "";
        try {
            // bapg() returns UniTask (struct). We don't care about the return
            // value — only the side-effect (dkdy getting populated as the
            // state-machine's MoveNext progresses across frames).
            initMethod.invoke();
        } catch (e) {
            invokeThrew = true;
            invokeError = String(e).slice(0, 240);
        }
        return { ok: true, alreadyLoaded: false, invokeThrew, invokeError };
    });
    if (!setup.ok) return { ok: false, reason: setup.reason };
    if (setup.alreadyLoaded) return { ok: true, alreadyLoaded: true, dkdyAfter: "<already populated>" };

    // Poll dkdy until non-null OR timeout. The UniTask runs on Unity's main
    // thread; we just see the field flip when Addressables finishes.
    const start = Date.now();
    let dkdyValue = "<unset>";
    let dkdyPopulated = false;
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
        const polled = await inVm(() => {
            const ell = getSingleton(req.proto.classes.WorldPathfinder);
            if (!ell) return { populated: false, value: "<no ell>" };
            try {
                const v = (ell as any).class.field(dkdyName).value;
                if (v && !(v.isNull && v.isNull())) return { populated: true, value: String(v).slice(0, 80) };
                return { populated: false, value: "null" };
            } catch (e) {
                return { populated: false, value: `<read fail: ${String(e).slice(0, 80)}>` };
            }
        });
        if (polled.populated) {
            dkdyValue = polled.value;
            dkdyPopulated = true;
            break;
        }
    }

    if (!dkdyPopulated) {
        return {
            ok: false,
            reason: `timed out after ${timeoutMs}ms (dkdy still null after invoking ${initName})`,
            invokeThrew: setup.invokeThrew,
            invokeError: setup.invokeError,
        };
    }

    // Register the loaded data with fpc via its two static setters — keeps the
    // worker's static state consistent with what the game sets up on a manual
    // auto-travel. Strictly unnecessary for our extraction, but cheap.
    await inVm(() => {
        const ell = getSingleton(req.proto.classes.WorldPathfinder);
        const fpcSingleton = getSingleton(req.proto.classes.WorldPathfindingWorker);
        if (!ell || !fpcSingleton) return;
        const data = (ell as any).class.field(dkdyName).value;
        if (!data || (data.isNull && data.isNull())) return;
        const fpcClass = (fpcSingleton as any).class;
        for (const setterName of [setter1Name, setter2Name]) {
            try {
                const m = (fpcClass as any).tryMethod(setterName);
                if (m) m.invoke(data);
            } catch { /* one of the two is enough */ }
        }
    });

    return {
        ok: true,
        alreadyLoaded: false,
        invokeThrew: setup.invokeThrew,
        invokeError: setup.invokeError,
        elapsedMs: Date.now() - start,
        dkdyAfter: dkdyValue,
    };
}

/** Convenience for the state page's on-mount handler — just primes the
 *  PathFindingData asset so the host can call /extract-graph right after. */
export async function initWorldPathfinding(proto: WorldPathfindingProto): Promise<{ ok: boolean; pathFindingDataLoad: TriggerLoadResult }> {
    const load = await triggerPathFindingDataLoad({ proto, timeoutMs: 8000 });
    return { ok: load.ok, pathFindingDataLoad: load };
}

// =============================================================================
// World-graph extraction. Walks the 3 Dictionaries inside the loaded
// PathFindingData (`ell.dkdy`) and serializes them to plain JSON which the
// host A* (app/plugins/dofus/lib/movement/world-path.ts) consumes:
//   m_vertices       : Dictionary<long mapId, Dictionary<int zoneId, Vertex>>
//   m_outgoingEdges  : Dictionary<long fromUid, EdgeListWrapper { m_edgeList: List<Edge> }>
// All field names are Unity SerializeFields — never obfuscated.
// =============================================================================

interface ExtractedVertex { mapId: string; zoneId: number; uid: string }
interface ExtractedTransition {
    cellId: number; direction: number | null; skillId: number;
    transitionMapId: string; type: number; criterion: string | null; id: string;
}
interface ExtractedEdge {
    fromUid: string; toUid: string;
    transitions: ExtractedTransition[];
}
export interface ExtractedWorldGraph {
    ok: boolean;
    reason?: string;
    vertices?: Record<string, ExtractedVertex>;
    outgoing?: Record<string, ExtractedEdge[]>;
    verticesByMap?: Record<string, Record<string, string>>;
    counts?: { vertices: number; edges: number; transitions: number };
    elapsedMs?: number;
}

/** Walk a `System.Collections.Generic.Dictionary<K, V>` by iterating its
 *  `_entries` backing array. Calls `visit(key, value)` for every live entry
 *  (hashCode >= 0). Works for `SerializableDictionary<K, V>` too. */
function walkDict(dict: any, visit: (k: any, v: any) => void): void {
    if (!dict || (dict.isNull && dict.isNull())) return;
    try {
        const count = Number(dict.field("_count").value);
        const entries = dict.field("_entries").value;
        if (!entries || (entries.isNull && entries.isNull())) return;
        const arr: any = entries;
        for (let i = 0; i < count; i++) {
            const e = arr.get(i);
            if (!e) continue;
            try {
                const hash = Number(e.field("hashCode").value);
                if (hash < 0) continue;
                visit(e.field("key").value, e.field("value").value);
            } catch { /* skip bad entry */ }
        }
    } catch { /* */ }
}

export function extractWorldGraph(req: { proto: WorldPathfindingProto }): Promise<ExtractedWorldGraph> {
    return inVm(() => {
        const startTs = Date.now();
        const ell = getSingleton(req.proto.classes.WorldPathfinder);
        if (!ell) return { ok: false, reason: `no live ${req.proto.classes.WorldPathfinder}` };
        const dkdy = (ell as any).class.field(req.proto.fields.WorldPathfinder_pathFindingData).value;
        if (!dkdy || (dkdy.isNull && dkdy.isNull())) {
            return { ok: false, reason: `${req.proto.fields.WorldPathfinder_pathFindingData} is null — run /init first to populate it via ${req.proto.methods.WorldPathfinder_init}` };
        }

        const vertices: Record<string, ExtractedVertex> = {};
        const outgoing: Record<string, ExtractedEdge[]> = {};
        const verticesByMap: Record<string, Record<string, string>> = {};

        // Pass 1: m_vertices — Dictionary<long, Dictionary<int, Vertex>>
        walkDict((dkdy as any).field("m_vertices").value, (_mapIdKey: any, innerDict: any) => {
            walkDict(innerDict, (_zoneIdKey: any, vert: any) => {
                if (!vert) return;
                try {
                    const v: ExtractedVertex = {
                        mapId: String(vert.field("m_mapId").value),
                        zoneId: Number(vert.field("m_zoneId").value),
                        uid: String(vert.field("m_uid").value),
                    };
                    vertices[v.uid] = v;
                    if (!verticesByMap[v.mapId]) verticesByMap[v.mapId] = {};
                    verticesByMap[v.mapId][String(v.zoneId)] = v.uid;
                } catch { /* skip */ }
            });
        });

        // Pass 2: m_outgoingEdges — Dictionary<long, EdgeListWrapper>
        let totalEdges = 0;
        let totalTrans = 0;
        walkDict((dkdy as any).field("m_outgoingEdges").value, (fromUidKey: any, wrapper: any) => {
            if (!wrapper) return;
            const fromUid = String(fromUidKey);
            const edgesList = (() => {
                try { return wrapper.field("m_edgeList").value; }
                catch { return null; }
            })();
            if (!edgesList || (edgesList.isNull && edgesList.isNull())) return;
            const list: ExtractedEdge[] = [];
            try {
                const size = Number(edgesList.field("_size").value);
                const items = edgesList.field("_items").value;
                for (let i = 0; i < size; i++) {
                    const edge = items.get(i);
                    if (!edge) continue;
                    try {
                        const toVert = edge.field("m_to").value;
                        const toUid = String(toVert.field("m_uid").value);
                        const trList = edge.field("m_transitions").value;
                        const trans: ExtractedTransition[] = [];
                        if (trList && !(trList.isNull && trList.isNull())) {
                            const tsize = Number(trList.field("_size").value);
                            const titems = trList.field("_items").value;
                            for (let j = 0; j < tsize; j++) {
                                const t = titems.get(j);
                                if (!t) continue;
                                try {
                                    trans.push({
                                        cellId: Number(t.field("m_cellId").value),
                                        direction: (() => {
                                            try {
                                                const v = t.field("m_direction").value;
                                                if (v == null) return null;
                                                const n = Number(v);
                                                return Number.isFinite(n) ? n : null;
                                            } catch { return null; }
                                        })(),
                                        skillId: Number(t.field("m_skillId").value),
                                        transitionMapId: String(t.field("m_transitionMapId").value),
                                        type: Number(t.field("m_type").value),
                                        criterion: (() => { try { const v = t.field("m_criterion").value; return v == null ? null : String(v); } catch { return null; } })(),
                                        id: String(t.field("m_id").value),
                                    });
                                    totalTrans++;
                                } catch { /* skip */ }
                            }
                        }
                        list.push({ fromUid, toUid, transitions: trans });
                        totalEdges++;
                    } catch { /* skip bad edge */ }
                }
            } catch { /* */ }
            if (list.length > 0) outgoing[fromUid] = list;
        });

        return {
            ok: true,
            vertices,
            outgoing,
            verticesByMap,
            counts: {
                vertices: Object.keys(vertices).length,
                edges: totalEdges,
                transitions: totalTrans,
            },
            elapsedMs: Date.now() - startTs,
        };
    });
}
