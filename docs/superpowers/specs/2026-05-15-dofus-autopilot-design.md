# Dofus autopilot — design

**Date** : 2026-05-15
**Branch** : `feat/v1.5-dofus-map`
**Status** : design (pre-implementation)

## Goal

Add an autopilot to the Dofus plugin: the user supplies a destination `mapId`, the toolkit drives the character from its current map to that destination by chaining intra-map moves and map-change packets along the world-pathfinding graph.

Scope v1 — **walk-off-edge transitions only** (walking to a border cell that triggers a natural `ito` transition). Zaaps, interactives, criterion-locked transitions are out of scope.

## Why minimal

- The world-path A* (`world-path.ts`) and the move + map-change façades (`movement.ts`, `change-map.ts`) already exist.
- `PlayerStore` and `MapStateStore` already publish the runtime state we need to observe progression.
- The autopilot is purely **composition glue** — no new agent code, no new protocol entries, no new stores.

## Architecture

### Single new file
`app/plugins/dofus/lib/movement/autopilot.ts` exporting `TravelOrchestrator`.

### Single instance per session
Created eagerly on `profile-attached` in `routes/index.ts` alongside `playerStore` / `mapStateStore` (so the API endpoints can always respond, including with `state: "idle"` before any travel). Disposed on `profile-detached`: `dispose()` sets the cancel flag, lets any in-flight `waitFor*` reject promptly, transitions the orchestrator to state `cancelled`, then clears the reference so the next `profile-attached` builds a fresh one with state `idle`.

### Narrowed dependencies
The orchestrator depends on a `TravelDeps` interface, not on the full stores. Caller wires it up:

```ts
interface TravelDeps {
    getCurrentCell:  () => number | null;
    isMoving:        () => boolean;
    onPlayerChange:  (cb: () => void) => () => void;  // returns unsubscribe
    getCurrentMapId: () => number | null;
    onMapChange:     (cb: () => void) => () => void;
    movement:        MovementActions;
    changeMap:       ChangeMapActions;
}
```

Wiring (in `routes/index.ts`):
```ts
new TravelOrchestrator({
    getCurrentCell:  () => playerStore.getState().currentCellId,
    isMoving:        () => playerStore.getState().isMoving,
    onPlayerChange:  (cb) => playerStore.onChange(cb),
    getCurrentMapId: () => mapStateStore.getState().mapId,
    onMapChange:     (cb) => mapStateStore.onChange(cb),
    movement,
    changeMap,
});
```

The world-path A* is invoked directly from the orchestrator using the helpers already exported by `world-path.ts` (`loadGraph`, `pickVertexForMap`, `aStar`, `pathToEdges`). The existing duplicated A* logic inside `routes/index.ts` POST `/world-pathfinding/compute` is factored into a small reusable helper `computeWorldPath(srcMapId, destMapId)` colocated with `world-path.ts`.

## Loop

Sequential async/await on the edge list:

```ts
async start(destMapId): Promise<{ ok: boolean; reason?: string }> {
    // guards: already running, not attached, no currentMapId, no currentCell
    this.state = "running";
    this.destMapId = destMapId;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.lastError = null;
    this.cancelled = false;

    try {
        const edges = computeWorldPath(currentMapId, destMapId);
        this.totalEdges = edges.length;

        if (edges.length === 0) {
            if (currentMapId === destMapId) return this.finish("done");
            throw new Error(`no path to ${destMapId}`);
        }

        for (let i = 0; i < edges.length; i++) {
            this.currentEdgeIdx = i;
            this.throwIfCancelled();

            const t = pickWalkable(edges[i].transitions);
            if (!t) throw new Error(`edge ${i}: no walkable transition (zaaps/portals only)`);
            this.currentTransitionCell = t.cellId;

            const fromCell = this.deps.getCurrentCell();
            if (fromCell == null) throw new Error("current cell unknown");

            const move = await this.deps.movement.moveTo(fromCell, t.cellId, this.deps.getCurrentMapId() ?? undefined);
            if (!move.ok) throw new Error(`movement: ${move.reason ?? "send failed"}`);
            await this.waitForArrival(t.cellId);

            this.throwIfCancelled();
            const nextMapId = Number(edges[i].to.mapId);
            const cm = await this.deps.changeMap.changeMap(nextMapId);
            if (!cm.ok) throw new Error(`changeMap: ${cm.reason ?? "send failed"}`);
            await this.waitForMap(nextMapId);

            this.currentTransitionCell = null;
        }
        return this.finish("done");
    } catch (err) {
        return this.finish(this.cancelled ? "cancelled" : "failed", String((err as Error).message));
    }
}
```

