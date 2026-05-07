# Dofus Plugin — Map Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder Map sub-tab in the Dofus plugin with a working world view (all maps of a world rendered as colored tiles at their (posX, posY) coords) + click-to-inspect cell-grid in a right-side panel. Static data only (139 MB bundled), no live agent for v1.

**Architecture:** 3 pure Canvas2D libraries (`cell-flags`, `cell-grid`, `world-canvas`) + 1 backend data-prep step (extract from DataCenter) + 3 backend routes (`/api/dofus/worlds`, `/maps/list`, `/maps/:mapId`) + 1 page orchestrator (`mountMap`) wired into the existing Dofus plugin's root sub-tab dispatch. No agent code modified.

**Tech Stack:** TypeScript 5.5, vite 5, vitest 2 (with happy-dom), Express 4, supertest 7, tsx (for the build-data script).

**Spec:** [docs/superpowers/specs/2026-05-08-dofus-plugin-map-feature-design.md](../specs/2026-05-08-dofus-plugin-map-feature-design.md)

**File map:**

| File | Created/Modified by Task | Role |
|---|---|---|
| `app/plugins/dofus/data/maps/<mapId>.json` (~20k files, 139 MB) | T1 | Per-map cell data, copied from `dofus-app/data/maps/` working dir |
| `app/plugins/dofus/data/maps-information.json` | T1 | Index `[{mapId, posX, posY, subAreaId, worldMap, nameId, name}]` |
| `app/plugins/dofus/data/areas.json` | T1 | `{ areas, subAreas, worlds }` lookups |
| `app/plugins/dofus/scripts/build-data.ts` | T1 | One-shot prep script (`npx tsx`) |
| `app/package.json` (modify) | T1 | Add `dofus:build-data` npm script |
| `app/plugins/dofus/.gitattributes` | T1 | Mark `data/maps/*.json` as `linguist-generated` (cleaner git stats) |
| `app/plugins/dofus/lib/cell-flags.ts` | T2 | `decodeCellFlags`, `cellColor` |
| `app/plugins/dofus/lib/cell-grid.ts` | T3 | `renderCellGrid(canvas, opts)` |
| `app/plugins/dofus/lib/world-canvas.ts` | T4 | `renderWorldCanvas(canvas, opts) → { hitTest }` |
| `app/plugins/dofus/lib/data-store.ts` | T5 | Backend-side `DofusDataStore` (load + LRU) |
| `app/plugins/dofus/routes/index.ts` (modify) | T5 | Add 3 routes; wire `DofusDataStore` |
| `app/plugins/dofus/pages/map.ts` | T6 | `mountMap(host, ctx)` — orchestrator |
| `app/plugins/dofus/pages/root.ts` (modify) | T7 | Lazy-import `map.ts` for the "map" sub-tab |
| `app/test/plugins/dofus/lib/cell-flags.test.ts` | T2 | 5 tests |
| `app/test/plugins/dofus/lib/cell-grid.test.ts` | T3 | 3 tests |
| `app/test/plugins/dofus/lib/world-canvas.test.ts` | T4 | 5 tests |
| `app/test/plugins/dofus/lib/data-store.test.ts` | T5 | 4 tests |
| `app/test/plugins/dofus/routes-map.test.ts` | T5 | 6 tests |
| `app/test/plugins/dofus/pages/map.test.ts` | T6 | 3 tests |
| `app/SMOKE-TEST.md` (modify) | T8 | Append v1 dofus-map smoke checklist |

---

## Task 1: Data prep — copy maps + build indexes

**Files:**
- Create: `app/plugins/dofus/data/maps/<mapId>.json` (bulk copy)
- Create: `app/plugins/dofus/data/maps-information.json`
- Create: `app/plugins/dofus/data/areas.json`
- Create: `app/plugins/dofus/scripts/build-data.ts`
- Create: `app/plugins/dofus/.gitattributes`
- Modify: `app/package.json` (add `dofus:build-data` script)

This task has NO TDD — it's a setup task that produces input data for everything else. The script `build-data.ts` IS pure-functional but its main effect is writing files; we test the transformation separately in T5 via the data-store layer.

- [ ] **Step 1: Create `app/plugins/dofus/.gitattributes`**

Mark the bulk JSON data as generated so it's de-emphasized in `git diff` and `git log` stats. Useful for the 139 MB dump.

`app/plugins/dofus/.gitattributes`:

```
data/maps/**/*.json linguist-generated=true
data/maps-information.json linguist-generated=true
```

- [ ] **Step 2: Create `app/plugins/dofus/scripts/build-data.ts`**

Reads from `.toolkit-data/datacenter/` at the repo root and writes the two index files into `app/plugins/dofus/data/`.

`app/plugins/dofus/scripts/build-data.ts`:

```ts
#!/usr/bin/env tsx
// Build Dofus plugin static index files from a datacenter dump.
// Run: npm run dofus:build-data (from app/) OR npx tsx <this file> (from anywhere).
//
// Inputs (read from <repo-root>/.toolkit-data/datacenter/):
//   - MapsInformationDataRoot.json
//   - AreasDataRoot.json
//   - SubAreasDataRoot.json
//   - WorldMapsDataRoot.json
//
// Outputs (written to app/plugins/dofus/data/):
//   - maps-information.json
//   - areas.json

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_DIR, "../../../..");
const DC_DIR = path.join(REPO_ROOT, ".toolkit-data", "datacenter");
const OUT_DIR = path.resolve(_DIR, "../data");

interface DcMap { id: number; posX: number; posY: number; subAreaId: number; worldMap: number; nameId?: number }
interface DcArea { id: number; nameId?: number; name?: string }
interface DcSubArea { id: number; areaId: number; nameId?: number; name?: string }
interface DcWorld { id: number; nameId?: number; name?: string }

function readJson<T>(p: string): T {
    if (!fs.existsSync(p)) {
        throw new Error(`required file not found: ${p}\n(run the datacenter dump first — see dofus-app/scripts/dump-datacenter.js)`);
    }
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function readJsonOpt<T>(p: string, fallback: T): T {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function nameOrId(o: { name?: string; nameId?: number; id: number }): string {
    return o.name ?? (o.nameId !== undefined ? `#${o.nameId}` : `id-${o.id}`);
}

