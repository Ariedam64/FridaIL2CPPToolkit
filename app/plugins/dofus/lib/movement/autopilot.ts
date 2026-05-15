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
    movement:         Pick<MovementActions, "moveTo">;
    changeMap:        Pick<ChangeMapActions, "changeMap">;
    computeWorldPath: (srcMapId: number, destMapId: number) => ComputeWorldPathResult;
}

export interface StartResult {
    ok: boolean;
    totalEdges?: number;
    alreadyOnMap?: boolean;
    reason?: string;
}

/** Returns the first transition that triggers a natural map change by
 *  walking off a border cell (direction !== null). Returns null for edges
 *  that only contain zaaps / portals / scrollOfRecall (direction === null
 *  on those — v1 doesn't drive them). */
export function pickWalkable(transitions: readonly Transition[]): Transition | null {
    for (const t of transitions) {
        if (t.direction !== null) return t;
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
                const move = await this.deps.movement.moveTo(fromCell, t.cellId, mapNow);
                if (!move.ok) throw new Error(`movement: ${move.reason ?? "send failed"}`);

                await this.waitForArrival(t.cellId);
                this.throwIfCancelled();

                const nextMapId = Number(plan.edges[i].to.mapId);
                const cm = await this.deps.changeMap.changeMap(nextMapId);
                if (!cm.ok) throw new Error(`changeMap: ${cm.reason ?? "send failed"}`);

                await this.waitForMap(nextMapId);
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

            let settled = false;
            const cleanup = (): void => {
                settled = true;
                unsub();
                clearTimeout(timer);
                const i = this.cancellers.indexOf(cancelFn);
                if (i >= 0) this.cancellers.splice(i, 1);
            };
            const unsub = subscribe(() => {
                if (settled) return;
                if (cond()) { cleanup(); resolve(); }
            });
            const timer = setTimeout(() => {
                if (settled) return;
                cleanup();
                reject(new Error(timeoutReason));
            }, timeoutMs);
            const cancelFn = (): void => {
                if (settled) return;
                cleanup();
                reject(new Error("cancelled"));
            };
            this.cancellers.push(cancelFn);
        });
    }

    dispose(): void {
        // Filled in Task 6.
    }
}
