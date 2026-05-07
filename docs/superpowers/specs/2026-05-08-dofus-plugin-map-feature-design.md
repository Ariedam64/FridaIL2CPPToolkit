# Plugin Dofus — Map Feature (v1) — Design Spec

> Première vraie feature du plugin Dofus (le scaffolding placeholder a été livré par v1.5 Game Plugin System). World map dezoomée à gauche (toutes les maps d'un world rendues comme petits rectangles colorés à leur position), cell-grid iso 14×40 dans un panneau latéral droit quand l'user clique une map. Données 100% statiques (139 MB bundlées dans le plugin), pas de live agent pour v1.

**Date** : 2026-05-08
**Branche cible** : à brancher fresh depuis `master` (ex: `feat/v1.5-dofus-map`)
**Auteur** : brainstormé avec l'utilisateur (réponses Q1-Q4 résumées plus bas)
**Dépendances** : Game Plugin System v1.5 (mergé sur master), `src/rpc-agent/mapstate.ts` (présent sur master, utilisé en v2 pas v1)

---

## TL;DR

Le sub-tab "Map" du plugin Dofus (livré comme placeholder par v1.5 game plugin system) devient un vrai composant d'inspection du monde Dofus :

1. Dropdown en haut → sélectionne le world (default Amakna = world 1, 18 worlds dispo)
2. Canvas dezoomé centré → toutes les maps du world sélectionné rendues comme petits rectangles colorés (couleur par areaId via hash HSL)
3. Hover une tile → tooltip coord + nom
4. Click une tile → panneau latéral droit affiche le cell-grid iso 14×40 de cette map avec les couleurs par flag (vert walkable, marron wall, jaune farm, etc.)
5. Switch dropdown world → re-render canvas + reset panneau

Pas de zoom, pas de pan, pas d'atlas tile PNGs, pas de live agent, pas d'interactives. Juste le world view + cell-grid statique.

**Out of scope v1** : player position marker (live), atlas tiles, interactives, neighbours nav, recherche, bookmarks, multi-world overlay, pan/zoom.

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| Q1 | Type de mini-map | **Custom (user)** — world complet dezoomé sans zoom, click sur map → cell-grid (cases statiques) |
| Q2 | Data sourcing | **A — Bundlées dans le plugin** (`app/plugins/dofus/data/`, 139 MB committed) |
| Q3 | World scope | **A — Dropdown world, default world 1** (Amakna) |
| Q4 | Click layout | **A — Panneau latéral droit** (canvas reste visible, tile cliquée highlight) |

---

## Architecture

8 fichiers nouveaux + 2 modifiés + 139 MB de data bundled.

| Fichier | Rôle |
|---|---|
| `app/plugins/dofus/data/maps/<mapId>.json` (~20k fichiers, 139 MB) | Per-map cell data, copié depuis `dofus-app/data/maps/` (`feat/dofus-app` branch) |
| `app/plugins/dofus/data/maps-information.json` (~5 MB) | Index extrait de `MapsInformationDataRoot.json` (DataCenter dump) — `[{mapId, posX, posY, subAreaId, worldMap, nameId, name}]` |
| `app/plugins/dofus/data/areas.json` (<100 KB) | Lookup subAreaId → areaId → name + worldId → name (fallback hardcoded pour les 18 worlds) |
| `app/plugins/dofus/scripts/build-data.ts` | Script one-shot qui prépare `maps-information.json` + `areas.json` à partir de `.toolkit-data/datacenter/*` (run manuellement, pas par `npm run build`) |
| `app/plugins/dofus/lib/cell-flags.ts` | `decodeCellFlags(n)` + `cellColor(flags, mcd)` — porté de `dofus-app/public/panels/world.ts` |
| `app/plugins/dofus/lib/cell-grid.ts` | `renderCellGrid(canvas, opts)` — pure Canvas2D renderer iso 14×40 |
| `app/plugins/dofus/lib/world-canvas.ts` | `renderWorldCanvas(canvas, opts) → { hitTest }` — pure Canvas2D renderer + hit-test |
| `app/plugins/dofus/pages/map.ts` | Composant orchestrateur : `mountMap(host, ctx)` — dropdown + canvas + side panel + fetch wiring |
| `app/plugins/dofus/pages/root.ts` (modifié) | Le sub-tab "map" délègue à `mountMap` au lieu du placeholder |
| `app/plugins/dofus/routes/index.ts` (modifié) | Ajoute 3 routes : `/api/dofus/worlds`, `/api/dofus/maps/list`, `/api/dofus/maps/:mapId` |

Pas d'agent Frida modifié. `src/rpc-agent/mapstate.ts` existe déjà sur master mais n'est pas utilisé pour v1 (v2 ajoutera le player marker).

---

## Data model

### `maps-information.json`

```ts
interface MapInfoEntry {
    mapId: number;        // unique
    posX: number;         // world coord, can be negative (e.g. -85)
    posY: number;
    subAreaId: number;
    worldMap: number;     // -1 (caves), 1 (Amakna), 10, 12, ... (18 worlds)
    nameId: number;       // i18n key (kept for future)
    name: string;         // resolved display name (FR)
}

type MapsInformationFile = MapInfoEntry[];
```

Source : `MapsInformationDataRoot.json` extrait du DataCenter (chemin `.toolkit-data/datacenter/MapsInformationDataRoot.json`). Le script de prep `build-data.ts` filtre les champs et résout `name` via la table i18n du datacenter.

### `areas.json`

```ts
interface AreasFile {
    areas: Record<number, { id: number; name: string }>;       // areaId → name
    subAreas: Record<number, { id: number; areaId: number; name: string }>;
    worlds: Record<number, { id: number; name: string }>;      // worldMap → display name
}
```

Source : `AreasDataRoot.json` + `SubAreasDataRoot.json` du DataCenter (présence à vérifier dans `.toolkit-data/datacenter/` — fallback prévu si absent).

`worlds` est partiellement hardcodé pour les 18 worlds connus si la table runtime n'existe pas :
```json
{ "1": { "name": "Amakna" }, "10": { "name": "Frigost" }, "-1": { "name": "Caves" }, ... }
```

### Per-map JSON (`maps/<mapId>.json`)

Schema déjà existant dans `dofus-app/data/maps/`, on le sert tel quel :

```ts
interface MapData {
    mapId: number;
    n?: [number, number, number, number];            // neighbours [N, E, S, W] mapIds
    a?: unknown[];                                    // (kept for future, unused v1)
    ie?: Array<[number, number, number]>;             // interactives (kept for future)
    c: Array<[number, number, number, number, number]>;  // 560 cells: [flags, mcd, _, _, _]
    updatedAt?: string;
}
```

`c.length === 14 * 40 === 560` en row-major.

---

## Backend routes

3 nouvelles routes dans `app/plugins/dofus/routes/index.ts`. Préfixées `/api/dofus/...` (convention du plugin system v1.5).

### Mount lifecycle

```ts
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

// app/ is "type": "module" — derive __dirname via import.meta.url
const _MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function mount(app: Express, deps: PluginBackendDeps): void {
    const dataDir = path.resolve(_MODULE_DIR, "../data");
    let mapsIndex: MapInfoEntry[] = [];
    let areasIndex: AreasFile = { areas: {}, subAreas: {}, worlds: {} };
    let worldsIndex: Array<{ id: number; name: string; mapCount: number }> = [];
    let dataReady = false;

    try {
        mapsIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "maps-information.json"), "utf8"));
        areasIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "areas.json"), "utf8"));
        worldsIndex = computeWorldsIndex(mapsIndex, areasIndex);
        dataReady = true;
    } catch (err) {
        console.error("[dofus] static map data not loaded:", (err as Error).message);
        // Routes still mounted but return 503 until dataReady.
    }

    // Existing v1.5 route
    app.get("/api/dofus/map/current", /* ... unchanged ... */);

    // New v1 map feature routes
    app.get("/api/dofus/worlds", (req, res) => { /* ... see below ... */ });
    app.get("/api/dofus/maps/list", (req, res) => { /* ... */ });
    app.get("/api/dofus/maps/:mapId", (req, res) => { /* ... */ });
}
```

### `GET /api/dofus/worlds`

Returns the worlds available in the bundled data, with map counts.

```jsonc
{
    "worlds": [
        { "id": 1,  "name": "Amakna",     "mapCount": 1247 },
        { "id": 10, "name": "Frigost",    "mapCount": 234 },
        { "id": -1, "name": "Caves",      "mapCount": 412 }
        // ...
    ]
}
```

503 if `dataReady === false`.

### `GET /api/dofus/maps/list?world=<N>`

All maps in a single world. Used by the canvas renderer.

Query params:
- `world` (required) — integer, must match a known worldMap

Response:
```jsonc
{
    "world": 1,
    "maps": [
        { "mapId": 153356288, "posX": 0, "posY": -1, "subAreaId": 86, "areaId": 0, "name": "..." }
        // ... ~1k maps
    ]
}
```

`areaId` is enriched from `areasIndex.subAreas[subAreaId].areaId` (falls back to subAreaId itself if missing).

Errors:
- 400 if `world` missing or not a number
- 404 if `world` is a number but not in `worldsIndex` (returns `{ error: "unknown world: <N>" }`)
- 503 if data not ready

### `GET /api/dofus/maps/:mapId`

Full cell data for one map. Used when user clicks a tile.

Response:
```jsonc
{
    "mapId": 153356288,
    "posX": 0, "posY": -1, "subAreaId": 86, "areaId": 0, "name": "...",
    "neighbours": [88212248, 88212246, 88212759, 88080663],
    "cells": [[35,0,160,0,17], ...]   // 560 entries
}
```

Implementation:
1. Lookup `mapsIndex.find(m => m.mapId === id)` for metadata
2. Read `maps/<mapId>.json` from disk
3. LRU cache (~50 entries) keyed by mapId — backed by a `Map` with insertion-order eviction

Errors:
- 400 if `:mapId` not a valid integer
- 404 if mapId not in `mapsIndex` OR file `maps/<id>.json` missing
- 503 if data not ready

---

## Frontend — `app/plugins/dofus/lib/cell-flags.ts`

Bitfield decoder + color picker. Ported from `dofus-app/public/panels/world.ts:54-72`. Pure functions, no DOM.

```ts
export interface CellFlags {
    mov: boolean; los: boolean; nonRP: boolean;
    farm: boolean; visible: boolean; havenbag: boolean;
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

---

## Frontend — `app/plugins/dofus/lib/cell-grid.ts`

Pure Canvas2D renderer. No event handlers, no DOM ownership. Caller passes the canvas + the cells array.

```ts
import { cellColor } from "./cell-flags";

export interface CellGridOpts {
    cells: Array<[number, number, number, number, number]>;
    cellSize?: number;   // default 16 → ~580×640 canvas
}

const COLS = 14;
const ROWS = 40;

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

---

## Frontend — `app/plugins/dofus/lib/world-canvas.ts`

Pure Canvas2D world renderer with hit-detection. Returns a `{ hitTest }` object the caller wires to mouse events.

```ts
export interface WorldMap {
    mapId: number; posX: number; posY: number;
    subAreaId: number; areaId: number; name: string;
}

export interface WorldCanvasOpts {
    maps: WorldMap[];
    selectedMapId?: number | null;
    hoveredMapId?: number | null;
    tileSize?: number;   // default 14
}

export interface WorldCanvasResult {
    hitTest(px: number, py: number): number | null;
}

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

---

## Frontend — `app/plugins/dofus/pages/map.ts`

Composant orchestrateur. ~120 LOC. State minimal en module-scope (pattern existant dans le toolkit), fetch via `api.*` du frontend.

```ts
import { renderWorldCanvas, type WorldMap, type WorldCanvasResult } from "../lib/world-canvas";
import { renderCellGrid } from "../lib/cell-grid";
import type { PluginPageContext } from "../../../frontend/core/plugin-types";

interface WorldMeta { id: number; name: string; mapCount: number }
interface MapDetail {
    mapId: number; name: string; posX: number; posY: number; subAreaId: number; areaId: number;
    neighbours: number[];
    cells: Array<[number, number, number, number, number]>;
}

let currentWorld = 1;
let currentMaps: WorldMap[] = [];
let currentSelected: number | null = null;
let currentHover: number | null = null;
let currentHitTest: WorldCanvasResult | null = null;

export async function mountMap(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    host.innerHTML = `
        <div style="display:flex;flex:1;min-height:0">
            <div style="flex:1;display:flex;flex-direction:column;border-right:1px solid #333">
                <div style="padding:8px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center">
                    <label style="font-size:12px;color:#888">World:</label>
                    <select data-testid="world-select" style="padding:4px 8px"></select>
                    <span data-testid="hover-info" style="margin-left:auto;font-size:12px;color:#888"></span>
                </div>
                <div style="flex:1;overflow:auto;padding:12px;background:#0a0a0a;display:flex;justify-content:center;align-items:flex-start">
                    <canvas data-testid="world-canvas" style="image-rendering:pixelated"></canvas>
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

    // Populate worlds dropdown
    try {
        const worlds = await fetch("/api/dofus/worlds").then(r => r.json()) as { worlds: WorldMeta[] };
        select.innerHTML = worlds.worlds.map(w =>
            `<option value="${w.id}" ${w.id === currentWorld ? "selected" : ""}>${escapeHtml(w.name)} (${w.mapCount})</option>`
        ).join("");
    } catch (err) {
        select.innerHTML = `<option value="1">Amakna</option>`;
        panel.innerHTML = `<p style="color:#f87171">Failed to load worlds: ${escapeHtml(String(err))}</p>`;
        return;
    }

    select.addEventListener("change", () => {
        currentWorld = parseInt(select.value, 10);
        currentSelected = null; currentHover = null;
        panel.innerHTML = `<p style="color:#888">Click a map to inspect.</p>`;
        void loadAndRender(canvas);
    });

    canvas.addEventListener("mousemove", (e) => {
        if (!currentHitTest) return;
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const hit = currentHitTest.hitTest(px, py);
        if (hit !== currentHover) {
            currentHover = hit;
            re_render(canvas);
            const hovered = currentMaps.find(m => m.mapId === hit);
            hoverInfo.textContent = hovered ? `(${hovered.posX}, ${hovered.posY}) ${hovered.name}` : "";
        }
    });

    canvas.addEventListener("click", (e) => {
        if (!currentHitTest) return;
        const rect = canvas.getBoundingClientRect();
        const hit = currentHitTest.hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit === null) return;
        currentSelected = hit;
        re_render(canvas);
        void loadCellGrid(panel, hit);
    });

    await loadAndRender(canvas);
}

async function loadAndRender(canvas: HTMLCanvasElement): Promise<void> {
    try {
        const resp = await fetch(`/api/dofus/maps/list?world=${currentWorld}`).then(r => r.json());
        currentMaps = resp.maps;
        re_render(canvas);
    } catch (err) {
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#f87171"; ctx.font = "14px sans-serif";
        ctx.fillText("Failed to load maps: " + String(err), 10, 20);
    }
}

function re_render(canvas: HTMLCanvasElement): void {
    currentHitTest = renderWorldCanvas(canvas, {
        maps: currentMaps,
        selectedMapId: currentSelected,
        hoveredMapId: currentHover,
    });
}

async function loadCellGrid(panel: HTMLDivElement, mapId: number): Promise<void> {
    panel.innerHTML = `<p style="color:#888">Loading…</p>`;
    try {
        const data = await fetch(`/api/dofus/maps/${mapId}`).then(r => r.json()) as MapDetail;
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

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
```

---

## Modification — `app/plugins/dofus/pages/root.ts`

Le sub-tab "map" du root page délègue à `mountMap` au lieu d'afficher le placeholder. Reste identique pour "items" et "state" (placeholders).

```ts
// Inside the existing root.ts mount():
const subHost = host.querySelector<HTMLElement>("[data-testid='dofus-sub-host']")!;
if (sub === "map") {
    void import("./map").then(({ mountMap }) => mountMap(subHost, ctx));
} else {
    subHost.innerHTML = `<p style="color:#888">Dofus plugin — <strong>${sub}</strong> sub-page (placeholder).</p>...`;
}
```

Lazy-import keeps the world-canvas + cell-grid code out of the initial Dofus page bundle until the user actually navigates to Map.

---

## Build script — `app/plugins/dofus/scripts/build-data.ts`

One-shot Node script run manually (`npm run dofus:build-data`) — pas par `npm run build` standard parce que ça dépend de `.toolkit-data/datacenter/` qui est local au dev.

Inputs (required, all under `.toolkit-data/datacenter/`) :
- `MapsInformationDataRoot.json`
- `AreasDataRoot.json` (fallback : empty)
- `SubAreasDataRoot.json` (fallback : empty)
- `WorldMapsDataRoot.json` (fallback : hardcoded 18 worlds)

Outputs (in `app/plugins/dofus/data/`) :
- `maps-information.json`
- `areas.json`

Le script ne touche PAS `maps/<mapId>.json` — ces fichiers sont copiés une fois depuis `dofus-app/data/maps/` (manuel ou via un autre script `dofus:copy-maps`).

Failure modes :
- Datacenter dump introuvable → exit 1 avec message clair "run datacenter dump first (see dofus-app/scripts/dump-datacenter.js)"
- Données vides ou structure inattendue → warn + best-effort

---

## Tests

Stratégie TDD vitest, ~22 nouveaux tests. Cible : **~370 verts** (348 baseline + 22 nouveaux).

### `app/test/plugins/dofus/lib/cell-flags.test.ts` (5)

- ✓ `decodeCellFlags(0b1100001)` → mov + los + havenbag
- ✓ `decodeCellFlags(0)` → all false
- ✓ `cellColor(0b100001, 0)` → walkable visible mov → `#3a7b3a`
- ✓ `cellColor(0b100000, 0)` → wall visible no mov no los → `#2a2520`
- ✓ `cellColor(0b110001, 0)` → farm walkable → `#d9b02c`

### `app/test/plugins/dofus/lib/cell-grid.test.ts` (3)

- ✓ Renders 14×40 cells onto a happy-dom canvas (verifies `fillRect`/`fill` call counts via mock 2d ctx)
- ✓ Empty cells array doesn't crash, canvas dims still set
- ✓ Custom cellSize=24 produces canvas width 348 (= 14.5 × 24)

### `app/test/plugins/dofus/lib/world-canvas.test.ts` (5)

- ✓ Empty maps → "No maps in this world" message + null `hitTest`
- ✓ Bbox computed correctly from negative + positive coords (e.g., `[-2, 1, 3]` x's → minX=-2, maxX=3, width=6)
- ✓ `hitTest(px, py)` returns the right mapId for a tile at known pixel coords
- ✓ `hitTest` returns null for empty space (between tiles in the bounding box)
- ✓ `selectedMapId` produces a white outline (verifies `strokeRect` called with `#fff`)

### `app/test/plugins/dofus/routes-map.test.ts` (6)

Uses supertest + a temp fixture data dir (`{ maps: [3 fake maps], areas: [1 area] }`) via `mount(app, deps)` with `__dirname` rebased.

- ✓ `GET /api/dofus/worlds` returns the worlds with mapCount
- ✓ `GET /api/dofus/maps/list?world=1` returns the maps for world 1
- ✓ `GET /api/dofus/maps/list` (no world param) → 400
- ✓ `GET /api/dofus/maps/list?world=99` (unknown world) → 404
- ✓ `GET /api/dofus/maps/:mapId` returns cells + neighbours when file exists
- ✓ `GET /api/dofus/maps/:mapId` → 404 when mapId not in index OR file missing

### `app/test/plugins/dofus/pages/map.test.ts` (3)

happy-dom + mock fetch. The test rewires `globalThis.fetch` per test.

- ✓ `mountMap` populates the world dropdown from `/api/dofus/worlds`
- ✓ Changing the dropdown triggers `/api/dofus/maps/list?world=X` and re-renders the canvas
- ✓ Click on canvas → fetches `/api/dofus/maps/:mapId` → renders cell-grid in the side panel

### Smoke (manuel, T-final)

- Lance toolkit → attache à Dofus → click icône Dofus → sub-tab Map
- Dropdown affiche "Amakna" par défaut
- Canvas affiche ~1k tiles colorées (couleurs distinctes par area)
- Hover une tile → tooltip "(x, y) name" en haut à droite
- Click une tile → side panel affiche cell-grid avec couleurs flag (vert walkable, marron wall, jaune farm)
- Switch dropdown vers "Frigost" → re-render canvas, panneau reset
- Click une map de Frigost → cell-grid de cette map dans le panneau

---

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| 139 MB committed = `git clone` lent + repo size hit | Acceptable pour single-user dev tool ; documenté dans le README plugin. Si pénible, switch vers script d'install (option B du brainstorm) plus tard. |
| `MapsInformationDataRoot.json` absent (le dev n'a jamais run le datacenter dump) | `build-data.ts` exit 1 avec message clair. Plugin se mount quand même mais routes 503. UI affiche "Failed to load worlds". |
| Areas/SubAreas tables manquantes dans DataCenter | Fallback : utiliser `subAreaId % 360` pour la teinte (perd le mapping subArea→area mais garde des couleurs distinctives) |
| World names manquants | Hardcodé fallback dans `areas.json` pour les 18 worlds connus |
| Cell-grid renderer iso math fausse visuellement | Comparaison visuelle smoke vs `dofus-app/public/panels/world.ts` ; tests unitaires vérifient les pixel-coords clés |
| `tileSize=14` trop petit/gros selon densité du world | Configurable au top du composant (constant) ; YAGNI un slider en v1.x |
| Click hit-detection rate aux bords | `hitTest` utilise `Math.floor` déterministe, testé avec edge cases (négatif, hors bounds) |
| Backend lit 1 fichier JSON par click → I/O à chaque clic | LRU cache 50 maps en RAM (~1 MB). Acceptable pour dev tool. |
| 1k+ tiles paint à chaque world change → perf | Single-pass paint, pas de re-paint sur hover (re-render full canvas mais c'est en quelques ms). À mesurer pendant smoke ; si lag, extraire un overlay-canvas dédié pour hover/select. |

---

## Out of scope v1 (sub-projects suivants)

- **Player position marker** (live agent via `mapstate.getCurrentMapId()`)
- **Atlas tile PNGs** (les tiles graphiques du world.ts original)
- **Interactives + resources** sur les cell-grids
- **Liste des maps voisines clickables** dans le panneau side
- **Recherche par coord/nom** (Quick Pick filter)
- **Bookmarks de maps favorites** (réutiliser annotations existantes)
- **Pan/zoom du canvas** (explicitement exclu par décision user)
- **Multi-world overlay** (explicitement exclu)
- **Click sur cell** dans le panneau → détails (flags, interactives)
- **Cross-world links** (zaaps, dimension portals)

---

## Critères d'acceptation v1

- ✅ ~370 tests verts (348 baseline + 22 nouveaux)
- ✅ Build vite + tsc clean (avec OU sans les 139 MB de data — si data absent, plugin mount avec routes 503)
- ✅ `npm run dofus:build-data` produit `maps-information.json` + `areas.json` correctement à partir du datacenter dump
- ✅ Sub-tab Map (au lieu du placeholder) — affiche dropdown + canvas + side panel
- ✅ Default world (Amakna = world 1) charge ~1k tiles colorées par area
- ✅ Hover une tile → tooltip coord + nom
- ✅ Click une tile → cell-grid 14×40 dans le panneau side avec couleurs flag correctes (wall marron, walkable vert, farm jaune)
- ✅ Switch world dans dropdown → re-render canvas + reset panneau side
- ✅ Backend routes `/api/dofus/worlds`, `/api/dofus/maps/list?world=N`, `/api/dofus/maps/:mapId` reachable + statut codes corrects (200/400/404/503)
- ✅ Smoke manuel sur Dofus : flow complet world → click → cell-grid affichable