function main(): void {
    console.log(`[dofus:build-data] reading from ${DC_DIR}`);
    const dcMaps = readJson<DcMap[]>(path.join(DC_DIR, "MapsInformationDataRoot.json"));
    const dcAreas = readJsonOpt<DcArea[]>(path.join(DC_DIR, "AreasDataRoot.json"), []);
    const dcSubAreas = readJsonOpt<DcSubArea[]>(path.join(DC_DIR, "SubAreasDataRoot.json"), []);
    const dcWorlds = readJsonOpt<DcWorld[]>(path.join(DC_DIR, "WorldMapsDataRoot.json"), []);

    fs.mkdirSync(OUT_DIR, { recursive: true });

    // maps-information.json
    const mapsOut = dcMaps
        .filter((m) => m.id != null && m.worldMap != null)
        .map((m) => ({
            mapId: m.id,
            posX: m.posX ?? 0,
            posY: m.posY ?? 0,
            subAreaId: m.subAreaId ?? 0,
            worldMap: m.worldMap,
            nameId: m.nameId ?? 0,
            name: nameOrId({ name: undefined, nameId: m.nameId, id: m.id }),
        }));
    fs.writeFileSync(path.join(OUT_DIR, "maps-information.json"), JSON.stringify(mapsOut), "utf8");
    console.log(`[dofus:build-data] wrote maps-information.json — ${mapsOut.length} maps`);

    // areas.json
    const areasOut = {
        areas: Object.fromEntries(dcAreas.map((a) => [a.id, { id: a.id, name: nameOrId(a) }])),
        subAreas: Object.fromEntries(dcSubAreas.map((s) => [s.id, { id: s.id, areaId: s.areaId, name: nameOrId(s) }])),
        worlds: Object.fromEntries(
            (dcWorlds.length > 0
                ? dcWorlds.map((w) => [w.id, { id: w.id, name: nameOrId(w) }])
                : HARDCODED_WORLDS.map((w) => [w.id, w])
            ),
        ),
    };
    fs.writeFileSync(path.join(OUT_DIR, "areas.json"), JSON.stringify(areasOut, null, 2), "utf8");
    console.log(`[dofus:build-data] wrote areas.json — ${Object.keys(areasOut.worlds).length} worlds`);

    console.log("[dofus:build-data] done.");
}

const HARDCODED_WORLDS: Array<{ id: number; name: string }> = [
    { id: -1, name: "Caves" },
    { id: 1,  name: "Amakna" },
    { id: 10, name: "Frigost" },
    { id: 12, name: "Otomai" },
    { id: 13, name: "Saharach" },
    { id: 14, name: "Brakmar" },
    { id: 15, name: "Pandala" },
    { id: 16, name: "Bonta" },
    { id: 17, name: "Astrub" },
    { id: 18, name: "Incarnam" },
];

