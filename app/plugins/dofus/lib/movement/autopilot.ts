// Travel orchestrator: chains movement + change-map along the world-path
// graph to drive the character from its current map to a target mapId.
// v1 only handles walk-off-edge transitions (direction !== null). Single
// instance per session.

import type { MovementActions } from "./movement";
import type { ChangeMapActions } from "./change-map";
import type { ComputeWorldPathResult, PathEdgeOut } from "./world-path";
import type { Transition } from "./world-path";

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
    movement:         Pick<MovementActions, "moveTo" | "stopMoving">;
    changeMap:        Pick<ChangeMapActions, "changeMap">;
    /** Best-effort BasicPing keepalive; called every BASIC_PING_INTERVAL_MS
     *  while a travel is running. Errors swallowed by the orchestrator. */
    sendBasicPing:    () => Promise<{ ok: boolean; reason?: string }>;
    computeWorldPath: (srcMapId: number, destMapId: number) => ComputeWorldPathResult;
    /** Override for the post-arrival settle delay. Tests pass 0; prod
     *  omits it and inherits POST_ARRIVAL_SETTLE_MS. */
    postArrivalSettleMs?: number;
}

/** Interval at which the orchestrator emits a BasicPing while a travel is
 *  running. Matches the official client's empirical 5s tick (see
 *  app/plugins/dofus/lib/basic-ping.md). */
const BASIC_PING_INTERVAL_MS = 5_000;

/** Small breathing room between the server's `ish` (move ended, isMoving
 *  flipped false) and our forged `ito`. The official client takes ~50ms
 *  between receiving ish and emitting ito; firing ito immediately races
 *  the client's own post-move processing and occasionally crashes the
 *  session right at the map change. 150ms is comfortably above the
 *  client's natural delay. */
const POST_ARRIVAL_SETTLE_MS = 150;

/** How long we wait for the natural `ish` before forging our own `itr`.
 *  Walk durations observed in the wire: 15 cells ≈ 2.3s, 19 cells ≈ 2.1s
 *  (~110-155ms per cell). Max walk on a single map is ~28 cells = ~4.2s.
 *  At 6s the server has CERTAINLY finished simulating the walk, so forging
 *  `itr` is safe — it only fires when the client's local walker has
 *  visually desynced (server done, client never emits itr). A previous
 *  attempt at 3s was too aggressive and cut legitimate walks mid-flight,
 *  producing a server desync that crashed the session. */
const CLIENT_DESYNC_WATCHDOG_MS = 6_000;

/** Backstop after we force `itr`. ish typically lands within ~30ms; 5s is
 *  comfortably generous. */
const STOP_ACK_TIMEOUT_MS = 5_000;

export interface StartResult {
    ok: boolean;
    totalEdges?: number;
    alreadyOnMap?: boolean;
    reason?: string;
}

/** Returns the first walk-off-edge transition. The `type` field is the
 *  discriminator (empirically derived from the cached world-graph):
 *    type 1  — basic walk-off-edge (~67% of all transitions, skillId=-1,
 *              direction=null);
 *    type 2  — alternate walk-off-edge variant (~12%, same shape);
 *    type 8  — skill-less teleport (boats, mounts?) — out of scope v1;
 *    type 32 — zaaps / scrolls (skillId>0) — out of scope v1.
 *  Returns null if no type-1/2 transition exists. The `direction` field
 *  in this build is `null` or `255` (sentinel) and never a cardinal 0-7,
 *  so it is NOT a usable discriminator on its own. */
export function pickWalkable(transitions: readonly Transition[]): Transition | null {
    for (const t of transitions) {
        if (t.type === 1 || t.type === 2) return t;
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

    async start(destMapId: number): Promise<StartResult> {
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

                const t = pickWalkable(plan.edges[i].transitions);
                if (!t) throw new Error(`edge ${i}: no walkable transition (zaaps/portals only)`);
                this.status.currentTransitionCell = t.cellId;

                const fromCell = this.deps.getCurrentCell();
                if (fromCell == null) throw new Error("current cell unknown mid-travel");
                const mapNow = this.deps.getCurrentMapId() ?? undefined;
                console.log(`[autopilot] edge ${i}/${plan.edges.length - 1}: map=${mapNow} from=${fromCell} → cell=${t.cellId} (next map=${plan.edges[i].to.mapId})`);
                const move = await this.deps.movement.moveTo(fromCell, t.cellId, mapNow);
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
                    await this.waitForArrival(t.cellId, CLIENT_DESYNC_WATCHDOG_MS);
                } catch (e) {
                    if (this.cancelled) throw e;
                    console.warn(`[autopilot] edge ${i}: no ish after ${CLIENT_DESYNC_WATCHDOG_MS}ms → client desync, forging itr (cell=${this.deps.getCurrentCell()}, isMoving=${this.deps.isMoving()})`);
                    const stop = await this.deps.movement.stopMoving();
                    if (!stop.ok) throw new Error(`stopMoving: ${stop.reason ?? "send failed"}`);
                    await this.waitForArrival(t.cellId, STOP_ACK_TIMEOUT_MS);
                    console.warn(`[autopilot] edge ${i}: recovered via forged itr, resuming`);
                }
                this.throwIfCancelled();
                console.log(`[autopilot] edge ${i}: arrived (cell=${this.deps.getCurrentCell()}), settling ${this.deps.postArrivalSettleMs ?? POST_ARRIVAL_SETTLE_MS}ms before ito…`);

                // Give the client a beat to finish its own post-arrival
                // bookkeeping before we fire `ito`. Without this, ~immediate
                // ito after `ish` lands races the client's own end-of-move
                // coroutines and the session can crash at map change.
                const settleMs = this.deps.postArrivalSettleMs ?? POST_ARRIVAL_SETTLE_MS;
                if (settleMs > 0) await new Promise<void>(r => setTimeout(r, settleMs));
                this.throwIfCancelled();

                const nextMapId = Number(plan.edges[i].to.mapId);
                console.log(`[autopilot] edge ${i}: sending ito → ${nextMapId}`);
                const cm = await this.deps.changeMap.changeMap(nextMapId);
                if (!cm.ok) throw new Error(`changeMap: ${cm.reason ?? "send failed"}`);

                await this.waitForMap(nextMapId);
                console.log(`[autopilot] edge ${i}: map confirmed=${this.deps.getCurrentMapId()}, cell after itx=${this.deps.getCurrentCell()}`);
                this.status.currentTransitionCell = null;
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
