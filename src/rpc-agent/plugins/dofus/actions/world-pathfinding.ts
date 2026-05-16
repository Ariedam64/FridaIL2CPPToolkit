// World pathfinding — bapj-free implementation.
//
// We don't invoke WorldPathfinder.bapj from our side anymore: it blows the
// Frida-thread stack inside the async state-machine's A* loop (66k+ alloca-
// heavy iterations — the Frida script thread is ~1 MB while Unity main is
// multi-megabyte). Instead the runtime is just a thin layer over what's
// already loaded in the game:
//
//   1. `triggerPathFindingDataLoad` calls `ell.bapg()` (Init UniTask) so the
//      Addressables-loaded `PathFindingData` lands in `ell.dkdy` /
//      `fpc.dplc` — same state the game sets up the first time the user
//      opens an auto-travel manually.
//   2. `extractWorldGraph` walks the three Dictionaries inside that
//      PathFindingData (m_vertices, m_edges, m_outgoingEdges — Unity
//      SerializeFields, never obfuscated) and returns the whole graph as
//      plain JSON.
//   3. Path computation itself happens in pure JS over the cached graph —
//      see `app/plugins/dofus/lib/world-path-js.ts`.
//
// What's left from the bapj era: passive Interceptor hooks on bapc and nwf
// that observe in-game auto-travels (diag log + last cached path reader).
// None of them invoke anything.

import { inVm, findClass } from "./_runtime";
import { getSingleton } from "../../../singleton-cache";
import { getStackFrames } from "../../../../lib/stack-trace";

export interface WorldPathfindingProto {
    classes: {
        AutoTravelManager:      string;
        WorldPathfinder:        string;
        WorldPathfindingWorker: string;
        AutoTravelUiController: string;
        AutoTravelRequest:      string;
        MapRenderer:            string;
    };
    fields: {
        AutoTravelManager_pathfinderContext: string;
        WorldPathfinder_worker:              string;
        WorldPathfinder_startVertex:         string;
        WorldPathfinder_destMapId:           string;
        WorldPathfinder_state:               string;
        WorldPathfindingWorker_resultEdges:  string;
        WorldPathfinder_pathFindingData:     string;
        AutoTravelRequest_destMapId:          string;
        AutoTravelRequest_skipConfirmation:   string;
    };
    methods: {
        AutoTravelManager_startAutoTravel:    string;
        WorldPathfinder_computePath:          string;
        WorldPathfindingWorker_deliverResult: string;
        WorldPathfinder_init:                 string;
        WorldPathfindingWorker_registerData1: string;
        WorldPathfindingWorker_registerData2: string;
        AutoTravelUiController_start:         string;
        MapRenderer_Update:                   string;
    };
}

export interface PathTransition {
    cellId: number;
    direction: number;
    skillId: number;
    transitionMapId: string;
    type: number;
    criterion: string | null;
    id: string;
}
export interface PathVertex { mapId: string; zoneId: number; uid: string }
export interface PathEdge {
    from: PathVertex;
    to: PathVertex;
    transitions: PathTransition[];
}

// -----------------------------------------------------------------------------
// Edge/Vertex/Transition readers. `Core.PathFinding.WorldPathfinding.*` is a
// clear-named namespace, so the m_* field names survive obfuscation.
// -----------------------------------------------------------------------------

function readVertex(v: any): PathVertex | null {
    if (!v || (v.isNull && v.isNull())) return null;
    try {
        return {
            mapId: String(v.field("m_mapId").value),
            zoneId: Number(v.field("m_zoneId").value),
            uid: String(v.field("m_uid").value),
        };
    } catch { return null; }
}