main();
```

- [ ] **Step 3: Add npm script to `app/package.json`**

In `app/package.json`, find the `"scripts"` block and add:

```json
"dofus:build-data": "tsx plugins/dofus/scripts/build-data.ts"
```

(Keep the trailing comma correct — insert before the closing `}` of `scripts`.)

- [ ] **Step 4: Copy the per-map JSON files**

The 139 MB of per-map JSONs live on local disk at `dofus-app/data/maps/` (NOT in any git branch — they're locally-generated dumps the user has). Copy them into the plugin:

```bash
mkdir -p app/plugins/dofus/data/maps
cp -r dofus-app/data/maps/*.json app/plugins/dofus/data/maps/
ls app/plugins/dofus/data/maps | wc -l
```

Expected: ~20,000 files. The exact count depends on how many maps the dump includes.

If the source dir doesn't exist or is empty, FAIL HARD — the plan can't proceed without these files. Report `BLOCKED` and ask the user where the data is.

- [ ] **Step 5: Run the build-data script to produce the indexes**

```bash
cd app && npm run dofus:build-data
```

Expected output:
```
[dofus:build-data] reading from <repo>/.toolkit-data/datacenter
[dofus:build-data] wrote maps-information.json — N maps
[dofus:build-data] wrote areas.json — K worlds
[dofus:build-data] done.
```

- [ ] **Step 6: Verify the produced files**

```bash
ls -la app/plugins/dofus/data/
```

Expected:
- `maps/` dir with ~20k `.json` files
- `maps-information.json` (~5 MB)
- `areas.json` (<100 KB)

- [ ] **Step 7: Commit**

This commit will be HUGE (~140 MB add). Use a focused message:

```bash
git add app/plugins/dofus/data app/plugins/dofus/scripts app/plugins/dofus/.gitattributes app/package.json
git commit -m "feat(dofus-map): bundle 139 MB static map data + build-data prep script"
```

---

## Task 2: cell-flags decoder + colors

**Files:**
- Create: `app/plugins/dofus/lib/cell-flags.ts`
- Test: `app/test/plugins/dofus/lib/cell-flags.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/plugins/dofus/lib/cell-flags.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decodeCellFlags, cellColor } from "../../../../plugins/dofus/lib/cell-flags";

describe("decodeCellFlags", () => {
    it("flags=0 → all false", () => {
        expect(decodeCellFlags(0)).toEqual({
            mov: false, los: false, nonRP: false,
            farm: false, visible: false, havenbag: false,
        });
    });

    it("flags=0b1100001 (mov + los + havenbag) → those 3 true", () => {
        // bits: 0(mov), 1(los), 6(havenbag) → 1 + 2 + 64 = 67 = 0b1000011
        // Wait: bit-naming: mov=bit0(1), los=bit1(2), havenbag=bit6(64). Sum = 67.
        const f = decodeCellFlags(0b1000011);
        expect(f.mov).toBe(true);
        expect(f.los).toBe(true);
        expect(f.havenbag).toBe(true);
        expect(f.visible).toBe(false);
        expect(f.farm).toBe(false);
        expect(f.nonRP).toBe(false);
    });
});

describe("cellColor", () => {
    it("invisible (no bit 5) → null", () => {
        expect(cellColor(0b0000001, 0)).toBeNull();  // mov but not visible
    });

    it("visible + walkable (mov) → green '#3a7b3a'", () => {
        expect(cellColor(0b0100001, 0)).toBe("#3a7b3a");  // visible + mov
    });

    it("visible + non-mov + los → wall '#4a4030'", () => {
        expect(cellColor(0b0100010, 0)).toBe("#4a4030");  // visible + los, no mov
    });

    it("visible + non-mov + non-los → dark wall '#2a2520'", () => {
        expect(cellColor(0b0100000, 0)).toBe("#2a2520");  // visible only
    });

    it("visible + mov + farm → yellow '#d9b02c'", () => {
        expect(cellColor(0b0110001, 0)).toBe("#d9b02c");  // visible + mov + farm
    });

    it("visible + mov + havenbag → cyan '#3cd'", () => {
        expect(cellColor(0b1100001, 0)).toBe("#3cd");
    });

    it("visible + mov + mcd > 0 → orange '#ff9d00'", () => {
        expect(cellColor(0b0100001, 1)).toBe("#ff9d00");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/plugins/dofus/lib/cell-flags.test.ts
```

Expected: ALL FAIL (file does not exist).

- [ ] **Step 3: Implement `cell-flags.ts`**

`app/plugins/dofus/lib/cell-flags.ts`:

```ts
// Cell flags bitfield (from the Dofus mapdata bundles, reverse-engineered):
//   bit 0 mov, 1 los, 2 nonWalkableDuringFight (unused here),
//   3 nonWalkableDuringRP, 4 farmCell, 5 visible, 6 havenbagCell.

export interface CellFlags {
    mov: boolean;       // walkable in RP mode
    los: boolean;       // line-of-sight blocking when non-mov
    nonRP: boolean;     // non-walkable during RP (cell skipped from render)
    farm: boolean;      // farm cell (resources)
    visible: boolean;   // any-rendered cell — non-visible cells are skipped
    havenbag: boolean;  // havenbag drop cell
}

export function decodeCellFlags(flags: number): CellFlags {
    return {
        mov:      !!(flags & 1),
        los:      !!((flags >> 1) & 1),
        nonRP:    !!((flags >> 3) & 1),
        farm:     !!((flags >> 4) & 1),
        visible:  !!((flags >> 5) & 1),
        havenbag: !!((flags >> 6) & 1),
    };
}

/** Returns the fill color for a cell, or null if the cell should not be drawn. */
export function cellColor(flags: number, mcd: number): string | null {
    const f = decodeCellFlags(flags);
    if (!f.visible) return null;
    if (!f.mov)     return f.los ? "#4a4030" : "#2a2520";
    if (f.nonRP)    return null;
    if (mcd)        return "#ff9d00";
    if (f.farm)     return "#d9b02c";
    if (f.havenbag) return "#3cd";
    return "#3a7b3a";
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run test/plugins/dofus/lib/cell-flags.test.ts
```

Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/cell-flags.ts app/test/plugins/dofus/lib/cell-flags.test.ts
git commit -m "feat(dofus-map): cell-flags bitfield decoder + cellColor"
```

---

## Task 3: cell-grid renderer

**Files:**
- Create: `app/plugins/dofus/lib/cell-grid.ts`
- Test: `app/test/plugins/dofus/lib/cell-grid.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/plugins/dofus/lib/cell-grid.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Window } from "happy-dom";
import { renderCellGrid } from "../../../../plugins/dofus/lib/cell-grid";

function makeCanvas(): HTMLCanvasElement {
    const window = new Window();
    return (window.document as unknown as Document).createElement("canvas") as unknown as HTMLCanvasElement;
}

// happy-dom doesn't implement Canvas2D — we mock getContext to capture calls.
function withMockContext(canvas: HTMLCanvasElement) {
    const ctx = {
        clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
        closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
        fillRect: vi.fn(), fillText: vi.fn(),
        fillStyle: "", strokeStyle: "", lineWidth: 0, font: "",
    };
    canvas.getContext = vi.fn(() => ctx) as unknown as HTMLCanvasElement["getContext"];
    return ctx;
}

describe("renderCellGrid", () => {
    let canvas: HTMLCanvasElement;
    beforeEach(() => { canvas = makeCanvas(); });

    it("sets canvas dimensions based on cellSize=16 default", () => {
        withMockContext(canvas);
        renderCellGrid(canvas, { cells: [] });
        // 14.5 cols × 16 = 232 width, 41 × 8 = 328 height
        expect(canvas.width).toBe(232);
        expect(canvas.height).toBe(328);
    });

    it("custom cellSize=24 → canvas width = 14.5 × 24 = 348", () => {
        withMockContext(canvas);
        renderCellGrid(canvas, { cells: [], cellSize: 24 });
        expect(canvas.width).toBe(348);
    });

    it("renders fill calls for visible+walkable cells, skips invisible cells", () => {
        const ctx = withMockContext(canvas);
        // 560 cells: index 0 visible+walkable (flags=0b0100001=33), all others 0 (invisible)
        const cells: Array<[number, number, number, number, number]> = [];
        cells.push([33, 0, 0, 0, 0]);
        for (let i = 1; i < 560; i++) cells.push([0, 0, 0, 0, 0]);
        renderCellGrid(canvas, { cells });
        // Exactly 1 visible cell rendered → 1 fill call
        expect(ctx.fill).toHaveBeenCalledTimes(1);
        expect(ctx.fillStyle).toBe("#3a7b3a");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/plugins/dofus/lib/cell-grid.test.ts
```

Expected: ALL FAIL (file does not exist).

- [ ] **Step 3: Implement `cell-grid.ts`**

`app/plugins/dofus/lib/cell-grid.ts`:

```ts
import { cellColor } from "./cell-flags";

export interface CellGridOpts {
    cells: Array<[number, number, number, number, number]>;
    /** Pixel size of one cell. Default 16 → ~232×328 canvas. */
    cellSize?: number;
}

const COLS = 14;
const ROWS = 40;

/**
 * Renders the iso 14×40 cell grid onto the given canvas. Pure renderer —
 * caller owns the canvas and event wiring.
 *
 * Cell layout: even rows aligned to col-grid; odd rows shifted right by half a cell
 * (Dofus iso convention). Each cell drawn as a rhombus.
 */
export function renderCellGrid(canvas: HTMLCanvasElement, opts: CellGridOpts): void {
    const cellSize = opts.cellSize ?? 16;
    const halfH = cellSize / 2;

    canvas.width  = (COLS + 0.5) * cellSize;
    canvas.height = (ROWS + 1) * halfH;

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(0,0,0,0.3)";

    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const idx = row * COLS + col;
            const cell = opts.cells[idx];
            if (!cell) continue;
            const [flags, mcd] = cell;
            const fill = cellColor(flags, mcd);
            if (!fill) continue;

            const cx = col * cellSize + (row & 1 ? cellSize / 2 : 0) + cellSize / 2;
            const cy = row * halfH + halfH;

            ctx.beginPath();
            ctx.moveTo(cx,             cy - halfH);
            ctx.lineTo(cx + cellSize/2, cy);
            ctx.lineTo(cx,             cy + halfH);
            ctx.lineTo(cx - cellSize/2, cy);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.stroke();
        }
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/plugins/dofus/lib/cell-grid.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/cell-grid.ts app/test/plugins/dofus/lib/cell-grid.test.ts
git commit -m "feat(dofus-map): cell-grid Canvas2D renderer (iso 14×40 with flag colors)"
```

---

## Task 4: world-canvas renderer + hit-test

**Files:**
- Create: `app/plugins/dofus/lib/world-canvas.ts`
- Test: `app/test/plugins/dofus/lib/world-canvas.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/plugins/dofus/lib/world-canvas.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Window } from "happy-dom";
import { renderWorldCanvas, type WorldMap } from "../../../../plugins/dofus/lib/world-canvas";

function makeCanvas(): HTMLCanvasElement {
    const window = new Window();
    return (window.document as unknown as Document).createElement("canvas") as unknown as HTMLCanvasElement;
}

function withMockContext(canvas: HTMLCanvasElement) {
    const ctx = {
        clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
        fillStyle: "", strokeStyle: "", lineWidth: 0, font: "",
    };
    canvas.getContext = vi.fn(() => ctx) as unknown as HTMLCanvasElement["getContext"];
    return ctx;
}

const m = (mapId: number, posX: number, posY: number, areaId = 0): WorldMap =>
    ({ mapId, posX, posY, subAreaId: areaId, areaId, name: `m${mapId}` });

describe("renderWorldCanvas", () => {
    let canvas: HTMLCanvasElement;
    beforeEach(() => { canvas = makeCanvas(); });

    it("empty maps array → 'No maps' message + null hitTest", () => {
        const ctx = withMockContext(canvas);
        const r = renderWorldCanvas(canvas, { maps: [] });
        expect(ctx.fillText).toHaveBeenCalledWith(expect.stringMatching(/No maps/), expect.any(Number), expect.any(Number));
        expect(r.hitTest(50, 50)).toBeNull();
    });

    it("computes bbox from negative + positive coords", () => {
        withMockContext(canvas);
        // Maps at x=-2,1,3 → minX=-2, maxX=3, width=6 tiles. tileSize=14, padding=4 → 14*6+8 = 92
        renderWorldCanvas(canvas, { maps: [m(1,-2,0), m(2,1,0), m(3,3,0)], tileSize: 14 });
        expect(canvas.width).toBe(6 * 14 + 8);
    });

    it("hitTest returns mapId for tile at known pixel coords", () => {
        withMockContext(canvas);
        // Single map at (5, 7), tileSize=14, padding=4
        // → tile drawn at px=4, py=4. hitTest(8, 8) should land inside.
        const r = renderWorldCanvas(canvas, { maps: [m(99, 5, 7)], tileSize: 14 });
        expect(r.hitTest(8, 8)).toBe(99);
    });

    it("hitTest returns null for empty space (no map at that coord)", () => {
        withMockContext(canvas);
        // Maps at (0,0) and (2,0) — there's a gap at (1,0)
        const r = renderWorldCanvas(canvas, { maps: [m(1,0,0), m(2,2,0)], tileSize: 14 });
        // The pixel for (1,0) is at (4 + 14, 4) → px≈18,py≈8
        expect(r.hitTest(18, 8)).toBeNull();
    });

    it("selectedMapId draws white outline (strokeRect with #fff)", () => {
        const ctx = withMockContext(canvas);
        renderWorldCanvas(canvas, {
            maps: [m(7, 0, 0)],
            selectedMapId: 7,
            tileSize: 14,
        });
        expect(ctx.strokeStyle).toBe("#fff");
        expect(ctx.strokeRect).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/plugins/dofus/lib/world-canvas.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `world-canvas.ts`**

`app/plugins/dofus/lib/world-canvas.ts`:

```ts
export interface WorldMap {
    mapId: number;
    posX: number; posY: number;
    subAreaId: number; areaId: number;
    name: string;
}

export interface WorldCanvasOpts {
    maps: WorldMap[];
    selectedMapId?: number | null;
    hoveredMapId?: number | null;
    /** Pixel size of one map tile. Default 14. */
    tileSize?: number;
}

export interface WorldCanvasResult {
    /** Convert canvas-local (px, py) to a mapId, or null if the click is outside any tile. */
    hitTest(px: number, py: number): number | null;
}

/** Hash an areaId to a stable HSL color. Same formula as the original world.ts. */
function areaColor(areaId: number): string {
    const h = (areaId * 137) % 360;
    return `hsl(${h}, 55%, 45%)`;
}

export function renderWorldCanvas(canvas: HTMLCanvasElement, opts: WorldCanvasOpts): WorldCanvasResult {
    const tileSize = opts.tileSize ?? 14;

    if (opts.maps.length === 0) {
        canvas.width = 200; canvas.height = 60;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#888"; ctx.font = "12px sans-serif";
        ctx.fillText("No maps in this world", 10, 30);
        return { hitTest: () => null };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const m of opts.maps) {
        if (m.posX < minX) minX = m.posX;
        if (m.posX > maxX) maxX = m.posX;
        if (m.posY < minY) minY = m.posY;
        if (m.posY > maxY) maxY = m.posY;
    }

    const padding = 4;
    canvas.width  = (maxX - minX + 1) * tileSize + padding * 2;
    canvas.height = (maxY - minY + 1) * tileSize + padding * 2;

    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const tileByXY: Record<string, number> = {};
    for (const m of opts.maps) {
        const x = (m.posX - minX) * tileSize + padding;
        const y = (m.posY - minY) * tileSize + padding;

        ctx.fillStyle = areaColor(m.areaId);
        ctx.fillRect(x, y, tileSize - 1, tileSize - 1);

        if (m.mapId === opts.selectedMapId) {
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, y - 1, tileSize + 1, tileSize + 1);
        } else if (m.mapId === opts.hoveredMapId) {
            ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
            ctx.strokeRect(x, y, tileSize - 1, tileSize - 1);
        }

        tileByXY[`${m.posX},${m.posY}`] = m.mapId;
    }

    const hitTest = (px: number, py: number): number | null => {
        const wx = Math.floor((px - padding) / tileSize) + minX;
        const wy = Math.floor((py - padding) / tileSize) + minY;
        return tileByXY[`${wx},${wy}`] ?? null;
    };
    return { hitTest };
}
```

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/plugins/dofus/lib/world-canvas.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/world-canvas.ts app/test/plugins/dofus/lib/world-canvas.test.ts
git commit -m "feat(dofus-map): world-canvas Canvas2D renderer + hit-test"
```