`finish(state, lastError?)` sets `this.state`, `this.finishedAt = Date.now()`, and returns `{ ok: state === "done", reason: lastError }`. `throwIfCancelled()` throws an internal sentinel error when the flag is set.

### `pickWalkable(transitions)`
Returns the first transition with `direction !== null`, or `null`. All walk-off-edge transitions in an edge lead to the same `to.mapId` (the choice of border cell is arbitrary).

### `waitForArrival(cellId)`
Subscribes to `onPlayerChange`. Resolves when `getCurrentCell() === cellId && !isMoving()`. Rejects on cancel (flag check inside the callback) or after a **15s timeout**. `finally` unsubscribes and clears the timer.

### `waitForMap(mapId)`
Subscribes to `onMapChange`. Resolves when `getCurrentMapId() === mapId`. Rejects on cancel or after a **5s timeout**. Same cleanup pattern.

## Status

```ts
type TravelState = "idle" | "running" | "done" | "failed" | "cancelled";

interface TravelStatus {
    state: TravelState;
    destMapId:             number | null;
    currentEdgeIdx:        number | null;   // 0..totalEdges-1 during running
    totalEdges:            number | null;
    currentTransitionCell: number | null;   // target cell of the current move; null between steps
    lastError:             string | null;
    startedAt:             number | null;   // Date.now() at start()
    finishedAt:            number | null;   // Date.now() when state leaves "running"
}
```

Status of a `done` / `failed` / `cancelled` travel persists until the next `start` (which overwrites) or `dispose` (which clears).

## API

3 endpoints mounted from `routes/index.ts`.

```
POST /api/dofus/travel/start    body: { destMapId: number }
  200 { ok: true,  totalEdges: N }                       travel kicked off
  200 { ok: true,  totalEdges: 0, alreadyOnMap: true }   already on destination map
  200 { ok: false, reason: "no path to N" }              planning failed (state → failed)
  200 { ok: false, reason: "destMapId N not in graph" }  ditto
  400 { error: "destMapId required" }
  409 { error: "travel already running" }
  503 { error: "not attached" }

POST /api/dofus/travel/cancel   body: {}
  200 { ok: true,  wasRunning: boolean }     flag set; takes effect at next frontier
  503 { error: "not attached" }

GET  /api/dofus/travel/status
  200 TravelStatus                           always available; state="idle" if never started
  503 { error: "not attached" }
```

`start` does not block on the travel completion — it returns as soon as planning succeeds (or fails immediately). Planning failures (no path, destMapId out of graph) come back as `200 { ok: false, reason }` and leave the orchestrator in state `failed`; the same body shape `{ ok, totalEdges?, reason? }` covers all post-validation outcomes. Pre-validation failures (malformed body, already running, not attached) use HTTP error codes. The caller polls `/status` to observe progression of an accepted travel.

## UI on State page

Small panel inserted in the state page header region (just under the map name / pos line). Visible regardless of session state; collapses to a thin row when idle.

**Idle** :
```
┌─ Autopilot ──────────────────────────────────────┐
│ Aller à map  [_______]  [Go]                      │
└───────────────────────────────────────────────────┘
```

**Running** :
```
┌─ Autopilot ──────────────────────────────────────┐
│ → Map 188744106  ·  step 3/12  ·  cell 168       │
│ [Cancel]                                          │
└───────────────────────────────────────────────────┘
```

**Done** :
```
┌─ Autopilot ──────────────────────────────────────┐
│ ✓ Arrivé à 188744106  (12 steps, 38s)             │
│ Aller à map  [_______]  [Go]                      │
└───────────────────────────────────────────────────┘
```

**Failed / Cancelled** :
```
┌─ Autopilot ──────────────────────────────────────┐
│ ✗ failed: edge 5: no walkable transition          │
│ Aller à map  [_______]  [Go]                      │
└───────────────────────────────────────────────────┘
```

**Behavior**:
- Go → `POST /travel/start`. 409 displays in-place. On 200, switch to Running view.
- Running view polls `GET /travel/status` every **500ms**, stops polling when `state !== "running"`.
- Cancel → `POST /travel/cancel`. UI updates on next status poll.
- The minimap visual updates automatically from the existing `dofus-player-state-changed` / `dofus-map-state-changed` WS events — the autopilot publishes nothing extra.