function readEdge(e: any): PathEdge | null {
    if (!e || (e.isNull && e.isNull())) return null;
    try {
        const from = readVertex(e.field("m_from").value);
        const to = readVertex(e.field("m_to").value);
        if (!from || !to) return null;
        const transitions: PathTransition[] = [];
        const trList = e.field("m_transitions").value;
        if (trList && !trList.isNull()) {
            const n = Number((trList as any).method("get_Count").invoke());
            const itemMethod = (trList as any).method("get_Item");
            for (let i = 0; i < n; i++) {
                const t = itemMethod.invoke(i);
                if (!t || t.isNull()) continue;
                transitions.push({
                    cellId:          Number(t.field("m_cellId").value),
                    direction:       Number(t.field("m_direction").value),
                    skillId:         Number(t.field("m_skillId").value),
                    transitionMapId: String(t.field("m_transitionMapId").value),
                    type:            Number(t.field("m_type").value),
                    criterion:       (() => { try { return String(t.field("m_criterion").value); } catch { return null; } })(),
                    id:              String(t.field("m_id").value),
                });
            }
        }
        return { from, to, transitions };
    } catch { return null; }
}

function readEdgeList(list: any): PathEdge[] {
    const edges: PathEdge[] = [];
    if (!list || (list.isNull && list.isNull())) return edges;
    try {
        const n = Number((list as any).method("get_Count").invoke());
        const itemMethod = (list as any).method("get_Item");
        for (let i = 0; i < n; i++) {
            const parsed = readEdge(itemMethod.invoke(i));
            if (parsed) edges.push(parsed);
        }
    } catch { /* */ }
    return edges;
}

export interface CachedWorldPath {
    ok: boolean;
    reason?: string;
    destMapId?: string;
    state?: number;
    startVertex?: PathVertex | null;
    edges?: PathEdge[];
}

/** Read the last cached world path from the WorldPathfinder instance — pure
 *  field reads, no side effects on the game. Populated by in-game auto-travels
 *  (or anything else that runs the worker), not by us. */
export function readCachedWorldPath(proto: WorldPathfindingProto): Promise<CachedWorldPath> {
    return inVm(() => {
        const ell = getSingleton(proto.classes.WorldPathfinder);
        if (!ell) return { ok: false, reason: `no live ${proto.classes.WorldPathfinder} (WorldPathfinder) instance` };
        const inst = ell as any;
        const result: CachedWorldPath = { ok: true };
        try {
            result.destMapId   = String(inst.field(proto.fields.WorldPathfinder_destMapId).value);
            result.state       = Number(inst.field(proto.fields.WorldPathfinder_state).value);
            result.startVertex = readVertex(inst.field(proto.fields.WorldPathfinder_startVertex).value);
            const worker = inst.field(proto.fields.WorldPathfinder_worker).value;
            result.edges = (worker && !worker.isNull())
                ? readEdgeList(worker.field(proto.fields.WorldPathfindingWorker_resultEdges).value)
                : [];
        } catch (e) {
            result.ok = false;
            result.reason = `read failed: ${String(e).slice(0, 200)}`;
        }
        return result;
    });
}

// -----------------------------------------------------------------------------
// Observation hooks (passive — they only read args + log).
//   • WorldPathfindingWorker.deliverResult (nwf): captures the result List<Edge>
//     when the game itself publishes a path (= someone did an in-game auto-
//     travel). Useful as a "what did the user just compute?" channel.
//   • AutoTravelManager.startAutoTravel (bapc): logs destMapId of every
//     in-game auto-travel.
// -----------------------------------------------------------------------------

let _hooksInstalled = false;
let _lastCapture: PathEdge[] | null = null;
let _captureSeq = 0;
let _diagLog: string[] = [];

// -----------------------------------------------------------------------------
// Unity main-thread dispatcher.
// Some IL2CPP methods (UniTask coroutines, MonoBehaviour callbacks) only run
// correctly when invoked from Unity's main thread. Frida's `Il2Cpp.perform`
// attaches a worker thread to the runtime but it's NOT Unity main, so async
// continuations registered from there never fire. We work around it by
// hooking a MonoBehaviour.Update (Core.Rendering.MapRenderer.Update is
// always alive when the player is in-world) and draining a queue of pending
// tasks from inside that hook — which IS on Unity main thread.
// -----------------------------------------------------------------------------