---

## Task 5: Backend data-store + 3 routes

**Files:**
- Create: `app/plugins/dofus/lib/data-store.ts`
- Modify: `app/plugins/dofus/routes/index.ts`
- Test: `app/test/plugins/dofus/lib/data-store.test.ts`
- Test: `app/test/plugins/dofus/routes-map.test.ts`

- [ ] **Step 1: Write the failing data-store tests**

`app/test/plugins/dofus/lib/data-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DofusDataStore } from "../../../../plugins/dofus/lib/data-store";

describe("DofusDataStore", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "dofus-data-"));
        fs.mkdirSync(path.join(dir, "maps"));
        fs.writeFileSync(path.join(dir, "maps-information.json"), JSON.stringify([
            { mapId: 100, posX: 0, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M100" },
            { mapId: 200, posX: 1, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M200" },
            { mapId: 300, posX: 0, posY: 0, subAreaId: 5, worldMap: 10, nameId: 0, name: "M300" },
        ]));
        fs.writeFileSync(path.join(dir, "areas.json"), JSON.stringify({
            areas: { "0": { id: 0, name: "DefaultArea" } },
            subAreas: {
                "1": { id: 1, areaId: 0, name: "Sub1" },
                "5": { id: 5, areaId: 0, name: "Sub5" },
            },
            worlds: {
                "1": { id: 1, name: "Amakna" },
                "10": { id: 10, name: "Frigost" },
            },
        }));
        // 1 map JSON file
        fs.writeFileSync(path.join(dir, "maps", "100.json"), JSON.stringify({
            mapId: 100, n: [1,2,3,4], c: Array(560).fill([0,0,0,0,0]),
        }));
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("dataReady=true after successful load", () => {
        const store = new DofusDataStore(dir);
        expect(store.dataReady).toBe(true);
    });

    it("listWorlds returns sorted entries with mapCount", () => {
        const store = new DofusDataStore(dir);
        const worlds = store.listWorlds();
        const w1 = worlds.find((w) => w.id === 1);
        const w10 = worlds.find((w) => w.id === 10);
        expect(w1?.mapCount).toBe(2);
        expect(w10?.mapCount).toBe(1);
    });

    it("listMapsByWorld returns enriched maps with areaId resolved from subAreaId", () => {
        const store = new DofusDataStore(dir);
        const maps = store.listMapsByWorld(1);
        expect(maps).toHaveLength(2);
        expect(maps[0].areaId).toBe(0);  // resolved via subAreas[1].areaId
    });

    it("loadMapDetail caches results (LRU)", async () => {
        const store = new DofusDataStore(dir);
        const a = await store.loadMapDetail(100);
        const b = await store.loadMapDetail(100);
        expect(a).not.toBeNull();
        expect(a).toBe(b);  // identity (cached)
    });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd app && npx vitest run test/plugins/dofus/lib/data-store.test.ts
```

Expected: ALL FAIL (file does not exist).

- [ ] **Step 3: Implement `data-store.ts`**

