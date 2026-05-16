// Travel orchestrator: chains movement + change-map along the world-path
// graph to drive the character from its current map to a target mapId.
// v1 only handles walk-off-edge transitions (direction !== null). Single
// instance per session.

import type { MovementActions } from "./movement";
import type { ChangeMapActions } from "./change-map";
import type { ComputeWorldPathResult, PathEdgeOut } from "./world-path";
import type { Transition } from "./world-path";

/** Result of an `iev` (InteractiveUseRequest) — what the deps must return so the
 *  orchestrator can either proceed (map change will follow naturally) or fail
 *  with a clear reason. */
export interface UseInteractiveAtResult { ok: boolean; reason?: string; elementId?: number; skillInstanceUid?: number }

export type TravelState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface TravelStatus {
    state: TravelState;
    destMapId: number | null;
    currentEdgeIdx: number | null;
    totalEdges: number | null;
    currentTransitionCell: number | null;
    lastError: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

export interface TravelDeps {
    getCurrentCell:   () => number | null;
    isMoving:         () => boolean;
    onPlayerChange:   (cb: () => void) => () => void;
    getCurrentMapId:  () => number | null;
    onMapChange:      (cb: () => void) => () => void;
    movement:         Pick<MovementActions, "moveTo" | "stopMoving" | "findApproach">;
    changeMap:        Pick<ChangeMapActions, "changeMap">;
    /** Resolve `(cellId, skillId)` on the current map to an `(elementId,
     *  skillInstanceUid)` from the live MapStateStore and forge `iev`. Used
     *  for type-32 transitions (doors, ladders, holes) that map-change in
     *  place when activated. Omit for tests that only exercise walk-off-edge. */
    useInteractiveAt?: (cellId: number, skillId: number) => Promise<UseInteractiveAtResult>;
    /** Best-effort BasicPing keepalive; called every BASIC_PING_INTERVAL_MS
     *  while a travel is running. Errors swallowed by the orchestrator. */
    sendBasicPing:    () => Promise<{ ok: boolean; reason?: string }>;
    computeWorldPath: (srcMapId: number, destMapId: number) => ComputeWorldPathResult;
    /** Override for the post-map-change settle delay. Tests pass 0; prod
     *  omits it and inherits POST_MAP_CHANGE_SETTLE_MS. */
    postMapChangeSettleMs?: number;
}

/** Interval at which the orchestrator emits a BasicPing while a travel is
 *  running. Matches the official client's empirical 5s tick (see
 *  app/plugins/dofus/lib/basic-ping.md). */
const BASIC_PING_INTERVAL_MS = 5_000;

/** Breathing room between `itx` (server confirmed new map = our `waitForMap`
 *  resolves) and the next leg's forged `isa`. Default 0 — once the agent-side
 *  `getLiveInstance` cache is prewarmed, every forged send completes in <2ms
 *  and there's no contention with Unity's scene-load anymore. The knob is kept
 *  for tests and as an escape hatch if a future game update reintroduces some
 *  post-itx fragility; bump it back to ~200ms if the client visually desyncs
 *  on consecutive map changes. */
const POST_MAP_CHANGE_SETTLE_MS = 50;

/** How long we wait for the natural `ish` before forging our own `itr`.
 *  Walk durations observed in the wire: 15 cells ≈ 2.3s, 19 cells ≈ 2.1s
 *  (~110-155ms per cell). Max walk on a single map is ~28 cells = ~4.2s.
 *  At 6s the server has CERTAINLY finished simulating the walk, so forging
 *  `itr` is safe — it only fires when the client's local walker has
 *  visually desynced (server done, client never emits itr). A previous
 *  attempt at 3s was too aggressive and cut legitimate walks mid-flight,
 *  producing a server desync that crashed the session. */
const CLIENT_DESYNC_WATCHDOG_MS = 4_000;

/** Backstop after we force `itr`. ish typically lands within ~30ms; 5s is
 *  comfortably generous. */
const STOP_ACK_TIMEOUT_MS = 5_000;

export interface StartResult {
    ok: boolean;
    totalEdges?: number;
    alreadyOnMap?: boolean;
    reason?: string;
}

export interface StartOptions {
    /** Use changeMap fast mode (ito+jnr+isp in burst, skip the client's 1.2s
     *  loading coroutine). Each map change drops from ~1.5s to ~300ms but the
     *  in-game UI is left half-wired (no character sprite, can't move via the
     *  client). Headless automation only. */
    fast?: boolean;
}

/** Returns the first walk-off-edge transition. The `type` field is the
 *  discriminator (empirically derived from the cached world-graph):
 *    type 1  — basic walk-off-edge (~67% of all transitions, skillId=-1,
 *              direction=null);
 *    type 2  — alternate walk-off-edge variant (~12%, same shape);
 *    type 8  — skill-less teleport (boats, mounts?) — out of scope;
 *    type 32 — in-place interactives (doors, ladders, holes — handled via
 *              `pickReachable`, NOT via this function).
 *  Returns null if no type-1/2 transition exists. The `direction` field
 *  in this build is `null` or `255` (sentinel) and never a cardinal 0-7,
 *  so it is NOT a usable discriminator on its own. */
export function pickWalkable(transitions: readonly Transition[]): Transition | null {
    for (const t of transitions) {
        if (t.type === 1 || t.type === 2) return t;
    }
    return null;
}

/** Result of resolving a path edge to a concrete action.
 *  - `walk`        : walk off the cell, then forge `ito` for the map change
 *  - `interactive` : walk to the cell, then forge `iev` (skillInstanceUid
 *                    resolved at use time via `useInteractiveAt`); the server
 *                    handles the map transition as a side effect of the iev. */
export type TransitionAction =
    | { kind: "walk"; transition: Transition }
    | { kind: "interactive"; transition: Transition };

/** Pick the cheapest action that resolves an edge. Walks are preferred when
 *  available because they're a single round-trip (no server-side interactive
 *  lookup); in-place interactives are the fallback. Type 8 (boat/mount) is
 *  out of scope. */
export function pickReachable(transitions: readonly Transition[]): TransitionAction | null {
    const walk = pickWalkable(transitions);
    if (walk) return { kind: "walk", transition: walk };
    for (const t of transitions) {
        if (t.type === 32) return { kind: "interactive", transition: t };
    }
    return null;
}

export class TravelOrchestrator {
    private status: TravelStatus = {
        state: "idle",
        destMapId: null,
        currentEdgeIdx: null,
        totalEdges: null,
        currentTransitionCell: null,
        lastError: null,
        startedAt: null,
        finishedAt: null,
    };
    private cancelled = false;
    private cancellers: Array<() => void> = [];

    constructor(private readonly deps: TravelDeps) {}

    getStatus(): TravelStatus {
        return { ...this.status };
    }

    async start(destMapId: number, options: StartOptions = {}): Promise<StartResult> {
        if (this.status.state === "running") {
            return { ok: false, reason: "travel already running" };
        }
        const currentMapId = this.deps.getCurrentMapId();
        if (currentMapId == null) {
            return { ok: false, reason: "no current mapId (not attached or map not yet known)" };
        }
        const currentCell = this.deps.getCurrentCell();
        if (currentCell == null) {
            return { ok: false, reason: "no current cell (player not yet localized)" };
        }

        this.status = {
            state: "running",
            destMapId,
            currentEdgeIdx: null,
            totalEdges: null,
            currentTransitionCell: null,
            lastError: null,
            startedAt: Date.now(),
            finishedAt: null,
        };
        this.cancelled = false;
        this.cancellers = [];

        const plan = this.deps.computeWorldPath(currentMapId, destMapId);
        if (!plan.ok) {
            return this.finish("failed", plan.reason);
        }
        this.status.totalEdges = plan.edges.length;

        if (plan.edges.length === 0) {
            this.finish("done");
            return { ok: true, totalEdges: 0, alreadyOnMap: true };
        }

        // NOTE: heartbeat disabled — a wall-clock 5s setInterval could fire a
        // BasicPing through Frida.perform DURING the new map's Unity scene
        // load, contending with our own forged moves and producing visible
        // lag / crashes. The official client emits jsa activity-gated, not
        // on a hard 5s timer; mimicking just the cadence was wrong. If keep-
        // alive starvation becomes a real issue on long travels, re-add as
        // activity-gated (only when no frame has gone through in the past N
        // seconds and we're between phases, not mid map-change).

        try {
            for (let i = 0; i < plan.edges.length; i++) {
                this.status.currentEdgeIdx = i;
                this.throwIfCancelled();

                const action = pickReachable(plan.edges[i].transitions);
                if (!action) throw new Error(`edge ${i}: no reachable transition (boat/mount required)`);
                const t = action.transition;
                if (action.kind === "interactive" && !this.deps.useInteractiveAt) {
                    throw new Error(`edge ${i}: type-32 transition but useInteractiveAt not wired`);
                }
                this.status.currentTransitionCell = t.cellId;

                const fromCell = this.deps.getCurrentCell();
                if (fromCell == null) throw new Error("current cell unknown mid-travel");
                const mapNow = this.deps.getCurrentMapId() ?? undefined;
                // Interactives on non-walkable cells (doors, ladders, holes)
                // can't be walked TO — they're activated from an adjacent
                // walkable cell within 1-cell interaction range. Walk-off-edge
                // targets always sit on walkable cells, so `findApproach` is a
                // no-op for them.
                let walkTo = t.cellId;
                if (action.kind === "interactive") {
                    const approach = await this.deps.movement.findApproach(t.cellId, mapNow);
                    if (!approach.ok || approach.cell == null) {
                        throw new Error(`findApproach: ${approach.reason ?? "no walkable neighbour"} for cell ${t.cellId}`);
                    }
                    walkTo = approach.cell;
                }
                console.log(`[autopilot] edge ${i}/${plan.edges.length - 1}: map=${mapNow} from=${fromCell} → cell=${walkTo}${walkTo !== t.cellId ? ` (approach to ${t.cellId})` : ""} via ${action.kind} (next map=${plan.edges[i].to.mapId})`);
                const tTrigIsa = Date.now();
                const move = await this.deps.movement.moveTo(fromCell, walkTo, mapNow);
                console.log(`[autopilot] edge ${i} isa trigger→sent=${Date.now() - tTrigIsa}ms`);
                if (!move.ok) throw new Error(`movement: ${move.reason ?? "send failed"}`);
                console.log(`[autopilot] edge ${i}: moveTo dispatched (cellPath ${move.keyMovements?.length ?? 0} keymovements), awaiting arrival…`);

                // Wait for natural arrival (server-acked via `ish` →
                // PlayerStore.isMoving = false). If after CLIENT_DESYNC_WATCHDOG_MS
                // we still haven't seen ish, the client has visually desynced
                // (server already finished the walk but the client's local
                // walker froze and never emitted itr). At 6s the server-side
                // walk is CERTAINLY done — forging our own itr makes the
                // server reply with ish and unblocks us.
                try {
                    await this.waitForArrival(walkTo, CLIENT_DESYNC_WATCHDOG_MS);
                } catch (e) {
                    if (this.cancelled) throw e;
                    console.warn(`[autopilot] edge ${i}: no ish after ${CLIENT_DESYNC_WATCHDOG_MS}ms → client desync, forging itr (cell=${this.deps.getCurrentCell()}, isMoving=${this.deps.isMoving()})`);
                    const stop = await this.deps.movement.stopMoving();
                    if (!stop.ok) throw new Error(`stopMoving: ${stop.reason ?? "send failed"}`);
                    await this.waitForArrival(walkTo, STOP_ACK_TIMEOUT_MS);
                    console.warn(`[autopilot] edge ${i}: recovered via forged itr, resuming`);
                }
                this.throwIfCancelled();
                console.log(`[autopilot] edge ${i}: arrived (cell=${this.deps.getCurrentCell()})`);

                const nextMapId = Number(plan.edges[i].to.mapId);
                const tTrigTransition = Date.now();
                if (action.kind === "walk") {
                    console.log(`[autopilot] edge ${i}: sending ito → ${nextMapId}${options.fast ? " (fast)" : ""}`);
                    const cm = await this.deps.changeMap.changeMap(nextMapId, { fast: options.fast });
                    console.log(`[autopilot] edge ${i} ito trigger→kta=${Date.now() - tTrigTransition}ms`);
                    if (!cm.ok) throw new Error(`changeMap: ${cm.reason ?? "send failed"}`);
                } else {
                    console.log(`[autopilot] edge ${i}: sending iev (skillId=${t.skillId} at cell=${t.cellId}) → ${nextMapId}`);
                    const r = await this.deps.useInteractiveAt!(t.cellId, t.skillId);
                    if (!r.ok) throw new Error(`useInteractive: ${r.reason ?? "send failed"}`);
                    console.log(`[autopilot] edge ${i} iev sent (elementId=${r.elementId}, skillInstanceUid=${r.skillInstanceUid}), awaiting map change…`);
                    // No native ack from `iev` — the map change comes through
                    // the natural mapInfo (itx) when the server processes the
                    // interaction. waitForMap below handles that.
                }

                await this.waitForMap(nextMapId);
                console.log(`[autopilot] edge ${i}: map confirmed=${this.deps.getCurrentMapId()}, cell after itx=${this.deps.getCurrentCell()}`);
                this.status.currentTransitionCell = null;

                // Let Unity finish its post-itx scene init + GC before our
                // next forged `isa` re-enters Il2Cpp.perform on the agent
                // thread. Skipped on the last edge (no next leg to protect)
                // and on cancel (next loop iter will throw immediately anyway).
                if (i < plan.edges.length - 1 && !this.cancelled) {
                    const settleMs = this.deps.postMapChangeSettleMs ?? POST_MAP_CHANGE_SETTLE_MS;
                    if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
                }
            }
            return this.finish("done");
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return this.finish(this.cancelled ? "cancelled" : "failed", reason);
        }
    }

    cancel(): { ok: boolean; wasRunning: boolean } {
        const wasRunning = this.status.state === "running";
        this.cancelled = true;
        const fns = this.cancellers.slice();
        this.cancellers = [];
        for (const f of fns) { try { f(); } catch { /* noop */ } }
        return { ok: true, wasRunning };
    }

    private finish(state: TravelState, lastError?: string): StartResult {
        this.status.state = state;
        this.status.finishedAt = Date.now();
        if (lastError) this.status.lastError = lastError;
        return { ok: state === "done", reason: lastError, totalEdges: this.status.totalEdges ?? undefined };
    }

    private throwIfCancelled(): void {
        if (this.cancelled) throw new Error("cancelled");
    }

    private waitForArrival(cellId: number, timeoutMs = 15_000): Promise<void> {
        return this.awaitCondition(
            () => this.deps.getCurrentCell() === cellId && !this.deps.isMoving(),
            this.deps.onPlayerChange,
            timeoutMs,
            `arrival timeout at cell ${cellId}`,
        );
    }

    private waitForMap(mapId: number, timeoutMs = 5_000): Promise<void> {
        return this.awaitCondition(
            () => this.deps.getCurrentMapId() === mapId,
            this.deps.onMapChange,
            timeoutMs,
            `map change timeout: expected ${mapId}, got ${this.deps.getCurrentMapId()}`,
        );
    }

    private awaitCondition(
        cond: () => boolean,
        subscribe: (cb: () => void) => () => void,
        timeoutMs: number,
        timeoutReason: string,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // Immediate check: maybe the condition is already true.
            if (cond()) return resolve();
            if (this.cancelled) return reject(new Error("cancelled"));

            // Pre-declare with safe defaults so `cleanup` can run even if
            // `subscribe()` synchronously fires its callback before the
            // assignments below complete.
            let settled = false;
            let unsub: () => void = () => {};
            let timer: ReturnType<typeof setTimeout> | null = null;
            const cleanup = (): void => {
                settled = true;
                unsub();
                if (timer !== null) clearTimeout(timer);
                const i = this.cancellers.indexOf(cancelFn);
                if (i >= 0) this.cancellers.splice(i, 1);
            };
            const cancelFn = (): void => {
                if (settled) return;
                cleanup();
                reject(new Error("cancelled"));
            };
            this.cancellers.push(cancelFn);
            unsub = subscribe(() => {
                if (settled) return;
                if (cond()) { cleanup(); resolve(); }
            });
            timer = setTimeout(() => {
                if (settled) return;
                cleanup();
                reject(new Error(timeoutReason));
            }, timeoutMs);
        });
    }

    dispose(): void {
        // Re-uses cancel() so any pending await rejects promptly. We don't
        // null out deps — the orchestrator becomes single-use after dispose
        // and the route layer drops its reference on profile-detached.
        this.cancel();
    }
}