interface MainThreadTask { run: () => unknown; resolve: (v: unknown) => void; reject: (e: Error) => void; }
const _mainThreadQueue: MainThreadTask[] = [];
let _mainDispatchInstalled = false;
const MAIN_DISPATCH_TIMEOUT_MS = 2_000;

/** Hook `MapRenderer.Update` once per session; idempotent. Resolves the
 *  obfuscated class+method via the caller-supplied proto so a future rename
 *  is auto-handled by the LabelStore. Tasks queued via `dispatchOnMainThread`
 *  drain inside the hook's onLeave — guaranteed Unity main thread context. */
function ensureMainThreadDispatcher(proto: WorldPathfindingProto): boolean {
    if (_mainDispatchInstalled) return true;
    const className = proto.classes.MapRenderer;
    const methodName = proto.methods.MapRenderer_Update;
    let target: Il2Cpp.Class | null = null;
    try {
        for (const asm of (Il2Cpp.domain as any).assemblies) {
            const k = asm.image.tryClass?.(className);
            if (k) { target = k; break; }
        }
    } catch { /* fall through */ }
    if (!target) { diag(`main-dispatch: class ${className} not found`); return false; }
    const m = (target as any).tryMethod(methodName);
    if (!m || m.virtualAddress.isNull()) { diag(`main-dispatch: ${methodName} not found on ${className}`); return false; }
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
    diag(`main-dispatch installed @ ${m.virtualAddress} (${className}.${methodName})`);
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
/** Set true while `startNativeAutoTravel` is invoking dtw.tlb so the bapc
 *  Interceptor's onEnter handler bails out — re-entering Frida's trampoline
 *  + Thread.backtrace + Il2Cpp method-table lookup from inside our own RPC
 *  call corrupts the perform context ("breakpoint triggered"). The hook is
 *  passive diag only; skipping it during self-invocation is harmless. */
let _selfInvokingNative = false;
function diag(msg: string): void {
    _diagLog.push(`[${Date.now() % 100000}] ${msg}`);
    if (_diagLog.length > 200) _diagLog.shift();
}


function installHooks(proto: WorldPathfindingProto): boolean {
    if (_hooksInstalled) return true;

    const fpc = getSingleton(proto.classes.WorldPathfindingWorker);
    const elj = getSingleton(proto.classes.AutoTravelManager);
    if (!fpc) { diag(`install: no live ${proto.classes.WorldPathfindingWorker}`); return false; }
    if (!elj) { diag(`install: no live ${proto.classes.AutoTravelManager}`); return false; }

    try {
        const nwf = (fpc as any).class.tryMethod(proto.methods.WorldPathfindingWorker_deliverResult);
        if (nwf && !nwf.virtualAddress.equals(NULL)) {
            Interceptor.attach(nwf.virtualAddress, {
                onEnter(args) {
                    // Same re-entrancy guard as the bapc hook — wrapping an
                    // Il2Cpp.Object + walking the List<Edge> during our own
                    // perform-block invocation of dtw.tlb corrupts the JIT
                    // state ("breakpoint triggered") and tlb's path-compute
                    // continuation never runs.
                    if (_selfInvokingNative) return;
                    try {
                        const listPtr = args[1];
                        if (listPtr.equals(NULL)) { diag("deliverResult: NULL list"); return; }
                        const edges = readEdgeList(new (Il2Cpp as any).Object(listPtr));
                        if (edges.length > 0) {
                            _lastCapture = edges;
                            _captureSeq++;
                            diag(`deliverResult: ${edges.length} edge(s)`);
                        }
                    } catch (e) { diag(`deliverResult hook err: ${String(e).slice(0, 80)}`); }
                },
            });
            diag(`deliverResult hook installed @ ${nwf.virtualAddress}`);
        } else {
            diag(`install: ${proto.methods.WorldPathfindingWorker_deliverResult} not found`);
        }

        const bapc = (elj as any).class.tryMethod(proto.methods.AutoTravelManager_startAutoTravel);
        if (bapc && !bapc.virtualAddress.equals(NULL)) {
            Interceptor.attach(bapc.virtualAddress, {
                onEnter(args) {
                    // Skip the entire handler if we're the ones invoking
                    // (via startNativeAutoTravel → dtw.tlb → bapc). Frida
                    // re-entrancy from inside our own RPC corrupts state.
                    if (_selfInvokingNative) return;
                    try {
                        diag(`bapc: destMapId=${args[1].toString()}`);
                        // Capture caller chain — resolved to "Class.method+
                        // 0xoff" via the shared IL2CPP method-address table
                        // (src/lib/stack-trace.ts). The frame immediately
                        // above bapc is the higher-level wrapper that builds
                        // the cb and calls us — that's the entry we want.
                        const frames = getStackFrames(this.context, 8);
                        for (let i = 0; i < frames.length; i++) {
                            diag(`  bt[${i}] ${frames[i]}`);
                        }
                    } catch (e) {
                        diag(`bapc hook err: ${String(e).slice(0, 120)}`);
                    }
                },
            });
            diag(`bapc hook installed @ ${bapc.virtualAddress}`);
        }

        _hooksInstalled = true;
        return true;
    } catch (e) {
        diag(`install threw: ${String(e).slice(0, 100)}`);
        return false;
    }
}

/** Diagnostic helper: install lightweight Interceptor hooks on EVERY method
 *  of the `dtw` class (the world-map auto-travel controller). Each call logs
 *  "dtw.<method>(args)" to the diag log so we can observe the natural call
 *  sequence during a user-triggered auto-travel. Use to identify the
 *  pre/post steps that wrap dtw.tlb in the real flow. Safe to call multiple
 *  times — idempotent. */

/** Invoke `AutoTravelManager.startAutoTravel(destMapId, null, false)` — the
 *  public entry point the game uses when the user double-clicks a worldmap
 *  destination. The client handles path compute + walking + transitions
 *  (iev / NPC dialogs / zaaps / boats) on its own, exactly as if the user
 *  had triggered it manually. No callback, no flag — minimal invocation. */
/** Forge a native auto-travel — equivalent to a double-click on the worldmap.
 *
 *  Flow:
 *    1. Build `AutoTravelRequest(destMapId, skipConfirmation=true)` (dck)
 *    2. Dispatch `AutoTravelUiController.startTravelFromRequest(req)` (dtw.tkw)
 *       through a Unity-main-thread queue so UniTask continuations land in
 *       the right scheduler context. Without this the path is computed but
 *       the walking executor never picks up (registered on the wrong sched).
 *
 *  All class/method/field names go through `proto.*` — resilient to obf
 *  rotations as long as the LabelStore is seeded (we POST friendly names on
 *  attach so the resolver hits even before a manual rename). */
export function startNativeAutoTravel(
    proto: WorldPathfindingProto,
    destMapId: number,
): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        const dckK = findClass(proto.classes.AutoTravelRequest);
        if (!dckK) return Promise.resolve({ ok: false, reason: `${proto.classes.AutoTravelRequest} class not found` });
        const controller = getSingleton(proto.classes.AutoTravelUiController);
        if (!controller) return Promise.resolve({ ok: false, reason: `no live ${proto.classes.AutoTravelUiController} instance` });

        let req: any;
        try {
            req = (dckK as any).new();
            // dck has a single 2-arg ctor(Int64 destMapId, Boolean skipConfirmation).
            req.method(".ctor").invoke(new Int64(destMapId.toString()), true);
        } catch (e) {
            return Promise.resolve({ ok: false, reason: `${proto.classes.AutoTravelRequest} build failed: ${String(e).slice(0, 200)}` });
        }

        return dispatchOnMainThread(proto, () => {
            _selfInvokingNative = true;
            try {
                (controller as any).method(proto.methods.AutoTravelUiController_start).invoke(req);
                diag(`autoTravel(${destMapId}) dispatched on main-thread`);
                return { ok: true } as { ok: boolean; reason?: string };
            } catch (e) {
                const msg = String(e).slice(0, 200);
                diag(`autoTravel(${destMapId}) threw: ${msg}`);
                return { ok: false, reason: msg };
            } finally {
                _selfInvokingNative = false;
            }
        }).catch((e: Error) => ({ ok: false, reason: `dispatch failed: ${e.message}` }));
    });
}