`app/plugins/dofus/lib/data-store.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";

export interface MapInfoEntry {
    mapId: number; posX: number; posY: number;
    subAreaId: number; worldMap: number;
    nameId: number; name: string;
}

export interface AreasFile {
    areas: Record<string, { id: number; name: string }>;
    subAreas: Record<string, { id: number; areaId: number; name: string }>;
    worlds: Record<string, { id: number; name: string }>;
}

export interface WorldMeta { id: number; name: string; mapCount: number }

export interface WorldMap {
    mapId: number; posX: number; posY: number;
    subAreaId: number; areaId: number; name: string;
}

export interface MapDetail extends WorldMap {
    neighbours: number[];
    cells: Array<[number, number, number, number, number]>;
}

const LRU_MAX = 50;

export class DofusDataStore {
    public dataReady = false;
    private mapsIndex: MapInfoEntry[] = [];
    private areasIndex: AreasFile = { areas: {}, subAreas: {}, worlds: {} };
    private worldsIndex: WorldMeta[] = [];
    private mapsByWorld = new Map<number, WorldMap[]>();
    private detailCache = new Map<number, MapDetail>();   // insertion-order LRU

    constructor(private readonly dataDir: string) {
        try {
            this.mapsIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "maps-information.json"), "utf8"));
            this.areasIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "areas.json"), "utf8"));
            this.indexByWorld();
            this.dataReady = true;
        } catch (err) {
            console.error("[dofus] DofusDataStore failed to load:", (err as Error).message);
        }
    }

    private indexByWorld(): void {
        const counts = new Map<number, number>();
        for (const m of this.mapsIndex) {
            counts.set(m.worldMap, (counts.get(m.worldMap) ?? 0) + 1);
            const arr = this.mapsByWorld.get(m.worldMap) ?? [];
            const subArea = this.areasIndex.subAreas[String(m.subAreaId)];
            arr.push({
                mapId: m.mapId, posX: m.posX, posY: m.posY,
                subAreaId: m.subAreaId, areaId: subArea?.areaId ?? 0,
                name: m.name,
            });
            this.mapsByWorld.set(m.worldMap, arr);
        }
        this.worldsIndex = Array.from(counts.entries()).map(([id, mapCount]) => ({
            id, mapCount, name: this.areasIndex.worlds[String(id)]?.name ?? `World ${id}`,
        })).sort((a, b) => a.id - b.id);
    }

    listWorlds(): WorldMeta[] {
        return this.worldsIndex.slice();
    }

    knowsWorld(worldId: number): boolean {
        return this.mapsByWorld.has(worldId);
    }

    listMapsByWorld(worldId: number): WorldMap[] {
        return this.mapsByWorld.get(worldId)?.slice() ?? [];
    }

    async loadMapDetail(mapId: number): Promise<MapDetail | null> {
        const cached = this.detailCache.get(mapId);
        if (cached) {
            // Refresh LRU position
            this.detailCache.delete(mapId);
            this.detailCache.set(mapId, cached);
            return cached;
        }
        const meta = this.mapsIndex.find((m) => m.mapId === mapId);
        if (!meta) return null;
        const file = path.join(this.dataDir, "maps", `${mapId}.json`);
        if (!fs.existsSync(file)) return null;
        const raw = JSON.parse(await fs.promises.readFile(file, "utf8")) as { n?: number[]; c: Array<[number, number, number, number, number]> };
        const subArea = this.areasIndex.subAreas[String(meta.subAreaId)];
        const detail: MapDetail = {
            mapId: meta.mapId, posX: meta.posX, posY: meta.posY,
            subAreaId: meta.subAreaId, areaId: subArea?.areaId ?? 0,
            name: meta.name,
            neighbours: raw.n ?? [],
            cells: raw.c,
        };
        // LRU insert + evict oldest if over capacity
        this.detailCache.set(mapId, detail);
        if (this.detailCache.size > LRU_MAX) {
            const oldest = this.detailCache.keys().next().value;
            if (oldest !== undefined) this.detailCache.delete(oldest);
        }
        return detail;
    }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd app && npx vitest run test/plugins/dofus/lib/data-store.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Write the failing route tests**

`app/test/plugins/dofus/routes-map.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
import { mount as mountDofusRoutes } from "../../plugins/dofus/routes";
import type { PluginBackendDeps } from "../../backend/plugins/registry";

const fakeSession = {
    instanceRegistry: () => null,
    fridaClient: { call: async () => null },
} as never;

function makeFixtureDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dofus-routes-"));
    fs.mkdirSync(path.join(dir, "maps"));
    fs.writeFileSync(path.join(dir, "maps-information.json"), JSON.stringify([
        { mapId: 100, posX: 0, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M100" },
        { mapId: 200, posX: 1, posY: 0, subAreaId: 1, worldMap: 1, nameId: 0, name: "M200" },
        { mapId: 300, posX: 0, posY: 0, subAreaId: 5, worldMap: 10, nameId: 0, name: "M300" },
    ]));
    fs.writeFileSync(path.join(dir, "areas.json"), JSON.stringify({
        areas: { "0": { id: 0, name: "A0" } },
        subAreas: {
            "1": { id: 1, areaId: 0, name: "Sub1" },
            "5": { id: 5, areaId: 0, name: "Sub5" },
        },
        worlds: { "1": { id: 1, name: "Amakna" }, "10": { id: 10, name: "Frigost" } },
    }));
    fs.writeFileSync(path.join(dir, "maps", "100.json"), JSON.stringify({
        mapId: 100, n: [1, 2, 3, 4], c: Array(560).fill([0, 0, 0, 0, 0]),
    }));
    return dir;
}

function buildApp(dataDir: string): express.Express {
    const app = express();
    app.use(express.json());
    mountDofusRoutes(app, { session: fakeSession } as PluginBackendDeps, { dataDir });
    return app;
}

describe("dofus routes — map feature", () => {
    let dataDir: string;

    beforeEach(() => { dataDir = makeFixtureDir(); });
    afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

    it("GET /api/dofus/worlds returns worlds with mapCount", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/worlds");
        expect(r.status).toBe(200);
        expect(r.body.worlds).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 1, name: "Amakna", mapCount: 2 }),
            expect.objectContaining({ id: 10, name: "Frigost", mapCount: 1 }),
        ]));
    });

    it("GET /api/dofus/maps/list?world=1 returns the maps for world 1", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/list?world=1");
        expect(r.status).toBe(200);
        expect(r.body.world).toBe(1);
        expect(r.body.maps).toHaveLength(2);
    });

    it("GET /api/dofus/maps/list (missing world) → 400", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/list");
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/world/);
    });

    it("GET /api/dofus/maps/list?world=99 (unknown world) → 404", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/list?world=99");
        expect(r.status).toBe(404);
        expect(r.body.error).toMatch(/unknown world/);
    });

    it("GET /api/dofus/maps/100 returns cells + neighbours", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/100");
        expect(r.status).toBe(200);
        expect(r.body.mapId).toBe(100);
        expect(r.body.cells).toHaveLength(560);
        expect(r.body.neighbours).toEqual([1, 2, 3, 4]);
    });

    it("GET /api/dofus/maps/200 (no JSON file) → 404", async () => {
        const r = await request(buildApp(dataDir)).get("/api/dofus/maps/200");
        expect(r.status).toBe(404);
    });
});
```

- [ ] **Step 6: Run, expect fail**

```bash
cd app && npx vitest run test/plugins/dofus/routes-map.test.ts
```

Expected: ALL FAIL (the new routes don't exist; `mount` doesn't accept `opts.dataDir` yet).

- [ ] **Step 7: Modify `app/plugins/dofus/routes/index.ts`**

Read the current file first:

```bash
cat app/plugins/dofus/routes/index.ts
```

Replace the contents with:

```ts
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { Express } from "express";
import type { PluginBackendDeps } from "../../../backend/plugins/registry";
import { DofusDataStore } from "../lib/data-store";

