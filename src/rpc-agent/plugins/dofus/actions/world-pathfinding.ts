// World pathfinding (AutoTravel) — pure path compute, no movement.
//
// Three classes are in play:
//   AutoTravelManager       — wraps the auto-travel flow; bapc() = compute + walk
//   WorldPathfinder         — has computePath() = pure A* (no walking)
//   WorldPathfindingWorker  — owns the A* worker + the result List<Edge>
//
// The active flow (computeWorldPath) invokes WorldPathfinder.computePath with
// cb=NULL, which produces the path in WorldPathfindingWorker.resultEdges
// without triggering the bapc movement lambda. Two channels capture the
// result: a hook on WorldPathfindingWorker.deliverResult (preferred, signals
// `fresh: true`) and polling resultEdges directly.
//
// All obf names go through WorldPathfindingProto resolved on the backend so
// renames in the labels UI survive cross-version migration.

import { inVm } from "./_runtime";
import { getSingleton } from "../../../singleton-cache";

export interface WorldPathfindingProto {
    classes: {
        AutoTravelManager:      string;
        WorldPathfinder:        string;
        WorldPathfindingWorker: string;
    };
    fields: {
        AutoTravelManager_pathfinderContext: string;
        WorldPathfinder_worker:              string;
        WorldPathfinder_startVertex:         string;
        WorldPathfinder_destMapId:           string;
        WorldPathfinder_state:               string;
        WorldPathfindingWorker_resultEdges:  string;
    };
    methods: {
        AutoTravelManager_startAutoTravel:    string;
        WorldPathfinder_computePath:          string;
        WorldPathfindingWorker_deliverResult: string;
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
 *  field reads, no side effects on the game. */
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
// Hooks:
//   • WorldPathfindingWorker.deliverResult (nwf) — captures the published path
//     synchronously; lets computeWorldPath report `fresh: true` on success.
//   • AutoTravelManager.startAutoTravel (bapc) — observe-only diag, useful to
//     see in-game auto-travels alongside our active invokes.
// -----------------------------------------------------------------------------

let _hooksInstalled = false;
let _lastCapture: PathEdge[] | null = null;
let _captureSeq = 0;
let _diagLog: string[] = [];
function diag(msg: string): void {
    _diagLog.push(`[${Date.now() % 100000}] ${msg}`);
    if (_diagLog.length > 100) _diagLog.shift();
}

function installHooks(proto: WorldPathfindingProto): boolean {
    if (_hooksInstalled) return true;

    const fpc = getSingleton(proto.classes.WorldPathfindingWorker);
    const elj = getSingleton(proto.classes.AutoTravelManager);
    if (!fpc) { diag(`install: no live ${proto.classes.WorldPathfindingWorker}`); return false; }
    if (!elj) { diag(`install: no live ${proto.classes.AutoTravelManager}`); return false; }

    try {
        // deliverResult(List<Edge>, bool) → snapshot args[1] = the list ptr.
        const nwf = (fpc as any).class.tryMethod(proto.methods.WorldPathfindingWorker_deliverResult);
        if (nwf && !nwf.virtualAddress.equals(NULL)) {
            Interceptor.attach(nwf.virtualAddress, {
                onEnter(args) {
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

        // bapc — observe-only, purely for diag visibility.
        const bapc = (elj as any).class.tryMethod(proto.methods.AutoTravelManager_startAutoTravel);
        if (bapc && !bapc.virtualAddress.equals(NULL)) {
            Interceptor.attach(bapc.virtualAddress, {
                onEnter(args) {
                    try { diag(`bapc: destMapId=${args[1].toString()}`); }
                    catch (e) { diag(`bapc hook err: ${String(e).slice(0, 80)}`); }
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

/** Drain diagnostic log — used by /api/dofus/world-pathfinding/diag. */
export function getWorldPathfindingDiag(): Promise<{ hooksInstalled: boolean; captureSeq: number; log: string[] }> {
    return inVm(() => ({
        hooksInstalled: _hooksInstalled,
        captureSeq: _captureSeq,
        log: _diagLog.slice(),
    }));
}

export interface ComputeWorldPathRequest {
    proto: WorldPathfindingProto;
    /** Stringified long — required. */
    destMapId: string;
    /** Stringified long — required. Where the path starts. The backend
     *  pulls this from MapStateStore.getState().mapId. */
    srcMapId: string;
    /** Stringified long — defaults to "0". Player's current cell on srcMapId.
     *  The backend pulls this from PlayerStore.getState().currentCellId. */
    currentCellId?: string;
    timeoutMs?: number;
}
export interface ComputeWorldPathResult {
    ok: boolean;
    reason?: string;
    edges?: PathEdge[];
    /** True if the deliverResult hook fired during this call (= a fresh path
     *  was computed, not a stale read from a previous run). */
    fresh?: boolean;
    /** Echo of the args passed to computePath, for debugging. */
    invokedWith?: { destMapId: string; srcMapId: string; currentCellId: string };
}

/** Pure compute: invoke `WorldPathfinder.computePath(destMapId, srcMapId,
 *  currentCellId, ere, NULL_cb, true)` directly. No bapc → no movement.
 *  Result is captured via the deliverResult hook (preferred — `fresh: true`)
 *  or polled out of WorldPathfindingWorker.resultEdges as fallback. */
export async function computeWorldPath(req: ComputeWorldPathRequest): Promise<ComputeWorldPathResult> {
    const timeoutMs = Math.max(500, Math.min(30_000, req.timeoutMs ?? 5000));
    const destMapId    = String(req.destMapId);
    const srcMapId     = String(req.srcMapId);
    const currentCellId = String(req.currentCellId ?? "0");
    const invokedWith  = { destMapId, srcMapId, currentCellId };

    // Step 1 (in VM): install hooks, fire the invoke, snapshot the capture
    // sequence so we can tell our own publish apart from any stale one.
    const setup: { ok: boolean; reason?: string; seqBefore: number } = await inVm(() => {
        if (!installHooks(req.proto)) {
            return { ok: false, reason: "could not install hooks (no live worker / manager)", seqBefore: _captureSeq };
        }

        const elj = getSingleton(req.proto.classes.AutoTravelManager);
        const ell = getSingleton(req.proto.classes.WorldPathfinder);
        if (!elj) return { ok: false, reason: `no live ${req.proto.classes.AutoTravelManager}`, seqBefore: _captureSeq };
        if (!ell) return { ok: false, reason: `no live ${req.proto.classes.WorldPathfinder}`, seqBefore: _captureSeq };

        let ere: any;
        try { ere = (elj as any).field(req.proto.fields.AutoTravelManager_pathfinderContext).value; }
        catch (e) { return { ok: false, reason: `read pathfinderContext failed: ${String(e).slice(0, 120)}`, seqBefore: _captureSeq }; }
        if (!ere || (ere.isNull && ere.isNull())) {
            return { ok: false, reason: `pathfinderContext is NULL — not on a map yet?`, seqBefore: _captureSeq };
        }

        // Bind computePath to the live instance — `ell.tryMethod(...)`, NOT
        // `ell.class.tryMethod(...)` (the latter returns an unbound handle
        // that Frida refuses to invoke on a non-static method).
        const computePath = (ell as any).tryMethod(req.proto.methods.WorldPathfinder_computePath);
        if (!computePath) return { ok: false, reason: `method ${req.proto.methods.WorldPathfinder_computePath} not found on WorldPathfinder`, seqBefore: _captureSeq };

        const seqBefore = _captureSeq;
        // cb=NULL: the worker still publishes to resultEdges before trying to
        // dispatch the callback. A NRE on the null dispatch is swallowed by
        // the catch below; the path is already captured at that point.
        try {
            computePath.invoke(
                new Int64(destMapId),
                new Int64(srcMapId),
                new Int64(currentCellId),
                ere,
                NULL,
                true,
            );
        } catch (e) {
            diag(`computePath invoke threw (continuing to poll): ${String(e).slice(0, 120)}`);
        }
        return { ok: true, seqBefore };
    });
    if (!setup.ok) return { ok: false, reason: setup.reason, invokedWith };

    // Step 2: poll for the result. The deliverResult hook bumps _captureSeq
    // when it fires (preferred channel); the resultEdges field is the
    // fallback, gated by `lastEdge.to.mapId === destMapId` to avoid returning
    // a stale path from a previous run.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));

        const polled: { edges: PathEdge[]; fresh: boolean } = await inVm(() => {
            if (_captureSeq > setup.seqBefore && _lastCapture && _lastCapture.length > 0) {
                return { edges: _lastCapture.slice(), fresh: true };
            }
            const ell = getSingleton(req.proto.classes.WorldPathfinder);
            if (!ell) return { edges: [], fresh: false };
            try {
                const worker = (ell as any).field(req.proto.fields.WorldPathfinder_worker).value;
                if (!worker || worker.isNull()) return { edges: [], fresh: false };
                const edges = readEdgeList(worker.field(req.proto.fields.WorldPathfindingWorker_resultEdges).value);
                if (edges.length === 0) return { edges: [], fresh: false };
                if (edges[edges.length - 1].to.mapId !== destMapId) return { edges: [], fresh: false };
                return { edges, fresh: false };
            } catch { return { edges: [], fresh: false }; }
        });
        if (polled.edges.length > 0) {
            return { ok: true, edges: polled.edges, fresh: polled.fresh, invokedWith };
        }
    }

    return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms (no path published ending at destMapId=${destMapId})`,
        invokedWith,
    };
}

/** Install hooks at attach time so deliverResult catches in-game auto-travels
 *  even before the first active invoke. Idempotent. */
export function initWorldPathfindingHooks(proto: WorldPathfindingProto): Promise<{ ok: boolean }> {
    return inVm(() => ({ ok: installHooks(proto) }));
}