/** Drain diagnostic log — used by /api/dofus/world-pathfinding/diag. */
export function getWorldPathfindingDiag(): Promise<{ hooksInstalled: boolean; captureSeq: number; log: string[] }> {
    return inVm(() => ({
        hooksInstalled: _hooksInstalled,
        captureSeq: _captureSeq,
        log: _diagLog.slice(),
    }));
}

// -----------------------------------------------------------------------------
// PathFindingData loader. Invokes `ell.bapg()` (Init UniTask, async) and waits
// for the static `dkdy` to become non-null. Also replicates the manual auto-
// travel's side-effect on `fpc` by calling the two static setters bgul + gmj
// — that keeps the worker's static `dplc` consistent with `dkdy` even though
// our extraction reads from `dkdy` only.
// -----------------------------------------------------------------------------

export interface TriggerLoadRequest {
    proto: WorldPathfindingProto;
    timeoutMs?: number;
}
export interface TriggerLoadResult {
    ok: boolean;
    reason?: string;
    alreadyLoaded?: boolean;
    invokeThrew?: boolean;
    invokeError?: string;
    elapsedMs?: number;
    dkdyAfter?: string;
}

export async function triggerPathFindingDataLoad(req: TriggerLoadRequest): Promise<TriggerLoadResult> {
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

    // Register the loaded data with fpc via its two static setters. They
    // populate `fpc.dplc` (same PathFindingData) — strictly unnecessary for
    // our extraction, but keeps fpc's state consistent with what the game
    // sets up on a manual auto-travel.
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

/** Install observation hooks AND kick off the PathFindingData load if `dkdy`
 *  is still null. Idempotent. Called by the state page on mount so the cold-
 *  attach state ends up ready for `/extract-graph` without manual prep. */
export interface InitHooksResult {
    ok: boolean;
    hooksInstalled: boolean;
    pathFindingDataLoad: TriggerLoadResult;
}
export async function initWorldPathfindingHooks(proto: WorldPathfindingProto): Promise<InitHooksResult> {
    const hooksInstalled = await inVm(() => installHooks(proto));
    const load = await triggerPathFindingDataLoad({ proto, timeoutMs: 8000 });
    // `ok` mirrors hook-install success only: load failures still let the
    // frontend show an "initialized" state (the user can fall back to an
    // in-game auto-travel to populate dkdy from the natural flow).
    return {
        ok: hooksInstalled,
        hooksInstalled,
        pathFindingDataLoad: load,
    };
}

// -----------------------------------------------------------------------------
// World graph extraction. Walks the 3 Dictionaries inside the loaded
// PathFindingData (`ell.dkdy`) and serializes them to plain JSON which the JS
// A* (app/plugins/dofus/lib/world-path-js.ts) consumes:
//   m_vertices       : Dictionary<long mapId, Dictionary<int zoneId, Vertex>>
//   m_edges          : Dictionary<long fromUid, Dictionary<long toUid, Transition>>
//                      (NOT walked — we get transitions via m_outgoingEdges)
//   m_outgoingEdges  : Dictionary<long fromUid, EdgeListWrapper { m_edgeList: List<Edge> }>
//                      Edge { m_from, m_to, m_transitions: List<Transition> }
// All field names are Unity SerializeFields — never obfuscated.
// -----------------------------------------------------------------------------

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
 *  (hashCode >= 0). Works for `SerializableDictionary<K, V>` too — it inherits
 *  Dictionary's storage layout. */
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
                const key = e.field("key").value;
                const value = e.field("value").value;
                visit(key, value);
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
        const mVertices = (dkdy as any).field("m_vertices").value;
        walkDict(mVertices, (_mapIdKey: any, innerDict: any) => {
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
        const mOutgoing = (dkdy as any).field("m_outgoingEdges").value;
        walkDict(mOutgoing, (fromUidKey: any, wrapper: any) => {
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