const _MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface DofusMountOpts {
    /** Override default data dir for testing. Production: omitted → uses bundled data. */
    dataDir?: string;
}

export function mount(app: Express, deps: PluginBackendDeps, opts: DofusMountOpts = {}): void {
    const dataDir = opts.dataDir ?? path.resolve(_MODULE_DIR, "../data");
    const store = new DofusDataStore(dataDir);

    /** v1.5 plugin-system route, kept unchanged. */
    app.get("/api/dofus/map/current", async (_req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "not attached" }); return; }
        const player = reg.list().find((c) => c.className === "PlayerManager" && c.isAlive);
        if (!player) {
            res.status(404).json({ error: "PlayerManager not captured yet (open the Instances plugin to capture it)" });
            return;
        }
        try {
            const mapId = await deps.session.fridaClient.call(
                "readField",
                [player.className, player.handle, "currentMapId"],
            );
            res.json({ mapId });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /** v1 map feature routes. */
    app.get("/api/dofus/worlds", (_req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        res.json({ worlds: store.listWorlds() });
    });

    app.get("/api/dofus/maps/list", (req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        const worldRaw = req.query.world;
        if (typeof worldRaw !== "string") {
            res.status(400).json({ error: "missing or invalid 'world' query param" });
            return;
        }
        const worldId = parseInt(worldRaw, 10);
        if (!Number.isFinite(worldId)) {
            res.status(400).json({ error: `'world' must be an integer, got '${worldRaw}'` });
            return;
        }
        if (!store.knowsWorld(worldId)) {
            res.status(404).json({ error: `unknown world: ${worldId}` });
            return;
        }
        res.json({ world: worldId, maps: store.listMapsByWorld(worldId) });
    });

    app.get("/api/dofus/maps/:mapId", async (req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        const mapId = parseInt(req.params.mapId, 10);
        if (!Number.isFinite(mapId)) {
            res.status(400).json({ error: `':mapId' must be an integer, got '${req.params.mapId}'` });
            return;
        }
        const detail = await store.loadMapDetail(mapId);
        if (!detail) { res.status(404).json({ error: `map not found: ${mapId}` }); return; }
        res.json(detail);
    });
}
```

- [ ] **Step 8: Run all dofus + scripts tests**

```bash
cd app && npx vitest run test/plugins/dofus/ && npx tsc -p tsconfig.backend.json --noEmit
```

Expected: 4 (data-store) + 6 (routes-map) + 8 (cell-flags) + 3 (cell-grid) + 5 (world-canvas) + existing dofus tests = ~30+ pass; TS clean.

- [ ] **Step 9: Commit**

```bash
git add app/plugins/dofus/lib/data-store.ts app/plugins/dofus/routes/index.ts app/test/plugins/dofus/lib/data-store.test.ts app/test/plugins/dofus/routes-map.test.ts
git commit -m "feat(dofus-map): backend data-store + 3 routes (worlds/maps-list/map-detail)"
```

---

## Task 6: Page orchestrator — `mountMap`

**Files:**
- Create: `app/plugins/dofus/pages/map.ts`
- Test: `app/test/plugins/dofus/pages/map.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/plugins/dofus/pages/map.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { mountMap } from "../../../../plugins/dofus/pages/map";
import type { PluginPageContext } from "../../../../frontend/core/plugin-types";

// happy-dom Canvas2D is missing — mock getContext globally for the page tests.
function patchCanvasMock(window: Window): void {
    const proto = (window.HTMLCanvasElement as unknown as { prototype: HTMLCanvasElement }).prototype;
    proto.getContext = function () {
        return {
            clearRect: () => undefined, fillRect: () => undefined, strokeRect: () => undefined,
            beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
            closePath: () => undefined, fill: () => undefined, stroke: () => undefined,
            fillText: () => undefined,
            fillStyle: "", strokeStyle: "", lineWidth: 0, font: "",
        } as unknown as CanvasRenderingContext2D;
    } as never;
}

const makeCtx = (): PluginPageContext => ({
    profile: { gameName: "dofus", buildId: "abc" },
    currentSubTab: "map",
    setSubTab: () => undefined,
});

describe("mountMap", () => {
    let host: HTMLElement;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        const window = new Window();
        patchCanvasMock(window);
        const document = window.document as unknown as Document;
        (globalThis as { document?: unknown }).document = document;
        host = document.createElement("div") as unknown as HTMLElement;

        fetchMock = vi.fn(async (url: string) => {
            if (url === "/api/dofus/worlds") {
                return { ok: true, json: async () => ({
                    worlds: [
                        { id: 1, name: "Amakna", mapCount: 2 },
                        { id: 10, name: "Frigost", mapCount: 1 },
                    ],
                }) } as Response;
            }
            if (url === "/api/dofus/maps/list?world=1") {
                return { ok: true, json: async () => ({
                    world: 1,
                    maps: [
                        { mapId: 100, posX: 0, posY: 0, subAreaId: 1, areaId: 0, name: "M100" },
                        { mapId: 200, posX: 1, posY: 0, subAreaId: 1, areaId: 0, name: "M200" },
                    ],
                }) } as Response;
            }
            if (url.startsWith("/api/dofus/maps/")) {
                return { ok: true, json: async () => ({
                    mapId: 100, name: "M100", posX: 0, posY: 0, subAreaId: 1, areaId: 0,
                    neighbours: [], cells: Array(560).fill([0,0,0,0,0]),
                }) } as Response;
            }
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        });
        (globalThis as { fetch?: unknown }).fetch = fetchMock;
    });

    it("populates the world dropdown from /api/dofus/worlds", async () => {
        await mountMap(host, makeCtx());
        // Wait for promises to resolve
        await new Promise((r) => setTimeout(r, 10));
        const select = host.querySelector<HTMLSelectElement>("[data-testid='world-select']")!;
        expect(select.options).toHaveLength(2);
        expect(select.options[0].textContent).toMatch(/Amakna/);
    });

    it("renders the world canvas after fetching maps for the default world", async () => {
        await mountMap(host, makeCtx());
        await new Promise((r) => setTimeout(r, 30));
        // /api/dofus/maps/list?world=1 should have been called
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/dofus/maps/list?world=1")).toBe(true);
        const canvas = host.querySelector<HTMLCanvasElement>("[data-testid='world-canvas']");
        expect(canvas).not.toBeNull();
        // Canvas dimensions set (via renderWorldCanvas)
        expect(canvas!.width).toBeGreaterThan(0);
    });

    it("clicking a tile triggers /api/dofus/maps/:mapId and renders cell-grid in the side panel", async () => {
        await mountMap(host, makeCtx());
        await new Promise((r) => setTimeout(r, 30));

        const canvas = host.querySelector<HTMLCanvasElement>("[data-testid='world-canvas']")!;
        // Simulate click at the px coords of the first map (posX=0, posY=0).
        // tileSize default 14, padding 4 → tile at px=4,py=4. Click at (8,8) lands inside.
        const rect = { left: 0, top: 0 } as DOMRect;
        canvas.getBoundingClientRect = () => rect as DOMRect;
        const evt = new (host.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true });
        Object.defineProperty(evt, "clientX", { value: 8 });
        Object.defineProperty(evt, "clientY", { value: 8 });
        canvas.dispatchEvent(evt);

        await new Promise((r) => setTimeout(r, 30));
        const detailFetch = fetchMock.mock.calls.find(([url]) => /\/api\/dofus\/maps\/\d+$/.test(String(url)));
        expect(detailFetch).toBeDefined();
        const panel = host.querySelector<HTMLElement>("[data-testid='cell-grid-panel']")!;
        expect(panel.querySelector("[data-testid='cell-grid-canvas']")).not.toBeNull();
    });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd app && npx vitest run test/plugins/dofus/pages/map.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `pages/map.ts`**

