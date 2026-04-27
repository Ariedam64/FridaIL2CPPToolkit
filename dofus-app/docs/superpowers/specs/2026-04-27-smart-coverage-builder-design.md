# Smart Coverage Builder — Adaptive region-based capture runner

Date: 2026-04-27
Owner: Toolkit Dev
Status: Draft (pre-implementation)

## Context

Today the coverage panel runs in one of two modes:

- `scored` — recompute popularity-weighted scoring at every iteration on the
  full pool of `resource-plan.json` maps (no notion of region; just bubble
  proximity + score).
- `ordered` — walk a frozen plan produced by `build-coverage-plan.py` (greedy
  clustering + nearest-neighbor TSP).

Both share the same `travelAndCapture` runner with retry, oscillation
detection, Tier-1 cleanup (`probeStaticField("foz","dpgi",true)` +
`probeFozCts(0)`) and a worldgraph BFS pre-check inside `autoTravelInstant`.

The pain (per `autopilot-investigation.md` 2026-04-26/27):

1. Targets in disconnected components silent-reject and accumulate
   `foz.dpgi` corruption — gradually bricking the IL2CPP pathfinder solver
   ("Tier-2" state, only fixable by Dofus restart).
2. The runner picks high-score targets without considering whether they're
   actually walking-reachable from the current position. The BFS pre-check
   in `autoTravelInstant` catches some, but the picker still wastes cycles
   on impossible targets.
3. No notion of "world filter" (wm=1 surface vs wm=-1 caves) at the picker
   layer — only at plan-build time, statically.
4. When the entire region around the player is captured, the runner sits
   on the fail/retry path or reaches into another region without any
   awareness that a zaap is needed.

## Goal

Add a third runner mode `adaptive` that:

- **Operates on connected regions** of the worldgraph (union-find on the
  dumped adjacency).