**Not in v1** :
- Map search / autocomplete by name
- Travel history
- ETA estimation

## Failure modes

| Cause                                                  | Detection                            | `lastError`                                                       |
|--------------------------------------------------------|--------------------------------------|-------------------------------------------------------------------|
| Not attached                                           | guard in route                       | (503, no orchestrator transition)                                 |
| No `currentMapId` / `currentCell`                      | guard in `start()`                   | (`start` returns `ok: false, reason`)                             |
| `destMapId` not in graph                               | `pickVertexForMap` returns `null`    | `"destMapId N not in graph"`                                      |
| A* exhausted or no path                                | `aStar` returns empty `pathUids`     | `"no path to N"`                                                  |
| Edge has only zaap/portal transitions                  | `pickWalkable` returns `null`        | `"edge i: no walkable transition (zaaps/portals only)"`           |
| `movement.moveTo` send failed                          | `move.ok === false`                  | `"movement: <reason>"`                                            |
| Arrival timeout (>15s)                                 | `waitForArrival` timer fires         | `"arrival timeout at cell C"`                                     |
| `changeMap.changeMap` failed (send or kta timeout)     | `cm.ok === false`                    | `"changeMap: <reason>"`                                           |
| Landed on wrong map / no map update (>5s)              | `waitForMap` timer fires             | `"landed on wrong map: expected E, got G"` or `"map change timeout"` |
| User cancelled mid-await                               | flag check in `waitFor*`             | (state becomes `cancelled`, not `failed`)                         |

### Cleanup discipline
Every `waitFor*` creates an `unsub` + `timer`, races them with the condition check, and unsubscribes + clears the timer in `finally`. No orphan listeners. `dispose()` (called on profile detach) sets the cancel flag and causes any in-flight await to reject promptly.

## Tests

Unit tests in `app/test/plugins/dofus/lib/movement/autopilot.test.ts`. The narrowed `TravelDeps` interface is the seam — tests provide stub functions and stub action objects without instantiating real stores.

| Case                          | Setup                                          | Assertions                                                                   |
|-------------------------------|------------------------------------------------|------------------------------------------------------------------------------|
| already on destination        | `currentMapId === destMapId`, A* edges empty   | `state === "done"`, `totalEdges === 0`, neither action called                |
| no path                       | A* returns `pathUids: []`                      | `state === "failed"`, `lastError` contains `"no path"`                       |
| edge with only zaap transitions | one edge, all transitions `direction === null` | `state === "failed"`, `lastError` contains `"no walkable"`                   |
| 2 edges successful path       | mock arrival + map change after each move      | `movement.moveTo` called 2×, `changeMap` called 2×, `state === "done"`       |
| cancel during waitForArrival  | trigger cancel after `moveTo` returns          | `state === "cancelled"`, `changeMap` never called                            |
| arrival timeout               | `onPlayerChange` never fires after `moveTo`    | `state === "failed"`, `lastError` contains `"arrival timeout"`               |
| concurrent start refused      | running state, second `start()` call           | second returns `{ ok: false }`, reason `"already running"`                   |

No HTTP integration tests in v1 — pattern matches the other action endpoints in the plugin which are not HTTP-tested either. Manual validation: attach to running game, travel to a 3-5 hop destination, observe in-game.

## File list

| File                                                            | Action                                                                                 |
|-----------------------------------------------------------------|----------------------------------------------------------------------------------------|
| `app/plugins/dofus/lib/movement/autopilot.ts`                   | NEW — `TravelOrchestrator` class                                                       |
| `app/plugins/dofus/lib/movement/world-path.ts`                  | EDIT — add `computeWorldPath(srcMapId, destMapId)` helper, factored from routes        |
| `app/plugins/dofus/routes/index.ts`                             | EDIT — wire orchestrator at attach/detach, refactor existing `/compute` to use helper, add 3 new endpoints |
| `app/plugins/dofus/pages/state.ts`                              | EDIT — autopilot panel + poll loop                                                     |
| `app/test/plugins/dofus/lib/movement/autopilot.test.ts`         | NEW — unit tests                                                                       |

## Non-goals (deferred)

- Zaap / interactive / scroll-of-recall transitions
- Criterion-aware path selection (quest locks, item requirements)
- Mid-travel replan
- Retry on transient failure
- ETA estimation
- Travel history
- Map name autocomplete in UI
- WS event for travel progress (UI polls instead)