`app/plugins/dofus/pages/map.ts`:

```ts
import { renderWorldCanvas, type WorldMap, type WorldCanvasResult } from "../lib/world-canvas";
import { renderCellGrid } from "../lib/cell-grid";
import type { PluginPageContext } from "../../../frontend/core/plugin-types";

interface WorldMeta { id: number; name: string; mapCount: number }
interface MapDetail {
    mapId: number; name: string;
    posX: number; posY: number;
    subAreaId: number; areaId: number;
    neighbours: number[];
    cells: Array<[number, number, number, number, number]>;
}

// Module-level state — mirrors the existing pages pattern (instances.ts, etc.)
let currentWorld = 1;
let currentMaps: WorldMap[] = [];
let currentSelected: number | null = null;
let currentHover: number | null = null;
let currentHitTest: WorldCanvasResult | null = null;

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function mountMap(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    host.innerHTML = `
        <div style="display:flex;flex:1;min-height:0">
            <div style="flex:1;display:flex;flex-direction:column;border-right:1px solid #333;min-width:0">
                <div style="padding:8px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center">
                    <label style="font-size:12px;color:#888">World:</label>
                    <select data-testid="world-select" style="padding:4px 8px"></select>
                    <span data-testid="hover-info" style="margin-left:auto;font-size:12px;color:#888"></span>
                </div>
                <div data-testid="canvas-host" style="flex:1;overflow:auto;padding:12px;background:#0a0a0a;display:flex;justify-content:center;align-items:flex-start">
                    <canvas data-testid="world-canvas" style="image-rendering:pixelated;cursor:crosshair"></canvas>
                </div>
            </div>
            <div data-testid="cell-grid-panel" style="width:380px;padding:12px;overflow:auto">
                <p style="color:#888">Click a map to inspect.</p>
            </div>
        </div>
    `;

    const select = host.querySelector<HTMLSelectElement>("[data-testid='world-select']")!;
    const canvas = host.querySelector<HTMLCanvasElement>("[data-testid='world-canvas']")!;
    const hoverInfo = host.querySelector<HTMLSpanElement>("[data-testid='hover-info']")!;
    const panel = host.querySelector<HTMLDivElement>("[data-testid='cell-grid-panel']")!;

    // Populate worlds
    try {
        const worlds = (await (await fetch("/api/dofus/worlds")).json()) as { worlds: WorldMeta[] };
        select.innerHTML = worlds.worlds.map((w) =>
            `<option value="${w.id}" ${w.id === currentWorld ? "selected" : ""}>${escapeHtml(w.name)} (${w.mapCount})</option>`,
        ).join("");
        // Pick the FIRST world if currentWorld isn't in the list
        if (!worlds.worlds.find((w) => w.id === currentWorld) && worlds.worlds.length > 0) {
            currentWorld = worlds.worlds[0].id;
            select.value = String(currentWorld);
        }
    } catch (err) {
        panel.innerHTML = `<p style="color:#f87171">Failed to load worlds: ${escapeHtml(String(err))}</p>`;
        return;
    }

    select.addEventListener("change", () => {
        currentWorld = parseInt(select.value, 10);
        currentSelected = null;
        currentHover = null;
        panel.innerHTML = `<p style="color:#888">Click a map to inspect.</p>`;
        void loadAndRender(canvas);
    });

    canvas.addEventListener("mousemove", (e) => {
        if (!currentHitTest) return;
        const rect = canvas.getBoundingClientRect();
        const hit = currentHitTest.hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit !== currentHover) {
            currentHover = hit;
            reRender(canvas);
            const hovered = currentMaps.find((m) => m.mapId === hit);
            hoverInfo.textContent = hovered ? `(${hovered.posX}, ${hovered.posY}) ${hovered.name}` : "";
        }
    });

    canvas.addEventListener("mouseleave", () => {
        if (currentHover !== null) {
            currentHover = null;
            reRender(canvas);
            hoverInfo.textContent = "";
        }
    });

    canvas.addEventListener("click", (e) => {
        if (!currentHitTest) return;
        const rect = canvas.getBoundingClientRect();
        const hit = currentHitTest.hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit === null) return;
        currentSelected = hit;
        reRender(canvas);
        void loadCellGrid(panel, hit);
    });

    await loadAndRender(canvas);
}

async function loadAndRender(canvas: HTMLCanvasElement): Promise<void> {
    try {
        const resp = (await (await fetch(`/api/dofus/maps/list?world=${currentWorld}`)).json()) as { maps: WorldMap[] };
        currentMaps = resp.maps;
        reRender(canvas);
    } catch (err) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = "#f87171"; ctx.font = "14px sans-serif";
            ctx.fillText("Failed to load maps: " + String(err), 10, 20);
        }
    }
}

function reRender(canvas: HTMLCanvasElement): void {
    currentHitTest = renderWorldCanvas(canvas, {
        maps: currentMaps,
        selectedMapId: currentSelected,
        hoveredMapId: currentHover,
    });
}

async function loadCellGrid(panel: HTMLDivElement, mapId: number): Promise<void> {
    panel.innerHTML = `<p style="color:#888">Loading…</p>`;
    try {
        const data = (await (await fetch(`/api/dofus/maps/${mapId}`)).json()) as MapDetail;
        panel.innerHTML = `
            <h3 style="margin-top:0">${escapeHtml(data.name || `Map ${data.mapId}`)}</h3>
            <p style="color:#888;font-size:12px">(${data.posX}, ${data.posY}) — area ${data.areaId}</p>
            <canvas data-testid="cell-grid-canvas" style="image-rendering:pixelated"></canvas>
        `;
        const gridCanvas = panel.querySelector<HTMLCanvasElement>("[data-testid='cell-grid-canvas']")!;
        renderCellGrid(gridCanvas, { cells: data.cells });
    } catch (err) {
        panel.innerHTML = `<p style="color:#f87171">Failed to load: ${escapeHtml(String(err))}</p>`;
    }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
cd app && npx vitest run test/plugins/dofus/pages/map.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/pages/map.ts app/test/plugins/dofus/pages/map.test.ts
git commit -m "feat(dofus-map): mountMap orchestrator (dropdown + canvas + side panel + WS-free)"
```