- **Scores by popularity-weighted gfx coverage** (existing `gfxWeight` from
  `resource-plan.json`'s `gfxCount`), restricted to maps within the active
  region, restricted by user-chosen world filter and subarea filter.
- **Auto-bridges between regions** via `enterHavreSac → zaapTeleport`,
  with manual-N1 fallback if any step fails.

The existing `scored` and `ordered` modes are preserved untouched.

## Scope

ADDS:

- `dofus-app/public/lib/regions.ts` — region computation module.
- A "smart coverage builder" UI section in `dofus-app/public/panels/coverage.ts`.
- An `adaptive` branch in the runner functions of `coverage.ts`.
- Cross-region bridge logic (TS) using the existing `enterHavreSac`,
  `zaapTeleport`, `listKnownZaaps` RPCs.
- ONE new RPC `getMyHavreSacInfo()` if the player's `havreSacId` and
  `havreSacMapId` aren't already exposed elsewhere.

DOES NOT:

- Remove or change the `scored` / `ordered` modes.
- Modify `autoTravelInstant` (the existing BFS pre-check + Tier-1 cleanup
  is reused as-is).
- Persist a static "adaptive plan" file. The mode is purely dynamic.
- Tackle Tier-2 brick auto-recovery (still requires Dofus restart).
- Add a walk-to-cell primitive (Phase 1.5 if zaap proximity in the haven-bag
  proves insufficient).
- Build a full zaap-network virtual-edge BFS (Phase 2).

## Non-goals (for clarity)

- Replanning past failed maps proactively — `failedMaps` set behaviour is
  unchanged; `RETRY FAILED` button still clears it.
- Multi-account / multi-character. Single character.

## Architecture overview

Four components:

```
┌──────────────────────┐    ┌──────────────────────┐
│ Region engine        │    │ Builder UI           │
│ regions.ts           │◄───┤ coverage.ts (new     │
│ - computeRegions     │    │ fieldset)            │
│ - regionOf           │    │ - worlds checkboxes  │
│ - reachableRegions   │    │ - subarea filters    │
│ - isReachableMid     │    │ - havre-sac inputs   │
└──────────┬───────────┘    │ - regions list       │
           │                │ - Start adaptive run │
           │                └──────────┬───────────┘
           │                           │
           │           ┌───────────────▼────────────────┐
           │           │ Adaptive runner                │
           └───────────► coverage.ts                    │
                       │ - pickInRegion (popularity +   │
                       │   bubble + reachability)       │
                       │ - pickNextRegion (Σ-score)     │
                       │ - travelAndCapture (REUSED)    │
                       │ - bridgeToRegion (NEW)         │
                       └────────────────────────────────┘
                                       │
                       ┌───────────────▼────────────────┐
                       │ Cross-region bridge            │
                       │ enterHavreSac → zaapTeleport   │
                       │ (with N1 fallback on any fail) │
                       └────────────────────────────────┘
```

## Component 1 — Region engine (`dofus-app/public/lib/regions.ts`)

New TS module, side-effect-free, pure functions.

### Types

```ts
export interface Region {
  id: number;
  mapIds: Set<number>;
  worldMaps: Set<number>;          // {1}, {-1}, or {1, -1} for crossing components
  subareas: Map<number, number>;   // subAreaId → number of maps
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface WorldGraph {
  adjacency: Map<number, number[]>;     // src uid → dest uids (one-way)
  uidToMapId: Map<number, number>;
  mapIdToUids: Map<number, number[]>;
}
```

### API

```ts
export function loadWorldGraphFromJson(json: any): WorldGraph;

export function computeRegions(
  graph: WorldGraph,
  mapMeta: Map<number, { posX, posY, worldMap, subAreaId }>
): Region[];
// Implementation: union-find. For each edge u→v, union(uidToMapId[u], uidToMapId[v]).
// All vertices of a same mapId are unioned together too. Result is undirected
// connected components at the mapId level. wm-agnostic — if a worldgraph edge
// crosses wm=1↔wm=-1, the two maps end up in the same region.

export function regionOf(mid: number, regions: Region[]): Region | null;

export function reachableRegionsFrom(
  mid: number,
  graph: WorldGraph,
  regions: Region[]
): Set<number>;
// BFS at the mapId level, returns the IDs of all regions touched.
// Note: under undirected connected-component semantics, this is just
// `{ regionOf(mid).id }`. Kept as an API hook for potential directed-BFS
// refinement later.

export function isReachableMid(
  src: number, dst: number, graph: WorldGraph, maxHops?: number
): boolean;
// Same logic as autoTravelInstant's in-agent BFS, port to TS so the picker
// can probe before firing bbd. maxHops default 40.

export function manhattanCenter(region: Region): { x: number; y: number };
// Centroid of the region's mapIds — used by bridge selection to pick the
// "best" zaap dest among the destinations whose mapId falls in the region.
```

### Caching

A module-level singleton cache keyed by the worldgraph payload's hash (or
just by reference identity of the loaded JSON object). Re-computed once on
load, again when the user clicks REFRESH in the existing Reachability
checker UI (which already POSTs `/api/worldgraph` to re-dump).

### Tests

A small Jest-style test file `regions.test.ts` (run via existing toolchain
or `node --test` if no Jest setup) with synthetic adjacency:

- Two disconnected triangles → 2 regions of 3 maps each.
- One triangle + one square joined by a one-way edge → 1 region of 7 maps
  (undirected union).
- Empty graph → 0 regions.

## Component 2 — Builder UI

New `<fieldset>` inserted in `dofus-app/public/panels/coverage.ts`'s left
column, between the existing `catalog + plan` fieldset and the `runner`
fieldset.

### Markup

```html
<fieldset id="cv-builder">
  <legend>smart coverage builder</legend>

  <div class="row">
    <span>worlds:</span>
    <label><input type="checkbox" data-wm="1" checked> wm=1</label>
    <label><input type="checkbox" data-wm="-1" checked> wm=-1</label>
  </div>

  <div class="row">
    <span>subareas:</span>
    <label><input type="radio" name="cv-sa-mode" value="any" checked> any</label>
    <label><input type="radio" name="cv-sa-mode" value="include"> include only</label>
    <label><input type="radio" name="cv-sa-mode" value="exclude"> exclude</label>
  </div>
  <div id="cv-sa-tags"><!-- rendered tags + autocomplete input --></div>

  <div class="row">
    <span>havre-sac map id:</span>
    <input id="cv-hb-mapid" type="text" placeholder="auto-fill or manual">
    <span>havre-sac id:</span>
    <input id="cv-hb-id" type="text" placeholder="ecxt for igd">
    <button id="cv-hb-autofill">auto-fill</button>
  </div>

  <button id="cv-compute-regions">↻ Compute regions</button>
  <div id="cv-regions-list"><!-- rendered region list --></div>

  <div class="row">
    <button id="cv-start-adaptive" class="primary">▶ Start adaptive run</button>
  </div>
</fieldset>
```

