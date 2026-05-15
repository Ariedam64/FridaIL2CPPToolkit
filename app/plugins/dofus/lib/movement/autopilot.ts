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
        // Pre-validation: never mutates status on failure.
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

        // Accepted — initialize status.
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
            // Already on destination map.
            this.finish("done");
            return { ok: true, totalEdges: 0, alreadyOnMap: true };
        }

        // Edge loop comes in Task 5. For now, just finish as if successful.
        // (This intermediate state is replaced in Task 5.)
        this.finish("done");
        return { ok: true, totalEdges: plan.edges.length };
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

    dispose(): void {
        // Filled in Task 6.
    }
}