---

## Task 7: Wire Map sub-tab in root.ts

**Files:**
- Modify: `app/plugins/dofus/pages/root.ts`

- [ ] **Step 1: Read current `root.ts`**

```bash
cat app/plugins/dofus/pages/root.ts
```

- [ ] **Step 2: Modify `root.ts` to delegate "map" sub-tab to `mountMap`**

In the existing root.ts (created in T8 of the plugin-system plan), find the block that renders the placeholder for the active sub-page. It looks like:

```ts
const subHost = host.querySelector<HTMLElement>("[data-testid='dofus-sub-host']")!;
subHost.innerHTML = `<p>... ${sub} sub-page (placeholder).</p>...`;
```

Replace with:

```ts
const subHost = host.querySelector<HTMLElement>("[data-testid='dofus-sub-host']")!;
if (sub === "map") {
    void import("./map").then(({ mountMap }) => mountMap(subHost, ctx));
} else {
    subHost.innerHTML = `
        <p>Dofus plugin — <strong>${sub}</strong> sub-page (placeholder).</p>
        <p>Profile: <code>${ctx.profile.gameName} / ${ctx.profile.buildId.slice(0, 8)}</code></p>
        <p style="margin-top:24px;font-style:italic">The actual ${sub} feature ships in a follow-up sub-project.</p>
    `;
}
```

The lazy import keeps map.ts (and its lib deps) in a separate vite chunk — only loaded when the user navigates to the Map tab.

- [ ] **Step 3: Run all dofus tests + frontend tests + tsc + build**

```bash
cd app && npx vitest run test/plugins/dofus/ test/frontend/ && npx tsc -p tsconfig.frontend.json --noEmit && npm run build
```

Expected: all pass; TS clean; build clean. The build output should now show TWO Dofus chunks (`root` + the lazy `map` chunk).

- [ ] **Step 4: Commit**

```bash
git add app/plugins/dofus/pages/root.ts
git commit -m "feat(dofus-map): wire map sub-tab to mountMap (lazy import)"
```

---

## Task 8: End-to-end smoke + docs polish

**Files:**
- Modify: `app/SMOKE-TEST.md`

- [ ] **Step 1: Run full suite + tsc + build**

```bash
cd app && npx vitest run && npx tsc -p tsconfig.backend.json --noEmit && npx tsc -p tsconfig.frontend.json --noEmit && npm run build
```

Expected: all tests pass (~370+); both TS configs clean; build clean.

If anything fails, REPORT IT — don't try to fix unrelated regressions.

- [ ] **Step 2: Append the v1 dofus-map smoke section to `app/SMOKE-TEST.md`**

Read the existing file to confirm format, then append:

```markdown
## v1 Dofus Plugin — Map Feature (2026-05-08)

This section is to be filled by the user during manual smoke testing on a real Dofus process.

### Setup
1. Run `cd app && npm run dofus:build-data` once (requires `.toolkit-data/datacenter/` populated — run the datacenter dump first if needed).
2. Confirm `app/plugins/dofus/data/maps/` contains ~20k JSON files and `maps-information.json` + `areas.json` were generated.
3. Start backend: `cd app && npm run dev`.
4. Open the web-app at `http://localhost:3001`.

### Smoke checklist — page load
- [ ] Click the Dofus crown icon in the nav.
- [ ] Click the "map" sub-tab. The page renders with: a dropdown labeled "World:" + a canvas area + a right side panel showing "Click a map to inspect."
- [ ] The dropdown is populated with multiple worlds (Amakna, Frigost, Otomai, etc.) — at least 5 entries each with `(N)` map counts.
- [ ] The canvas displays a tiled view of all maps in the default world (Amakna = world 1) — colored rectangles arranged at their (posX, posY) coords. Roughly ~1k tiles visible.

### Smoke checklist — interaction
- [ ] Hover a tile → the right of the toolbar shows `(x, y) name` of the hovered map. Cursor stays a crosshair.
- [ ] Move the mouse off the canvas → hover info disappears.
- [ ] Click a tile → the side panel updates with: a header (map name), coord, and an iso cell-grid 14×40 below. Cells are colored: green walkable, marron walls, yellow farm cells, etc.
- [ ] The clicked tile gets a white outline on the world canvas (selected state).

### Smoke checklist — world switch
- [ ] Change the dropdown to "Frigost" (world 10). The canvas re-renders with Frigost maps; the side panel resets to the placeholder text.
- [ ] Click a Frigost map → cell-grid renders for that map.

### Smoke checklist — backend routes (curl)
- [ ] `curl http://localhost:3001/api/dofus/worlds` → returns `{worlds:[...]}` with mapCount per world.
- [ ] `curl 'http://localhost:3001/api/dofus/maps/list?world=1'` → returns `{world:1, maps:[~1k entries]}`.
- [ ] `curl http://localhost:3001/api/dofus/maps/<knownMapId>` → returns `{mapId, name, posX, posY, neighbours, cells}` with cells.length === 560.
- [ ] `curl http://localhost:3001/api/dofus/maps/list?world=99` → returns 404 with `{error:"unknown world: 99"}`.

### Smoke checklist — error states
- [ ] If `app/plugins/dofus/data/maps-information.json` is renamed away, restart the backend, click "World:" dropdown → side panel shows "Failed to load worlds". Backend logs show `[dofus] DofusDataStore failed to load:`.
```

- [ ] **Step 3: Commit**

```bash
git add app/SMOKE-TEST.md
git commit -m "test(dofus-map): smoke checklist for v1 map feature"
```

---

## Spec coverage check

| Spec section | Covered by |
|---|---|
| Architecture (10 files + 139 MB data) | T1–T7 |
| `maps-information.json` schema + source | T1 |
| `areas.json` schema (areas/subAreas/worlds) + fallbacks | T1 |
| Per-map JSON `{mapId, n, c}` schema | T1 (copy step) + T5 (read in data-store) |
| Backend routes `/worlds`, `/maps/list`, `/maps/:mapId` | T5 |
| Mount lifecycle with `dataReady` flag | T5 (data-store + routes) |
| LRU cache (~50 maps in RAM) | T5 (`detailCache` in `DofusDataStore`) |
| Frontend `cell-flags.ts` decoder + colors | T2 |
| Frontend `cell-grid.ts` renderer | T3 |
| Frontend `world-canvas.ts` renderer + hit-test | T4 |
| Frontend `pages/map.ts` orchestrator | T6 |
| `pages/root.ts` modify (delegate to mountMap) | T7 |
| Build script `build-data.ts` | T1 |
| Tests (~22 new, target ~370) | T2 (8) + T3 (3) + T4 (5) + T5 (4 + 6) + T6 (3) = 29 (over the spec's ~22 estimate; better coverage is fine) |
| Smoke checklist | T8 |

**Note on test count:** The plan ships 29 new tests vs the spec's "~22" estimate. The extras cover finer behaviors (e.g., edge cases on `decodeCellFlags`, additional `cellColor` branches, LRU caching). Better coverage is a net positive.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-08-dofus-plugin-map-feature.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review (spec then quality) after each, fast iteration.
2. **Inline Execution** — Execute tasks in this session, batch with checkpoints for review.

Which approach?