### Behaviour

- **Worlds checkboxes** — both default checked. Filter the displayed regions:
  hide regions whose `worldMaps` doesn't intersect the selected set.
  Persist to `localStorage` key `cv.adaptive.worlds`.
- **Subareas filter** — radio for mode + searchable multi-select. Tags
  rendered as `<span class="tag">name <button>×</button></span>`. Persisted
  to `localStorage` key `cv.adaptive.subareas`.
- **Havre-sac inputs** — manual entry by default. `auto-fill` button uses
  the in-HB capture workflow:
  1. User goes into their haven-bag in-game (presses H once).
  2. Clicks `auto-fill`.
  3. Handler reads `getCurrentMapId()` → stores as `havreSacMapId` IF the
     current map matches the haven-bag pattern (server uses a special
     subarea / wm value; we sanity-check via `getCurrentMapInfo` if needed,
     else just trust the user's claim).
  4. For `havreSacId`: tail the recent outgoing-packet log via
     `getOutgoingLog` (existing RPC), look for the most recent `igd` send
     and read `ecxt`. If not found in the recent buffer, ask the user to
     press H once more while we listen via `onWsEvent`.
  Persisted to `localStorage` key `cv.adaptive.havreSac`. No new RPC needed.
- **Compute regions** — calls `regions.ts:computeRegions`, applies the
  filters to score each region, renders the list sorted by Σscore desc:

  ```
  R0  wm=1   2841 maps  Σscore=12740  (current)
  R1  wm=1    603 maps  Σscore= 4218
  R2  wm=-1  1145 maps  Σscore= 8902
  R3  mixed   188 maps  Σscore=  640
  ```

  The current row (containing player's `currentMapId`) is highlighted.
  Region score = `Σ_{m ∈ region.mapIds, m matches filters} scoreMap(m)` where
  `scoreMap` is the existing popularity-weighted scorer.

- **Start adaptive run** — sets `planMode = "adaptive"`, stashes the current
  config (`worlds, subareaFilter, havreSacInfo, regions`) into a runtime
  object, and calls the existing `runPlan()` (which now branches on the
  mode). The existing `START` button in the `runner` fieldset is disabled
  while `adaptive` mode is active to avoid mode confusion.

## Component 3 — Adaptive runner

New branch added to the existing `runPlan()` function in `coverage.ts`.

### State

```ts
interface AdaptiveState {
  worlds: Set<number>;                // {1, -1} or subset
  subareaMode: "any" | "include" | "exclude";
  subareas: Set<number>;
  havreSac: { id: number; mapId: number } | null;
  regions: Region[];
  graph: WorldGraph;
  activeRegionId: number | null;
  regionFails: Map<number, number>;   // consecutive silent-rejects per region
}
```

### Loop

```
while runRequested:
  1. await refreshPlayerMapId()
  2. if activeRegionId == null OR isRegionExhausted(activeRegionId):
       next = pickNextRegion()
       if next == null: setPhase("done", "no region left"); break
       if next.id != activeRegionId AND
          regionOf(currentMapId).id != next.id:
         → bridgeToRegion(next.id)  (with N1 fallback on fail)
       activeRegionId = next.id
       regionFails[next.id] = 0
  3. nextMap = pickInRegion(activeRegionId)
     if nextMap == null:
       activeRegionId = null  // re-evaluate at top
       continue
  4. setCurrentTarget(nextMap, nextMap.score)
     res = await travelAndCapture(nextMap)   ← REUSED
  5. if res == "ok":
       visited += map; pruneCapturedMaps(); regionFails[active] = 0
     elif res == "skip":
       failed += map
     else:  // "fail"
       failed += map
       regionFails[active]++
       if regionFails[active] > BRICK_THRESHOLD (default 5):
         setPhase("fail", "suspect Tier-2 brick — restart Dofus then click RESUME")
         pause until user clicks RESUME or stops
  6. await waitIdleAndStable()  ← existing
```

### `pickInRegion(regionId)`

```
candidates = []
for m in region.mapIds:
  if visited.has(m) || failed.has(m): continue
  if !matchesFilters(m, worlds, subareaFilter): continue
  s = scoreMap(m)  ← existing weighted scorer
  if s <= 0: continue
  if !isReachableMid(currentMid, m, graph): continue
  candidates.push({ map: m, score: s })

return pickWithBubble(candidates, currentMapPos, MAX_HOP=5)
  // tie-break:
  //   1. dist <= MAX_HOP  → preferred (0 < 1)
  //   2. same wm as current → preferred (0 < 1)
  //   3. dist asc
  //   4. -score asc (higher score wins)
```

### `pickNextRegion()`

```
candidates = []
for r in regions:
  if !regionMatchesWorldFilter(r, worlds): continue
  s = Σ scoreMap(m) for m in r.mapIds matching filters and not visited/failed
  if s <= 0: continue
  candidates.push({ region: r, score: s })
candidates.sort by score desc
return candidates[0] || null
```

### `isRegionExhausted(regionId)`

True iff `pickInRegion(regionId)` returns null.

### Edge cases

- **Player position unknown** (`currentMapId` null/0) — fall back to scoring
  candidates without bubble preference (just by score), as the existing
  scored mode does.
- **Worldgraph not loaded** — disable the Start adaptive button, show
  inline message "click REFRESH in the Map tab reachability checker".
- **All regions Σscore=0** — runner displays "done — all reachable
  popularity-weighted coverage captured" and stops.

## Component 4 — Cross-region bridge

New helper in `coverage.ts`:

```ts
async function bridgeToRegion(targetRegionId: number): Promise<"ok" | "fallback-n1"> {
  const region = state.regions[targetRegionId];

  // 1. Pick the best zaap dest within the target region
  const known = await rpcCall<any>("listKnownZaaps", []);
  const zaapsInRegion = (known.items ?? []).filter(z =>
    region.mapIds.has(z.mapId)
  );
  if (zaapsInRegion.length === 0) {
    // No unlocked zaap in target region — manual N1
    return n1Fallback(region);
  }
  const center = manhattanCenter(region);
  zaapsInRegion.sort((a, b) =>
    Math.abs(a.posX - center.x) + Math.abs(a.posY - center.y)
    - (Math.abs(b.posX - center.x) + Math.abs(b.posY - center.y))
  );
  const target = zaapsInRegion[0];

  // 2. Need havreSacInfo
  if (!state.havreSac) return n1Fallback(region);

  // 3. enterHavreSac and wait for jmw
  setPhase("traveling", `bridge → enterHavreSac`);
  await rpcCall("enterHavreSac", [state.havreSac.id]);
  if (!await waitForMapId(state.havreSac.mapId, 8000)) {
    return n1Fallback(region);
  }

  // 4. zaapTeleport — assumes spawn cell is adjacent enough.
  //    If it throws "not on zaap cell", we N1-fallback.
  setPhase("traveling", `bridge → zaapTeleport(${target.mapId})`);
  const z = await rpcCall<any>("zaapTeleport", [target.mapId]);
  if (z.ok === false) return n1Fallback(region);

  if (!await waitForMapId(target.mapId, 8000)) return n1Fallback(region);

  return "ok";
}

function n1Fallback(region: Region): "fallback-n1" {
  setPhase("stopped",
    `cross-region needed — manually open haven-bag + zaap to mapId in region ${region.id} ` +
    `(suggested coords near ${manhattanCenter(region)}). Runner will resume on map change.`);
  // Install a one-shot jmw listener that, on map change to a map in `region`,
  // resumes the adaptive loop.
  arm-resume-listener(region);
  return "fallback-n1";
}
```

`waitForMapId(mid, ms)` is a new helper using the existing `onWsEvent` to
listen for `jmw{ekry == mid}`, with timeout.

## RPC dependencies

Existing, reused as-is:

- `getCurrentMapId`
- `autoTravelInstant`
- `abortAutoTravel`
- `installOutgoingHook`
- `hookAutopilotDone`
- `getInteractivesOnMap`
- `probeStaticField` (Tier-1 cleanup)
- `probeFozCts` (Tier-1 cleanup)
- `enterHavreSac(havreSacId)`
- `zaapTeleport(mapId)`
- `listKnownZaaps`
- `findCurrentMapZaap`
- `getNeighborMapIds`

NEW: (none)

The auto-fill workflow uses existing RPCs only:
- `getCurrentMapId` — captures `havreSacMapId` when the user is in their HB.
- `getOutgoingLog` + `onWsEvent('socket')` — captures the next `igd{ecxt}`
  outgoing packet to read `havreSacId`.

If a future iteration wants a one-click auto-fill without requiring the user
to be in their HB, a `getMyHavreSacInfo` RPC can be added later (Phase 2).

## HTTP / server changes

None. Worldgraph already served via existing `/api/worldgraph`.

## Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Worldgraph not loaded | `regions.length === 0` | Disable Start, show inline error |
| No region matches filters | `pickNextRegion() == null` | "done — adjust filters" |
| Region exhausted | `pickInRegion() == null` | Re-evaluate at top of loop |
| Tier-2 brick suspected | `regionFails > 5` | Pause + RESUME button |
| havreSac missing | `state.havreSac == null` | N1 fallback (manual + auto-resume) |
| zaap not unlocked in target region | empty `zaapsInRegion` | N1 fallback |
| zaapTeleport "not on zaap cell" | `z.ok === false` | N1 fallback |
| `enterHavreSac` fails (xbe throws) | `r.ok === false` | N1 fallback |
| Map-change to N1-region detected | jmw listener | Resume runner on new region |

## Testing plan

1. **Unit**: `regions.ts` against synthetic adjacency (3 cases above).
2. **Smoke (manual, browser)**:
   - Load coverage panel; verify Smart Coverage Builder fieldset renders.
   - Click Compute regions; verify ≥2 regions with sane Σscore values.
   - Toggle wm=1 only → list filters correctly.
   - Add a subarea exclude tag → list updates.
3. **E2E (in-game)**:
   - From Astrub city, Start adaptive run; verify it captures top wm=1
     maps without leaving the region.
   - Manually walk to wm=-1 entry; verify region switches without bridge.
   - Trigger a cross-region scenario (capture all wm=1 within reach,
     ensure runner attempts bridge to wm=-1 component).
4. **Regression**: re-test scored mode (`reload plan` + START) and ordered
   mode (`USE COVERAGE PLAN`) to confirm they still work.
5. **Verification**: type-check via `tsc` (existing build pipeline).

## Defaults chosen

- `BRICK_THRESHOLD` = 5 consecutive silent-rejects before pause.
- Zaap dest selection = Manhattan-closest to region centroid.
- `MAX_HOP` bubble = 5 (unchanged from existing).
- Worlds default = both wm=1 and wm=-1 checked.
- Subarea filter default = `any` (no filter).

## Open TBDs (resolve during implementation)

- Confirm haven-bag spawn cell adjacency to zaap NPC — if not adjacent in
  the test player's haven-bag layout, queue a Phase 1.5 task to add a
  walk-to-cell primitive (probably synthesizing an `iri` packet directly).
- Confirm `igd` is the right outgoing class to capture for `havreSacId`.
  `autopilot-investigation.md` line 3352-3356 says yes (H key → `igd{ecxt}`),
  to validate end-to-end during implementation.

## Out of scope (Phase 2+)

- Zaap-network as virtual edges in BFS (allowing the picker to plan
  multi-leg zaap-routes purely client-side).
- Auto-restart of Dofus / re-attach of Frida on Tier-2 brick detection.
- Multi-character planning.
