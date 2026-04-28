// World map panel — explorable canvas of the Dofus world.
// Click a tile → details + preview. EXTRACT pulls fresh catalogs from
// the live game. Per-map cross-fade previews lazy-load over the atlas
// tiles when zoomed in (PREVIEW_MIN_PX). Dedup at each (posX, posY)
// uses content-based canonical-coords if available, else first-match.

import { logRpcLine } from "./logs.js";

interface MapEntry { id: number; posX: number; posY: number; subAreaId: number; worldMap: number; nameId: number; name: string; }
interface SubArea { id: number; areaId: number; name: string; level?: number; }
interface Area { id: number; name: string; }
interface WorldMapDims {
    id: number; name: string;
    origineX: number; origineY: number;
    mapWidth: number; mapHeight: number;
    totalWidth: number; totalHeight: number;
}
interface Catalogs {
    maps: MapEntry[];
    subareas: Map<number, SubArea>;
    areas: Map<number, Area>;
    worldmaps: Map<number, WorldMapDims>;
}
interface MapData {
    mapId: number;
    n?: [number, number, number, number];
    ie?: Array<[number, number, number]>;
    c?: Array<[number, number, number, number, number]>;
    updatedAt?: string;
    interactives?: Array<{ elementId: string; cell: number; typeId: number; name: string }>;
}
interface MappedTile { index: number; name: string; scale?: string; address?: string; guid?: string; width: number; height: number; tile: string | null; ambiguous: boolean; }
interface ResourceEntry {
    typeId: number; name: string; sampleGfxId: number; sampleIconId: number;
    isResource: boolean; jobName: string; levelMin: number;
    itemName: string; itemTypeName: string; count: number; mapCount: number;
}


function areaColor(areaId: number): string {
    const h = (areaId * 137) % 360;
    return `hsl(${h}, 55%, 45%)`;
}

// Real Dofus render geometry — preview PNGs are 1204×860 with 14×40 cells.
// CELL_OX/CELL_OY are the FALLBACK offsets used when no per-map data exists
// in cell-offsets.json. Computed as the median across all 9331 maps with
// interactives (build-cell-offsets.py) — works for the typical resource/tree
// case where sprite pivots sit at ~75 px above the cell ground.
const GRID_COLS = 14, CELL_W = 86, CELL_H = 43;
const PREVIEW_W = 1204;
const PREVIEW_H = 860;
const CELL_OX_DEFAULT = -21.5;
const CELL_OY_DEFAULT = -75.2;
let cellOffsetsByMap: Record<string, [number, number]> | null = null;

// Cell flags bitfield (see extract-mapdata-bundles.py):
//   bit 0 mov, 1 los, 2 nonWalkableDuringFight, 3 nonWalkableDuringRP,
//   4 farmCell, 5 visible, 6 havenbagCell.
function cellColor(flags: number, mcd: number): string | null {
    if (!((flags >> 5) & 1)) return null;
    const mov = flags & 1;
    const los = (flags >> 1) & 1;
    const nrp = (flags >> 3) & 1;
    const farm = (flags >> 4) & 1;
    const hb = (flags >> 6) & 1;
    if (!mov) return los ? "#4a4030" : "#2a2520";
    if (nrp) return null;
    if (mcd) return "#ff9d00";
    if (farm) return "#d9b02c";
    if (hb) return "#3cd";
    return "#3a7b3a";
}

// Renders the iso cell grid onto a transparent canvas. The canvas can be sized
// larger than the slot (e.g. matching the v1 PNG's natural dims) so cells that
// extend beyond the slot edges (row 0 sits ~52 px above slot top by Dofus iso
// convention) aren't clipped by the canvas dimensions.
//
// `canvasW`/`canvasH`: native canvas size (= image natural dims when overlaid).
// `slotOffsetX`/`slotOffsetY`: where slot top-left sits inside the canvas.
// Pass `overOverlay=true` for translucent overlay (alpha=0.45), false for
// solid stand-alone display (alpha=1, dark background fill).
function renderCellGrid(
    cells: Array<[number, number, number, number, number]>,
    canvas: HTMLCanvasElement,
    hlCells: Set<number> | null,
    overOverlay: boolean,
    canvasW: number = PREVIEW_W,
    canvasH: number = PREVIEW_H,
    slotOffsetX: number = 0,
    slotOffsetY: number = 0,
    cellOX: number = CELL_OX_DEFAULT,
    cellOY: number = CELL_OY_DEFAULT,
): void {
    canvas.width = canvasW; canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvasW, canvasH);
    if (!overOverlay) { ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, canvasW, canvasH); }
    ctx.globalAlpha = overOverlay ? 0.45 : 1;
    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i] || [0, 0, 0, 0, 0];
        const flags = cell[0] | 0, mcd = cell[2] | 0;
        const col = i % GRID_COLS;
        const row = Math.floor(i / GRID_COLS);
        const cx = col * CELL_W + (row % 2) * (CELL_W / 2) + CELL_W / 2 + cellOX + slotOffsetX;
        const cy = row * (CELL_H / 2) + CELL_H / 2 + cellOY + slotOffsetY;
        const highlighted = hlCells?.has(i);
        const base = cellColor(flags, mcd);
        if (!base && !highlighted) continue;
        ctx.fillStyle = highlighted ? "#6cf" : base!;
        ctx.beginPath();
        ctx.moveTo(cx, cy - CELL_H / 2);
        ctx.lineTo(cx + CELL_W / 2, cy);
        ctx.lineTo(cx, cy + CELL_H / 2);
        ctx.lineTo(cx - CELL_W / 2, cy);
        ctx.closePath();
        ctx.fill();
        if (highlighted) {
            ctx.globalAlpha = overOverlay ? 0.9 : 1;
            ctx.strokeStyle = "#fff"; ctx.lineWidth = overOverlay ? 1.5 : 1; ctx.stroke();
            ctx.globalAlpha = overOverlay ? 0.45 : 1;
        }
    }
    ctx.globalAlpha = 1;
}

async function loadCatalog(slug: string): Promise<any> {
    const res = await fetch(`/api/catalog/${slug}`);
    if (!res.ok) return null;
    return res.json();
}

async function loadAllCatalogs(): Promise<Catalogs | null> {
    const [maps, subareas, areas, worldmaps] = await Promise.all([
        loadCatalog("maps"),
        loadCatalog("subareas"),
        loadCatalog("areas"),
        loadCatalog("worldmaps"),
    ]);
    if (!maps || !subareas || !areas) return null;
    const saMap = new Map<number, SubArea>();
    for (const s of subareas.items) saMap.set(s.id, s);
    const aMap = new Map<number, Area>();
    for (const a of areas.items) aMap.set(a.id, a);
    const wmMap = new Map<number, WorldMapDims>();
    if (worldmaps) for (const w of worldmaps.items) wmMap.set(w.id, w);
    return { maps: maps.items, subareas: saMap, areas: aMap, worldmaps: wmMap };
}

async function loadTileMapping(): Promise<Record<string, MappedTile[]> | null> {
    try {
        const r = await fetch(`/api/tile-mapping`);
        if (!r.ok) return null;
        return r.json();
    } catch { return null; }
}

async function loadMapData(mapId: number): Promise<MapData | null> {
    const res = await fetch(`/api/maps/${mapId}`);
    if (!res.ok) return null;
    return res.json();
}

async function loadResources(): Promise<ResourceEntry[]> {
    try {
        const r = await fetch(`/api/resources`);
        if (!r.ok) return [];
        const j = await r.json();
        return (j.items || []) as ResourceEntry[];
    } catch { return []; }
}
async function loadResourceMaps(typeId: number): Promise<Array<[number, number]>> {
    try {
        const r = await fetch(`/api/resource-maps/${typeId}`);
        if (!r.ok) return [];
        const j = await r.json();
        if (Array.isArray(j) && j.length && typeof j[0] === "number") {
            return (j as number[]).map(id => [id, 1] as [number, number]);
        }
        return j as Array<[number, number]>;
    } catch { return []; }
}

function resourceIcon(r: ResourceEntry): string {
    if (r.isResource && r.sampleIconId > 0) return `/icons/items/${r.sampleIconId}.png`;
    return `/sprite/${r.sampleGfxId}.png`;
}

async function loadPreviewIds(): Promise<Set<number>> {
    try {
        const res = await fetch(`/api/map-previews`);
        if (!res.ok) return new Set();
        const ids = await res.json();
        return new Set(ids);
    } catch { return new Set(); }
}

// HTMLImageElement cache for atlas tiles — avoids re-decoding the same
// JPEG every time we redraw the atlas (zoom/pan triggers a redraw).
const tileImageCache = new Map<string, HTMLImageElement>();
function loadTileImage(url: string): Promise<HTMLImageElement> {
    const cached = tileImageCache.get(url);
    if (cached && cached.complete && cached.naturalWidth > 0) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { tileImageCache.set(url, img); resolve(img); };
        img.onerror = (e) => reject(e);
        img.src = url;
    });
}


export async function renderWorld(container: HTMLElement): Promise<void> {
    container.innerHTML = `
      <div style="display:flex; height:100%; min-height:600px">
        <div id="wm-side" style="width:300px; border-right:1px solid #333; padding:var(--s-3); overflow:auto; display:flex; flex-direction:column; gap:var(--s-3)">
          <div style="display:flex; gap:var(--s-2)">
            <button id="wm-reload" class="btn" title="reload from disk">↻</button>
            <span style="font-size:10px; color:var(--c-label); align-self:center">extract catalogs + run coverage in the Coverage tab</span>
          </div>
          <div style="font-size:11px; color:var(--c-label)"><span id="wm-stats">loading…</span></div>
          <label style="font-size:11px; color:var(--c-label)">world map
            <select id="wm-wm" style="background:#111; color:#fff; border:1px solid #333; padding:2px; font-family:var(--font-mono); margin-left:var(--s-2)"></select>
          </label>
          <label style="font-size:11px; color:var(--c-label)">show map
            <div style="display:flex; gap:4px; margin-top:var(--s-1)">
              <input id="wm-jump" type="text" placeholder="x, y  (e.g. 4, -19)" style="flex:1; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px">
              <button id="wm-jump-btn" class="btn">SHOW</button>
            </div>
          </label>
          <hr style="border-color:#333; width:100%">
          <div id="wm-preview-wrap" style="display:none; position:relative; width:100%; max-width:300px; aspect-ratio:1204/860; border:1px solid #222; background:#000; cursor:zoom-in; overflow:hidden">
            <img id="wm-preview" style="position:absolute; inset:0; width:100%; height:100%" alt="map preview">
            <!-- Canvas position is computed in JS after the image loads, since v1 PNGs have variable native sizes (2080×1107, 2800×1800, etc.) and the 1204×860 slot is centered inside. -->
            <canvas id="wm-cell-canvas" style="position:absolute; image-rendering:auto; pointer-events:none"></canvas>
          </div>
          <div id="wm-preview-hint" style="display:none; font-size:10px; color:var(--c-label)">no preview</div>
          <label style="display:none; font-size:10px; color:var(--c-label); user-select:none" id="wm-cells-toggle-wrap">
            <input id="wm-cells-toggle" type="checkbox" checked> show cell overlay
          </label>
          <div id="wm-cell-legend" style="display:none; font-size:10px; color:var(--c-label); line-height:1.6"></div>
          <div id="wm-detail" style="font-family:var(--font-mono); font-size:11px; white-space:pre-wrap; color:var(--c-label)">click a tile to inspect</div>
        </div>
        <div id="wm-canvas-wrap" style="flex:1; overflow:hidden; background:#0a0a0a; position:relative; user-select:none">
          <canvas id="wm-canvas" style="display:block; position:absolute; top:0; left:0; transform-origin:0 0"></canvas>
          <canvas id="wm-overlay" style="display:none; position:absolute; top:0; left:0; pointer-events:none; image-rendering:auto; z-index:5"></canvas>
          <!-- Resource picker: floating top bar. Picks a resource → bubbles drawn on each
               map containing it, count inside. Pointer-events:none on the wrapper so the
               bar doesn't block canvas clicks; re-enabled per inner element. -->
          <div id="wm-rs-bar" style="position:absolute; top:8px; left:8px; right:8px; max-width:600px; z-index:6; pointer-events:none; display:flex; flex-direction:column; gap:4px">
            <div style="pointer-events:auto; background:rgba(10,10,10,0.92); border:1px solid #333; border-radius:4px; padding:6px; display:flex; gap:6px; align-items:center">
              <!-- Surface/underground toggle: only shown if wm=-1 has maps. Switches wm=1 ↔ wm=-1.
                   The bubble overlay auto-refilters on the new wm. -->
              <div id="wm-layer-toggle" style="display:none; border:1px solid #333; border-radius:3px; overflow:hidden; flex-shrink:0">
                <button id="wm-layer-surface" class="btn" data-wm="1" style="border:none; border-radius:0; padding:4px 8px; font-size:11px">Surface</button><button id="wm-layer-under" class="btn" data-wm="-1" style="border:none; border-radius:0; border-left:1px solid #333; padding:4px 8px; font-size:11px">Souterrain</button>
              </div>
              <input id="wm-rs-input" type="text" placeholder="ressource… (frêne, sel, fer, blé…)" autocomplete="off" style="flex:1; min-width:120px; padding:4px 6px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:12px">
              <span id="wm-rs-active" style="display:none; padding:2px 6px; background:#1a1410; border:1px solid #5a4a20; color:#ffc940; font-family:var(--font-mono); font-size:11px; border-radius:3px; white-space:nowrap"></span>
              <button id="wm-rs-clear" class="btn" style="display:none">×</button>
            </div>
            <div id="wm-rs-dropdown" style="display:none; pointer-events:auto; background:rgba(10,10,10,0.96); border:1px solid #333; border-radius:4px; max-height:340px; overflow:auto"></div>
          </div>
          <div id="wm-hover-label" style="display:none; position:absolute; pointer-events:none; font-family:var(--font-mono); font-size:11px; color:#fff; background:rgba(0,0,0,0.85); padding:3px 6px; border-radius:3px; border:1px solid #555; transform:translate(12px, 12px); z-index:10"></div>
          <div id="wm-hint" style="position:absolute; right:8px; bottom:8px; font-size:10px; color:var(--c-label); background:rgba(0,0,0,0.5); padding:2px 6px; border-radius:3px; pointer-events:none">scroll = zoom · space + drag = pan</div>
        </div>
      </div>
    `;

    const side       = container.querySelector<HTMLDivElement>("#wm-side")!;
    const statsEl    = side.querySelector<HTMLSpanElement>("#wm-stats")!;
    const wmSelect   = side.querySelector<HTMLSelectElement>("#wm-wm")!;
    const jumpEl     = side.querySelector<HTMLInputElement>("#wm-jump")!;
    const jumpBtn    = side.querySelector<HTMLButtonElement>("#wm-jump-btn")!;
    const detail     = side.querySelector<HTMLDivElement>("#wm-detail")!;
    const previewWrap= side.querySelector<HTMLDivElement>("#wm-preview-wrap")!;
    const previewImg = side.querySelector<HTMLImageElement>("#wm-preview")!;
    const previewHint= side.querySelector<HTMLDivElement>("#wm-preview-hint")!;
    const cellCanvas = side.querySelector<HTMLCanvasElement>("#wm-cell-canvas")!;
    const cellLegend = side.querySelector<HTMLDivElement>("#wm-cell-legend")!;
    const cellsToggle= side.querySelector<HTMLInputElement>("#wm-cells-toggle")!;
    const cellsToggleWrap = side.querySelector<HTMLLabelElement>("#wm-cells-toggle-wrap")!;
    cellsToggle.addEventListener("change", () => {
        cellCanvas.style.visibility = cellsToggle.checked ? "visible" : "hidden";
    });

    // Cell-overlay state: re-render whenever EITHER the cells data OR the
    // image natural dims arrive (whichever comes second triggers the draw).
    let lastCellsData: Array<[number, number, number, number, number]> | null = null;
    let lastInteractiveCells: Set<number> | null = null;
    let lastImgW = 0, lastImgH = 0;

    function redrawCellOverlay(): void {
        if (!lastCellsData || !lastImgW || !lastImgH) return;
        // Canvas is sized to the IMAGE natural dims so cells extending beyond
        // the slot edges (e.g. row 0 above slot top) are not clipped. Slot is
        // centered: offset = ((natW - 1204)/2, (natH - 860)/2).
        const slotTLx = (lastImgW - PREVIEW_W) / 2;
        const slotTLy = (lastImgH - PREVIEW_H) / 2;
        // Per-map cell offset from cell-offsets.json (computed offline by
        // averaging interactive sprite-pivot positions on each map). Falls back
        // to the global median for maps with no interactives.
        let oX = CELL_OX_DEFAULT, oY = CELL_OY_DEFAULT;
        if (cellOffsetsByMap && selected && cellOffsetsByMap[String(selected.id)]) {
            const [px, py] = cellOffsetsByMap[String(selected.id)];
            oX = px; oY = py;
        }
        renderCellGrid(
            lastCellsData, cellCanvas,
            lastInteractiveCells, /*overOverlay=*/ true,
            lastImgW, lastImgH, slotTLx, slotTLy, oX, oY,
        );
        // Canvas covers the entire wrap (which has the image's aspect ratio).
        cellCanvas.style.left = "0";
        cellCanvas.style.top = "0";
        cellCanvas.style.width = "100%";
        cellCanvas.style.height = "100%";
    }

    function positionCellCanvas(natW: number, natH: number): void {
        if (!natW || !natH) return;
        previewWrap.style.aspectRatio = `${natW}/${natH}`;
        lastImgW = natW; lastImgH = natH;
        redrawCellOverlay();
    }
    const canvas     = container.querySelector<HTMLCanvasElement>("#wm-canvas")!;
    const ctx        = canvas.getContext("2d")!;
    const overlay    = container.querySelector<HTMLCanvasElement>("#wm-overlay")!;
    const overlayCtx = overlay.getContext("2d")!;
    const canvasWrap = container.querySelector<HTMLDivElement>("#wm-canvas-wrap")!;
    const hoverLabel = container.querySelector<HTMLDivElement>("#wm-hover-label")!;

    let catalogs: Catalogs | null = null;
    let availablePreviews: Set<number> = new Set();
    let canonicalCoords: Record<string, number> | null = null;
    let tileMapping: Record<string, MappedTile[]> | null = null;
    let wmTiles: MappedTile[] = [];
    let maps: MapEntry[] = [];
    let bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let currentWorldMap = 1;
    let selected: MapEntry | null = null;
    let cellSize = 8;

    // Atlas backing-canvas size cap — wm=1 is 10000×8000 native. We render
    // at min(1, ATLAS_MAX_W / wm.totalWidth) so canvas memory stays sane
    // and zoom CSS-transforms the rendered atlas instead of redrawing.
    const ATLAS_MAX_W = 4000;

    // Per-map preview overlay (lazy-loaded). Drawn on a viewport-sized
    // canvas above the atlas, repositioned every pan/zoom (rAF-throttled).
    const PREVIEW_MIN_PX = 120;       // map screen size at which preview kicks in
    const PREVIEW_CACHE_MAX = 2000;
    const PREVIEW_LOAD_CONCURRENCY = 16;
    type PreviewBitmap = ImageBitmap | HTMLImageElement;
    const previewImageCache = new Map<number, PreviewBitmap>(); // LRU (insertion order)
    const previewLoadQueue: number[] = [];
    let previewLoadInFlight = 0;
    const previewRequestedIds = new Set<number>();
    let overlayRafScheduled = false;

    // Hover state — drives the cursor-following label + slot highlight.
    let hoveredCoord: { posX: number; posY: number } | null = null;
    let lastMouseClient: { x: number; y: number } | null = null;

    function previewBumpLru(mapId: number): void {
        const img = previewImageCache.get(mapId);
        if (img) { previewImageCache.delete(mapId); previewImageCache.set(mapId, img); }
    }
    function previewEvictIfFull(): void {
        while (previewImageCache.size > PREVIEW_CACHE_MAX) {
            const oldestKey = previewImageCache.keys().next().value;
            if (oldestKey === undefined) break;
            const oldest = previewImageCache.get(oldestKey);
            if (oldest && "close" in oldest) (oldest as ImageBitmap).close();
            previewImageCache.delete(oldestKey);
        }
    }
    async function loadPreviewBitmap(mapId: number): Promise<PreviewBitmap | null> {
        try {
            const r = await fetch(`/map-preview/${mapId}.png`);
            if (!r.ok) return null;
            const blob = await r.blob();
            return await createImageBitmap(blob);
        } catch { return null; }
    }
    function pumpPreviewLoad(): void {
        while (previewLoadInFlight < PREVIEW_LOAD_CONCURRENCY && previewLoadQueue.length > 0) {
            const mapId = previewLoadQueue.shift()!;
            if (previewImageCache.has(mapId)) continue;
            previewLoadInFlight++;
            loadPreviewBitmap(mapId).then((bmp) => {
                previewLoadInFlight--;
                if (bmp) {
                    previewImageCache.set(mapId, bmp);
                    previewEvictIfFull();
                    requestOverlayDraw();
                } else {
                    previewRequestedIds.delete(mapId);
                }
                pumpPreviewLoad();
            });
        }
    }

    function requestOverlayDraw(): void {
        if (overlayRafScheduled) return;
        overlayRafScheduled = true;
        requestAnimationFrame(() => { overlayRafScheduled = false; drawOverlay(); });
    }

    function syncOverlaySize(): void {
        const vw = canvasWrap.clientWidth, vh = canvasWrap.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(vw * dpr));
        const h = Math.max(1, Math.round(vh * dpr));
        if (overlay.width !== w || overlay.height !== h) {
            overlay.width = w; overlay.height = h;
        }
        overlay.style.width  = vw + "px";
        overlay.style.height = vh + "px";
    }

    function atlasMode(): WorldMapDims | null {
        const wm = catalogs?.worldmaps.get(currentWorldMap);
        if (!wm || !wm.totalWidth || !wm.totalHeight) return null;
        if (!wmTiles.length) return null;
        return wm;
    }

    function worldToAtlasXY(wm: WorldMapDims, posX: number, posY: number): { x: number; y: number; w: number; h: number } {
        return {
            x: wm.origineX + posX * wm.mapWidth,
            y: wm.origineY + posY * wm.mapHeight,
            w: wm.mapWidth,
            h: wm.mapHeight,
        };
    }

    function worldToCanvasXY(posX: number, posY: number): { x: number; y: number } {
        return { x: (posX - bounds.minX) * cellSize, y: (posY - bounds.minY) * cellSize };
    }

    function drawOverlay(): void {
        if (!catalogs) { overlay.style.display = "none"; return; }
        // Two render modes: atlas (large per-wm tile sheet) and grid (flat
        // colored cells, e.g. wm=-1 souterrain which has no atlas dump).
        // Both branches use the SAME logical pipeline — only the projection
        // (posX, posY) → screen rect differs.
        const atlasWm = atlasMode();
        let tileScreenPx: number;
        let project: (px: number, py: number) => { sx: number; sy: number; sw: number; sh: number };
        if (atlasWm) {
            const atlasScale = Math.min(1, ATLAS_MAX_W / atlasWm.totalWidth);
            const k = atlasScale * viewZoom;
            tileScreenPx = atlasWm.mapWidth * k;
            project = (px, py) => {
                const a = worldToAtlasXY(atlasWm, px, py);
                return { sx: a.x * k + viewX, sy: a.y * k + viewY, sw: a.w * k, sh: a.h * k };
            };
        } else {
            // Grid mode: backing canvas has cellSize px per tile, viewZoom transforms it.
            const k = viewZoom;
            tileScreenPx = cellSize * k;
            project = (px, py) => ({
                sx: (px - bounds.minX) * cellSize * k + viewX,
                sy: (py - bounds.minY) * cellSize * k + viewY,
                sw: cellSize * k,
                sh: cellSize * k,
            });
        }
        const showPreviews = tileScreenPx >= PREVIEW_MIN_PX;
        const showResource = !!(currentResource && currentResourceMaps);
        if (!showPreviews && !showResource) {
            overlay.style.display = "none";
            return;
        }
        syncOverlaySize();
        overlay.style.display = "block";
        const dpr = window.devicePixelRatio || 1;
        overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const vw = canvasWrap.clientWidth, vh = canvasWrap.clientHeight;
        overlayCtx.clearRect(0, 0, vw, vh);

        // Dedup (posX, posY) buckets. Prefer content-based canonical-coords
        // (built by build-canonical-by-content.py — it scored every
        // candidate's preview by brightness + green ratio so cave variants
        // lose to outdoor ones). Fall back to first-match for catalog
        // coords not in the canonical file (extreme edge cases).
        const coordIdx = new Map<string, MapEntry>();
        const byId = new Map<number, MapEntry>();
        for (const m of maps) byId.set(m.id, m);
        if (canonicalCoords) {
            for (const [coordKey, canonicalId] of Object.entries(canonicalCoords)) {
                const m = byId.get(canonicalId);
                if (m) coordIdx.set(coordKey, m);
            }
        }
        for (const m of maps) {
            const k2 = `${m.posX},${m.posY}`;
            if (!coordIdx.has(k2)) coordIdx.set(k2, m);
        }

        overlayCtx.imageSmoothingEnabled = true;
        overlayCtx.imageSmoothingQuality = "low";

        if (showPreviews) {
            // Iterate the dedup'd canonical bucket — atlas-mode used a px×py loop
            // to skip out-of-view tiles, but coordIdx-iteration is also cheap
            // (~few thousand entries max per wm) and works in both modes.
            for (const [, m] of coordIdx) {
                const r = project(m.posX, m.posY);
                if (r.sx + r.sw < 0 || r.sy + r.sh < 0 || r.sx > vw || r.sy > vh) continue;
                if (!availablePreviews.has(m.id)) continue;
                const img = previewImageCache.get(m.id);
                if (img) {
                    previewBumpLru(m.id);
                    overlayCtx.drawImage(img, r.sx, r.sy, r.sw, r.sh);
                } else {
                    const sa = catalogs.subareas.get(m.subAreaId);
                    overlayCtx.fillStyle = areaColor(sa?.areaId ?? 0);
                    overlayCtx.globalAlpha = 0.25;
                    overlayCtx.fillRect(r.sx, r.sy, r.sw, r.sh);
                    overlayCtx.globalAlpha = 1;
                    if (!previewRequestedIds.has(m.id)) {
                        previewRequestedIds.add(m.id);
                        previewLoadQueue.push(m.id);
                    }
                }
            }
            pumpPreviewLoad();
        }

        // Selected outline (white) on top of previews. Only meaningful when previews
        // are visible (selected slot otherwise blends into the atlas tile).
        if (showPreviews && selected && selected.worldMap === currentWorldMap) {
            const r = project(selected.posX, selected.posY);
            overlayCtx.strokeStyle = "#fff";
            overlayCtx.lineWidth = 2;
            overlayCtx.strokeRect(r.sx + 1, r.sy + 1, r.sw - 2, r.sh - 2);
        }

        // Hovered slot highlight (cyan) on top.
        if (showPreviews && hoveredCoord && coordIdx.has(`${hoveredCoord.posX},${hoveredCoord.posY}`)) {
            const r = project(hoveredCoord.posX, hoveredCoord.posY);
            overlayCtx.strokeStyle = "rgba(0, 220, 255, 0.95)";
            overlayCtx.lineWidth = 2;
            overlayCtx.strokeRect(r.sx + 1, r.sy + 1, r.sw - 2, r.sh - 2);
        }

        // Resource bubbles — always on (regardless of zoom) when a resource is
        // picked. Bubble = filled gold disc with per-map count inside; scaled
        // with tile size but capped so it stays readable when dezoomed.
        if (showResource && currentResourceMaps) {
            const radius = Math.max(5, Math.min(16, tileScreenPx * 0.18));
            const drawText = tileScreenPx >= 32;
            overlayCtx.font = `bold ${Math.max(10, Math.min(13, Math.round(radius * 0.95)))}px monospace`;
            overlayCtx.textAlign = "center";
            overlayCtx.textBaseline = "middle";

            // Aggregate per (posX, posY) of the current worldmap. Many tiles
            // have multiple stacked maps (e.g. 10 maps at (-1,-42) on Lac
            // de Cania) — drawing N bubbles at the same screen point only
            // renders the last one's count visually. Sum them instead so
            // the user sees the true total at that coord.
            interface CoordBubble { sumCount: number; caveCount: number; }
            const coordTotals = new Map<string, CoordBubble>();
            const coordKey = (x: number, y: number) => `${x},${y}`;
            for (const [mid, cnt] of currentResourceMaps) {
                const m = byId.get(mid);
                if (!m || m.worldMap !== currentWorldMap) continue;
                const k = coordKey(m.posX, m.posY);
                let row = coordTotals.get(k);
                if (!row) { row = { sumCount: 0, caveCount: 0 }; coordTotals.set(k, row); }
                row.sumCount += cnt;
                if (currentWorldMap === 1) {
                    const cave = currentUndergroundCounts?.get(mid) ?? 0;
                    if (cave > row.caveCount) row.caveCount = cave;
                }
            }
            // Pure cave entrances (surface tile has no resource itself).
            if (currentWorldMap === 1 && currentUndergroundCounts) {
                for (const [surfaceMid, ugCount] of currentUndergroundCounts) {
                    if (ugCount <= 0) continue;
                    const m = byId.get(surfaceMid);
                    if (!m || m.worldMap !== 1) continue;
                    const k = coordKey(m.posX, m.posY);
                    let row = coordTotals.get(k);
                    if (!row) { row = { sumCount: 0, caveCount: 0 }; coordTotals.set(k, row); }
                    if (ugCount > row.caveCount) row.caveCount = ugCount;
                }
            }
            // Need posX/posY back from the key for projection; iterate pairs.
            for (const [k, row] of coordTotals) {
                const [px, py] = k.split(",").map(Number) as [number, number];
                const total = row.sumCount + row.caveCount;
                if (total <= 0) continue;
                const r = project(px, py);
                const cx = r.sx + r.sw / 2;
                const cy = r.sy + r.sh / 2;
                if (cx < -radius || cy < -radius || cx > vw + radius || cy > vh + radius) continue;
                const isPureCave = row.sumCount === 0 && row.caveCount > 0;
                const isMixed = row.sumCount > 0 && row.caveCount > 0;
                overlayCtx.fillStyle =
                    isPureCave ? "rgba(180, 100, 30, 0.85)" :
                    isMixed    ? "rgba(255, 140, 0, 0.95)" :
                                 "rgba(255, 200, 0, 0.95)";
                overlayCtx.beginPath();
                overlayCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                overlayCtx.fill();
                overlayCtx.strokeStyle = "rgba(0, 0, 0, 0.85)";
                overlayCtx.lineWidth = 1.5;
                overlayCtx.stroke();
                if (drawText) {
                    overlayCtx.fillStyle = isPureCave ? "#fff" : "#000";
                    overlayCtx.fillText(String(total), cx, cy + 0.5);
                }
            }
        }
    }

    function computeBounds(): void {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const m of maps) {
            if (m.posX < minX) minX = m.posX;
            if (m.posX > maxX) maxX = m.posX;
            if (m.posY < minY) minY = m.posY;
            if (m.posY > maxY) maxY = m.posY;
        }
        if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }
        bounds = { minX, maxX, minY, maxY };
    }

    async function renderAtlas(wm: WorldMapDims): Promise<void> {
        if (!catalogs) return;
        const scale = Math.min(1, ATLAS_MAX_W / wm.totalWidth);
        canvas.width  = Math.round(wm.totalWidth  * scale);
        canvas.height = Math.round(wm.totalHeight * scale);
        ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;

        let cursorX = 0, cursorY = 0, rowMaxH = 0;
        for (const t of wmTiles) {
            if (cursorX + t.width > wm.totalWidth + 8) {
                cursorY += rowMaxH; cursorX = 0; rowMaxH = 0;
            }
            const dx = cursorX * scale, dy = cursorY * scale;
            const dw = t.width * scale, dh = t.height * scale;
            if (t.tile) {
                try {
                    const img = await loadTileImage(`/tiles/${t.tile}`);
                    ctx.drawImage(img, dx, dy, dw, dh);
                } catch {
                    ctx.fillStyle = "#332"; ctx.fillRect(dx, dy, dw, dh);
                }
            } else {
                ctx.fillStyle = "#222"; ctx.fillRect(dx, dy, dw, dh);
                ctx.fillStyle = "#444"; ctx.font = `${Math.max(10, dh / 4)}px monospace`;
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(`?${t.name}`, dx + dw / 2, dy + dh / 2);
            }
            cursorX += t.width;
            if (t.height > rowMaxH) rowMaxH = t.height;
        }

        // Subarea-tinted overlay underneath previews so the user sees
        // structure even before per-map previews load.
        const byCoord = new Map<string, MapEntry>();
        for (const m of maps) {
            const k2 = `${m.posX},${m.posY}`;
            if (!byCoord.has(k2)) byCoord.set(k2, m);
        }
        ctx.globalAlpha = 0.35;
        for (const [, m] of byCoord) {
            const sa = catalogs.subareas.get(m.subAreaId);
            ctx.fillStyle = areaColor(sa?.areaId ?? 0);
            const a = worldToAtlasXY(wm, m.posX, m.posY);
            ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        }
        ctx.globalAlpha = 1;

        if (selected && selected.worldMap === wm.id) {
            const a = worldToAtlasXY(wm, selected.posX, selected.posY);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.strokeRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        }
    }

    // Fallback for worldmaps without an atlas dump — flat colored grid.
    function renderGrid(): void {
        if (!catalogs) return;
        const w = (bounds.maxX - bounds.minX + 1) * cellSize;
        const h = (bounds.maxY - bounds.minY + 1) * cellSize;
        canvas.width = w; canvas.height = h;
        ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);
        const byCoord = new Map<string, MapEntry>();
        for (const m of maps) {
            const k2 = `${m.posX},${m.posY}`;
            if (!byCoord.has(k2)) byCoord.set(k2, m);
        }
        for (const [, m] of byCoord) {
            const sa = catalogs.subareas.get(m.subAreaId);
            ctx.fillStyle = areaColor(sa?.areaId ?? 0);
            const { x, y } = worldToCanvasXY(m.posX, m.posY);
            ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
        }
        if (selected) {
            const { x, y } = worldToCanvasXY(selected.posX, selected.posY);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, y - 1, cellSize + 1, cellSize + 1);
        }
    }

    function render(): void {
        const wm = atlasMode();
        if (wm) { void renderAtlas(wm); } else { renderGrid(); }
        requestOverlayDraw();
    }

    function renderDetail(): void {
        if (!selected || !catalogs) {
            detail.textContent = "click a tile to inspect";
            previewWrap.style.display = "none";
            previewHint.style.display = "none";
            cellsToggleWrap.style.display = "none";
            cellLegend.style.display = "none";
            return;
        }
        const m = selected;
        // Use v1-first preview (legacy single-map render, often 2080×1107 with
        // the 1204×860 slot centered inside — sharper than v2's slot-cropped
        // version). Canvas positioning is recomputed on image load to align
        // the cell overlay precisely on the embedded slot region.
        previewWrap.style.display = "block";
        previewWrap.style.background = "#000";
        previewImg.style.display = "block";
        previewHint.style.display = "none";
        previewImg.onerror = () => {
            previewImg.style.display = "none";
            previewHint.style.display = "block";
            previewWrap.style.background = "#0a0a0a";
        };
        // Clear stale state — redraw will fire once both image + data arrive.
        lastCellsData = null; lastInteractiveCells = null;
        previewImg.onload = () => positionCellCanvas(previewImg.naturalWidth, previewImg.naturalHeight);
        previewImg.src = `/map-preview-single/${m.id}.png?t=${Date.now()}`;
        cellsToggleWrap.style.display = "none";
        cellLegend.style.display = "none";
        const sa = catalogs.subareas.get(m.subAreaId);
        const area = sa ? catalogs.areas.get(sa.areaId) : null;
        const lines: string[] = [
            `mapId:     ${m.id}`,
            `coords:    (${m.posX}, ${m.posY})  wm=${m.worldMap}`,
            `mapName:   ${m.name || "(unnamed)"}`,
            `subarea:   ${sa?.name ?? "?"}  (id=${m.subAreaId}, level=${sa?.level ?? "?"})`,
            `area:      ${area?.name ?? "?"}  (id=${sa?.areaId ?? "?"})`,
            ``,
        ];
        detail.textContent = lines.join("\n") + "loading…";

        loadMapData(m.id).then(data => {
            if (!data) {
                detail.textContent = lines.join("\n") + "no map data";
                return;
            }
            const interactiveCells = new Set<number>();
            const runtimeByCell = new Map<number, { name: string; typeId: number }>();
            if (Array.isArray(data.ie)) {
                for (const [cell] of data.ie) if (typeof cell === "number") interactiveCells.add(cell);
            }
            if (Array.isArray(data.interactives)) {
                for (const it of data.interactives) {
                    if (typeof it.cell === "number") {
                        interactiveCells.add(it.cell);
                        runtimeByCell.set(it.cell, { name: it.name, typeId: it.typeId });
                    }
                }
            }

            // Cell grid (bundle-extracted): isometric layout colored by walkability.
            if (Array.isArray(data.c) && data.c.length > 0) {
                lastCellsData = data.c;
                lastInteractiveCells = interactiveCells.size ? interactiveCells : null;
                redrawCellOverlay();
                cellCanvas.style.visibility = cellsToggle.checked ? "visible" : "hidden";
                cellsToggleWrap.style.display = "block";

                let walkable = 0, blocked = 0, farm = 0, hb = 0, mcd = 0;
                for (const cell of data.c) {
                    const f = cell[0] | 0;
                    if (!((f >> 5) & 1)) continue;
                    const mov = f & 1, nrp = (f >> 3) & 1;
                    if (mov && !nrp) walkable++;
                    if (!mov) blocked++;
                    if ((f >> 4) & 1) farm++;
                    if ((f >> 6) & 1) hb++;
                    if (cell[2]) mcd++;
                }
                cellLegend.innerHTML = `
                    <div style="display:grid; grid-template-columns:auto 1fr; gap:2px 8px; align-items:center; margin-top:var(--s-1)">
                      <span style="display:inline-block; width:10px; height:10px; background:#3a7b3a"></span><span>walkable (${walkable})</span>
                      ${farm ? `<span style="display:inline-block; width:10px; height:10px; background:#d9b02c"></span><span>farm (${farm})</span>` : ""}
                      ${mcd ? `<span style="display:inline-block; width:10px; height:10px; background:#ff9d00"></span><span>map-change (${mcd})</span>` : ""}
                      <span style="display:inline-block; width:10px; height:10px; background:#2a2520"></span><span>blocked (${blocked})</span>
                      ${hb ? `<span style="display:inline-block; width:10px; height:10px; background:#3cd"></span><span>havenbag (${hb})</span>` : ""}
                      ${interactiveCells.size ? `<span style="display:inline-block; width:10px; height:10px; background:#6cf"></span><span>interactive (${interactiveCells.size})</span>` : ""}
                    </div>`;
                cellLegend.style.display = "block";
            }

            if (data.n) {
                lines.push(`neighbors: N=${data.n[0]}  S=${data.n[1]}  W=${data.n[2]}  E=${data.n[3]}`);
            }
            if (Array.isArray(data.ie) && data.ie.length) {
                lines.push(``);
                lines.push(`interactives (${data.ie.length}):`);
                for (const [cell, iid, gfxId] of data.ie) {
                    const runtime = runtimeByCell.get(cell);
                    const label = runtime?.name ?? "(type unknown)";
                    lines.push(`  cell ${String(cell).padStart(3)}  ${label}  (iid=${iid}, gfx=${gfxId})`);
                }
            }
            if (data.updatedAt) {
                lines.push(``);
                lines.push(`last captured: ${data.updatedAt}`);
            }
            detail.textContent = lines.join("\n");
        }).catch((e) => {
            detail.textContent = lines.join("\n") + `(fetch err: ${String(e).slice(0, 80)})`;
        });
    }

    async function updateForWorldMap(): Promise<void> {
        if (!catalogs) return;
        maps = catalogs.maps.filter(m => m.worldMap === currentWorldMap);
        computeBounds();
        try {
            const r = await fetch(`/canonical-coords-wm${currentWorldMap}.json`);
            canonicalCoords = r.ok ? await r.json() : null;
        } catch { canonicalCoords = null; }
        const allTiles = tileMapping?.[String(currentWorldMap)] ?? [];
        wmTiles = allTiles
            .filter(t => (t.scale ?? "1") === "1")
            .slice()
            .sort((a, b) => a.index - b.index);
        const wm = catalogs.worldmaps.get(currentWorldMap);
        const dimsTxt = wm ? `${wm.totalWidth}×${wm.totalHeight}` : "no dims";
        statsEl.textContent = `${maps.length} maps on wm=${currentWorldMap}  •  ${dimsTxt}`;
        selected = null;
        refreshLayerToggle();
        // Refresh the picker's "X ici" hint for the new worldmap.
        if (currentResource && currentResourceMaps) {
            const byId = new Map<number, MapEntry>();
            for (const m of catalogs.maps) byId.set(m.id, m);
            let onWm = 0;
            for (const [mid] of currentResourceMaps) {
                const m = byId.get(mid);
                if (m && m.worldMap === currentWorldMap) onWm++;
            }
            rsActive.textContent = `${currentResource.name} · ${onWm}/${currentResourceMaps.length} ici`;
        }
        renderDetail();
        render();
        resetView();
        setTimeout(resetView, 200);
    }

    async function refresh(): Promise<void> {
        statsEl.textContent = "loading catalogs…";
        catalogs = await loadAllCatalogs();
        if (!catalogs) { statsEl.textContent = "missing catalogs — click EXTRACT CATALOGS"; return; }
        tileMapping = await loadTileMapping();
        availablePreviews = await loadPreviewIds();
        try {
            const r = await fetch(`/cell-offsets.json`);
            cellOffsetsByMap = r.ok ? await r.json() : null;
        } catch { cellOffsetsByMap = null; }
        // Resources catalog for the floating top-bar picker.
        resourcesCatalog = await loadResources();
        const wms = new Map<number, number>();
        for (const m of catalogs.maps) wms.set(m.worldMap, (wms.get(m.worldMap) ?? 0) + 1);
        wmSelect.innerHTML = "";
        for (const [wm, n] of [...wms.entries()].sort((a, b) => b[1] - a[1])) {
            const opt = document.createElement("option");
            opt.value = String(wm); opt.textContent = `wm=${wm}  (${n} maps)`;
            wmSelect.appendChild(opt);
        }
        wmSelect.value = String(currentWorldMap);
        await updateForWorldMap();
    }

    // Zoom + pan ---------------------------------------------------------
    let viewZoom = 1, viewX = 0, viewY = 0;
    const applyTransform = () => {
        canvas.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewZoom})`;
        requestOverlayDraw();
        evaluateHoverFromLastMouse();
    };

    const resizeObs = new ResizeObserver(() => requestOverlayDraw());
    resizeObs.observe(canvasWrap);

    const resetView = () => {
        const vw = canvasWrap.clientWidth || 1, vh = canvasWrap.clientHeight || 1;
        const cw = canvas.width || 1, ch = canvas.height || 1;
        viewZoom = Math.min(vw / cw, vh / ch, 1);
        viewX = (vw - cw * viewZoom) / 2;
        viewY = (vh - ch * viewZoom) / 2;
        applyTransform();
    };

    function centerOnMap(m: MapEntry): void {
        const vw = canvasWrap.clientWidth || 1, vh = canvasWrap.clientHeight || 1;
        const wm = atlasMode();
        let cx: number, cy: number, desiredZoom: number;
        if (wm) {
            const atlasScale = Math.min(1, ATLAS_MAX_W / wm.totalWidth);
            const a = worldToAtlasXY(wm, m.posX, m.posY);
            cx = (a.x + a.w / 2) * atlasScale;
            cy = (a.y + a.h / 2) * atlasScale;
            const target = Math.min(vw, vh) / 3;
            desiredZoom = Math.min(6, Math.max(1.5, target / Math.max(1, a.w * atlasScale)));
        } else {
            const p = worldToCanvasXY(m.posX, m.posY);
            cx = p.x + cellSize / 2;
            cy = p.y + cellSize / 2;
            desiredZoom = 4;
        }
        viewZoom = desiredZoom;
        viewX = vw / 2 - cx * viewZoom;
        viewY = vh / 2 - cy * viewZoom;
        applyTransform();
    }

    canvasWrap.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const rect = canvasWrap.getBoundingClientRect();
        const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
        const nextZoom = Math.max(0.05, Math.min(20, viewZoom * factor));
        viewX = mx - (mx - viewX) * (nextZoom / viewZoom);
        viewY = my - (my - viewY) * (nextZoom / viewZoom);
        viewZoom = nextZoom;
        lastMouseClient = { x: ev.clientX, y: ev.clientY };
        applyTransform();
    }, { passive: false });

    // Space + drag = pan.
    let spaceDown = false, panning = false, panStartX = 0, panStartY = 0, panOrigX = 0, panOrigY = 0;
    const kd = (ev: KeyboardEvent) => {
        if (ev.code === "Space" && !spaceDown) {
            const t = ev.target as HTMLElement;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
            spaceDown = true;
            canvasWrap.style.cursor = "grab";
            ev.preventDefault();
        }
    };
    const ku = (ev: KeyboardEvent) => {
        if (ev.code === "Space") { spaceDown = false; canvasWrap.style.cursor = ""; }
    };
    document.addEventListener("keydown", kd);
    document.addEventListener("keyup", ku);
    const mo = new MutationObserver(() => {
        if (!container.contains(canvasWrap)) {
            document.removeEventListener("keydown", kd);
            document.removeEventListener("keyup", ku);
            mo.disconnect();
        }
    });
    mo.observe(container.parentElement || container, { childList: true, subtree: true });

    canvasWrap.addEventListener("mousedown", (ev) => {
        if (!spaceDown || ev.button !== 0) return;
        panning = true;
        panStartX = ev.clientX; panStartY = ev.clientY;
        panOrigX = viewX; panOrigY = viewY;
        canvasWrap.style.cursor = "grabbing";
        ev.preventDefault();
    });
    document.addEventListener("mousemove", (ev) => {
        if (!panning) return;
        viewX = panOrigX + (ev.clientX - panStartX);
        viewY = panOrigY + (ev.clientY - panStartY);
        applyTransform();
    });
    document.addEventListener("mouseup", () => {
        if (panning) {
            panning = false;
            canvasWrap.style.cursor = spaceDown ? "grab" : "";
        }
    });

    // Hover tracking — highlight + label. Re-run after every transform
    // because zoom/pan changes which slot is under the (still-stationary)
    // cursor without firing a mousemove.
    function evaluateHoverFromLastMouse(): void {
        if (!catalogs || !lastMouseClient) return;
        const wm = atlasMode();
        if (!wm) { hoveredCoord = null; hoverLabel.style.display = "none"; return; }
        const rect = canvas.getBoundingClientRect();
        const px = (lastMouseClient.x - rect.left) * (canvas.width / rect.width);
        const py = (lastMouseClient.y - rect.top)  * (canvas.height / rect.height);
        const scale = Math.min(1, ATLAS_MAX_W / wm.totalWidth);
        const wx = Math.floor((px / scale - wm.origineX) / wm.mapWidth);
        const wy = Math.floor((py / scale - wm.origineY) / wm.mapHeight);
        const inside = wx >= bounds.minX && wx <= bounds.maxX && wy >= bounds.minY && wy <= bounds.maxY;
        if (inside) {
            hoveredCoord = { posX: wx, posY: wy };
            const wrapRect = canvasWrap.getBoundingClientRect();
            hoverLabel.textContent = `(${wx}, ${wy})`;
            hoverLabel.style.left = (lastMouseClient.x - wrapRect.left) + "px";
            hoverLabel.style.top  = (lastMouseClient.y - wrapRect.top)  + "px";
            hoverLabel.style.display = "block";
        } else {
            hoveredCoord = null;
            hoverLabel.style.display = "none";
        }
        requestOverlayDraw();
    }

    canvasWrap.addEventListener("mousemove", (ev) => {
        lastMouseClient = { x: ev.clientX, y: ev.clientY };
        evaluateHoverFromLastMouse();
    });
    canvasWrap.addEventListener("mouseleave", () => {
        lastMouseClient = null;
        if (!hoveredCoord) return;
        hoveredCoord = null;
        hoverLabel.style.display = "none";
        requestOverlayDraw();
    });

    // Click-to-select a map. Picks via the same canonical-coords dedup as
    // the overlay so the side panel reflects what's actually drawn.
    canvas.addEventListener("click", (ev) => {
        if (!catalogs || spaceDown) return;
        const rect = canvas.getBoundingClientRect();
        const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
        const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
        const wm = atlasMode();
        let wx: number, wy: number;
        if (wm) {
            const scale = Math.min(1, ATLAS_MAX_W / wm.totalWidth);
            wx = Math.floor((px / scale - wm.origineX) / wm.mapWidth);
            wy = Math.floor((py / scale - wm.origineY) / wm.mapHeight);
        } else {
            wx = Math.floor(px / cellSize) + bounds.minX;
            wy = Math.floor(py / cellSize) + bounds.minY;
        }
        const k = `${wx},${wy}`;
        let hit: MapEntry | undefined;
        if (canonicalCoords && canonicalCoords[k]) {
            hit = maps.find(m => m.id === canonicalCoords![k]);
        }
        if (!hit) hit = maps.find(m => m.posX === wx && m.posY === wy);
        if (!hit) { selected = null; renderDetail(); render(); return; }
        selected = hit;
        renderDetail();
        render();
    });

    // Click preview thumbnail → full-screen overlay (with cell canvas on top).
    previewWrap.addEventListener("click", () => {
        if (!selected) return;
        const overlayDiv = document.createElement("div");
        overlayDiv.style.cssText = "position:fixed; inset:0; z-index:999; background:rgba(0,0,0,0.9); display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer";
        const hasPreview = previewImg.style.display !== "none";
        // Use the preview image's natural aspect ratio (varies between v1 PNGs).
        const natW = previewImg.naturalWidth || PREVIEW_W;
        const natH = previewImg.naturalHeight || PREVIEW_H;
        const vw = window.innerWidth, vh = window.innerHeight;
        let wrapW = Math.floor(vw * 0.95);
        let wrapH = Math.floor(wrapW * natH / natW);
        if (wrapH > vh * 0.9) { wrapH = Math.floor(vh * 0.9); wrapW = Math.floor(wrapH * natW / natH); }
        // cellCanvas is now sized to the image's natural dims with cells offset
        // by slot TL — so the overlay just stretches it across the wrap (same
        // image aspect ratio).
        overlayDiv.innerHTML = `
            <div id="ov-wrap" style="position:relative; width:${wrapW}px; height:${wrapH}px; border:1px solid #333; background:${hasPreview ? "#000" : "#0a0a0a"}; overflow:hidden">
              ${hasPreview ? `<img src="${previewImg.src}" style="position:absolute; inset:0; width:100%; height:100%">` : ""}
              <canvas id="ov-cells" style="position:absolute; inset:0; width:100%; height:100%; visibility:${cellsToggle.checked ? "visible" : "hidden"}"></canvas>
            </div>
            <div style="margin-top:8px; color:var(--c-label); font-size:11px; font-family:var(--font-mono)">mapId ${selected.id} · (${selected.posX}, ${selected.posY}) · click or esc to close</div>
        `;
        const ovCells = overlayDiv.querySelector<HTMLCanvasElement>("#ov-cells")!;
        ovCells.width = cellCanvas.width;
        ovCells.height = cellCanvas.height;
        ovCells.getContext("2d")!.drawImage(cellCanvas, 0, 0);

        const close = () => overlayDiv.remove();
        overlayDiv.addEventListener("click", close);
        document.addEventListener("keydown", function onKey(ev) {
            if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
        });
        document.body.appendChild(overlayDiv);
    });

    // ---------------------------------------------------------------------
    // Resource picker — search + dropdown in the floating top bar. Pick a
    // resource → bubbles drawn on each map containing it (count inside).
    // ---------------------------------------------------------------------
    const rsInput   = container.querySelector<HTMLInputElement>("#wm-rs-input")!;
    const rsActive  = container.querySelector<HTMLSpanElement>("#wm-rs-active")!;
    const rsClear   = container.querySelector<HTMLButtonElement>("#wm-rs-clear")!;
    const rsDropdown= container.querySelector<HTMLDivElement>("#wm-rs-dropdown")!;
    let resourcesCatalog: ResourceEntry[] = [];
    let currentResource: ResourceEntry | null = null;
    let currentResourceMaps: Array<[number, number]> | null = null;  // [mapId, count]
    // Underground-cave aggregation: for each surface entrance (wm=1) mapId,
    // sum the resource count over all wm=-1 maps in the connected cave
    // component reachable through that entrance. Lets the surface bubbles
    // show "this cave has N resources inside" instead of just the surface
    // tile's own count. Computed lazily on first resource pick.
    let currentUndergroundCounts: Map<number, number> | null = null;
    let caveComponentsByEntrance: Map<number, Set<number>[]> | null = null;
    let cachedWorldGraph: { adj: Map<number, number[]>; uidToMid: Map<number, number>; midToUids: Map<number, number[]> } | null = null;
    let cachedSubareaNames: Map<number, string> = new Map();
    // mapId → [topMid, bottomMid, leftMid, rightMid] from each map's `n`
    // field. Used for physical cave-component BFS.
    let cachedNeighbors: Map<number, number[]> = new Map();

    async function ensureWorldGraphLoaded(): Promise<typeof cachedWorldGraph> {
        if (cachedWorldGraph) return cachedWorldGraph;
        try {
            const [wgResp, saResp, nbResp] = await Promise.all([
                fetch("/api/worldgraph"),
                fetch("/api/catalog/subareas"),
                fetch("/api/map-neighbors"),
            ]);
            if (!wgResp.ok) return null;
            const j = await wgResp.json();
            const adj = new Map<number, number[]>();
            for (const [k, v] of Object.entries(j.adjacency || {})) adj.set(Number(k), v as number[]);
            const uidToMid = new Map<number, number>();
            for (const [k, v] of Object.entries(j.uidToMapId || {})) uidToMid.set(Number(k), Number(v));
            const midToUids = new Map<number, number[]>();
            for (const [u, m] of uidToMid) {
                const list = midToUids.get(m) ?? []; list.push(u); midToUids.set(m, list);
            }
            cachedWorldGraph = { adj, uidToMid, midToUids };
            if (saResp.ok) {
                const sa = await saResp.json();
                for (const s of (sa?.items ?? [])) cachedSubareaNames.set(Number(s.id), String(s.name ?? ""));
            }
            if (nbResp.ok) {
                const nb = await nbResp.json();
                for (const [mid, list] of Object.entries(nb?.neighbors ?? {})) {
                    cachedNeighbors.set(Number(mid), (list as number[]).map(Number));
                }
            }
            return cachedWorldGraph;
        } catch { return null; }
    }

    // Build a map from each "entrance" mapId to the set of FOREIGN subarea
    // groups it directly connects to via the worldgraph.
    //
    // A "foreign subarea" is one DIFFERENT from the entrance map's own
    // subareaId. We only aggregate small subareas (≤MAX_INTERIOR_MAPS) to
    // avoid showing absurd totals at the boundary of huge open areas.
    // Most caves/mines/dungeons fit comfortably under 50 maps; cities and
    // open regions go in the hundreds.
    //
    // The catalog's `outdoor` field is broken (always false in current
    // dumps), so we use subarea size as a heuristic for "is this an
    // interior to aggregate". May produce false positives for small open
    // areas — refine later if needed.
    function computeCaveComponentsByEntrance(): Map<number, Set<number>[]> {
        if (caveComponentsByEntrance) return caveComponentsByEntrance;
        if (!cachedWorldGraph || !catalogs) {
            caveComponentsByEntrance = new Map();
            return caveComponentsByEntrance;
        }
        const { adj, uidToMid, midToUids } = cachedWorldGraph;

        // Group maps by subareaId.
        const subareaToMaps = new Map<number, Set<number>>();
        for (const m of catalogs.maps) {
            let set = subareaToMaps.get(m.subAreaId);
            if (!set) { set = new Set(); subareaToMaps.set(m.subAreaId, set); }
            set.add(m.id);
        }
        const subareaOf = new Map<number, number>();
        for (const m of catalogs.maps) subareaOf.set(m.id, m.subAreaId);

        // STRUCTURAL SIGNAL — stack_ratio: fraction of a subarea's maps that
        // share their (posX, posY, worldMap) tuple with maps from a DIFFERENT
        // subarea. Caves/mines/dungeons are by construction overlaid on top
        // of surface coords — so their stack_ratio is near 1. Open areas
        // (forêt, champs, île) have their own geographic footprint and
        // rarely share coords → low stack_ratio.
        //
        // Empirically:
        //   Mine Istairameur=1.00, Souterrains=0.89  → caves
        //   Montagne basse=0.42, Forêt d'Astrub=0.09 → open
        // Threshold 0.7 captures caves cleanly without false positives.
        const coordToSubs = new Map<string, Set<number>>();
        for (const m of catalogs.maps) {
            const key = `${m.posX},${m.posY},${m.worldMap}`;
            let s = coordToSubs.get(key); if (!s) { s = new Set(); coordToSubs.set(key, s); }
            s.add(m.subAreaId);
        }
        const isCave = new Map<number, boolean>();
        for (const [sid, mids] of subareaToMaps) {
            if (mids.size === 0) continue;
            let stacked = 0;
            for (const mid of mids) {
                const m = catalogs.maps.find(x => x.id === mid);
                if (!m) continue;
                const subs = coordToSubs.get(`${m.posX},${m.posY},${m.worldMap}`) ?? new Set();
                if (subs.size > 1) stacked++;
            }
            const stackRatio = stacked / mids.size;
            isCave.set(sid, stackRatio >= 0.7);
        }

        // CAVE COMPONENTS via worldgraph adjacency, restricted to cave-
        // classified maps (stack_ratio ≥ 0.7). The worldgraph carries the
        // full graph including special cave-entry transitions (arrows,
        // scripts) that are absent from the per-map `n` field. Treat
        // edges as UNDIRECTED for the component BFS so one-way exits
        // don't artificially split a cave.
        const isCaveMid = (mid: number) => {
            const sa = subareaOf.get(mid);
            return sa !== undefined && isCave.get(sa) === true;
        };
        // Build undirected cave-edge adjacency: cave-mid ↔ cave-mid (any
        // direction in the worldgraph counts).
        const caveAdj = new Map<number, Set<number>>();
        const addCaveEdge = (a: number, b: number) => {
            if (!isCaveMid(a) || !isCaveMid(b) || a === b) return;
            let s = caveAdj.get(a); if (!s) { s = new Set(); caveAdj.set(a, s); } s.add(b);
            let t = caveAdj.get(b); if (!t) { t = new Set(); caveAdj.set(b, t); } t.add(a);
        };
        for (const [src, dests] of adj) {
            const sm = uidToMid.get(src);
            if (sm === undefined) continue;
            for (const v of dests) {
                const dm = uidToMid.get(v);
                if (dm !== undefined) addCaveEdge(sm, dm);
            }
        }
        // BFS each cave map → component.
        const componentOf = new Map<number, Set<number>>();
        for (const [sid, mids] of subareaToMaps) {
            if (!isCave.get(sid)) continue;
            for (const startMid of mids) {
                if (componentOf.has(startMid)) continue;
                const comp = new Set<number>();
                const queue: number[] = [startMid];
                while (queue.length) {
                    const cur = queue.shift()!;
                    if (comp.has(cur)) continue;
                    comp.add(cur);
                    for (const nb of (caveAdj.get(cur) ?? [])) {
                        if (!comp.has(nb)) queue.push(nb);
                    }
                }
                for (const m of comp) componentOf.set(m, comp);
            }
        }

        // ENTRANCES via worldgraph: E enters component C iff there's a
        // worldgraph edge between E and any member of C, AND E itself
        // is NOT in C (so E is either a non-cave surface tile or a cave
        // tile in a different physical system that happens to share an
        // edge — rare but possible).
        const result = new Map<number, Set<number>[]>();
        const addEntranceEdge = (a: number, b: number) => {
            const compA = componentOf.get(a);
            const compB = componentOf.get(b);
            // a → enters compB if compB exists and a isn't in compB
            if (compB && compA !== compB) {
                let arr = result.get(a);
                if (!arr) { arr = []; result.set(a, arr); }
                if (!arr.some(s => s === compB)) arr.push(compB);
            }
            // symmetric for b
            if (compA && compA !== compB) {
                let arr = result.get(b);
                if (!arr) { arr = []; result.set(b, arr); }
                if (!arr.some(s => s === compA)) arr.push(compA);
            }
        };
        for (const [src, dests] of adj) {
            const sm = uidToMid.get(src);
            if (sm === undefined) continue;
            for (const v of dests) {
                const dm = uidToMid.get(v);
                if (dm !== undefined && dm !== sm) addEntranceEdge(sm, dm);
            }
        }
        // Suppress: if `midToUids` was unused, mark it via a noop assignment
        // so tsc doesn't complain (it remains useful for future tweaks).
        void midToUids;
        caveComponentsByEntrance = result;
        return result;
    }

    function recomputeUndergroundCounts(): void {
        currentUndergroundCounts = new Map();
        if (!currentResourceMaps || !cachedWorldGraph) return;
        const countByMid = new Map<number, number>();
        for (const [mid, cnt] of currentResourceMaps) countByMid.set(mid, cnt);
        const compsByEntrance = computeCaveComponentsByEntrance();
        for (const [surfaceMid, comps] of compsByEntrance) {
            let total = 0;
            for (const comp of comps) {
                for (const undergroundMid of comp) {
                    total += countByMid.get(undergroundMid) ?? 0;
                }
            }
            if (total > 0) currentUndergroundCounts.set(surfaceMid, total);
        }
    }

    function renderRsDropdown(query: string): void {
        const q = query.trim().toLowerCase();
        let list = resourcesCatalog;
        if (q) list = list.filter(r =>
            r.name.toLowerCase().includes(q) ||
            (r.itemName && r.itemName.toLowerCase().includes(q)) ||
            (r.jobName && r.jobName.toLowerCase().includes(q))
        );
        // Sort: resources first (matched to job/item), then by jobName, then by mapCount desc.
        list = list.slice().sort((a, b) =>
            Number(b.isResource) - Number(a.isResource) ||
            (a.jobName || "zzz").localeCompare(b.jobName || "zzz") ||
            b.mapCount - a.mapCount
        );
        if (!list.length) {
            rsDropdown.innerHTML = `<div style="padding:8px; font-size:11px; color:var(--c-label)">aucune ressource trouvée</div>`;
            rsDropdown.style.display = "block";
            return;
        }
        rsDropdown.innerHTML = list.slice(0, 80).map(r => `
            <div class="wm-rs-item" data-tid="${r.typeId}"
                 style="display:flex; gap:8px; align-items:center; padding:5px 8px; cursor:pointer; border-bottom:1px solid #1a1a1a">
              <img src="${resourceIcon(r)}" loading="lazy" style="width:28px; height:28px; object-fit:contain; image-rendering:auto" onerror="this.style.opacity=0.2">
              <div style="flex:1; min-width:0">
                <div style="font-size:12px; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${r.name}</div>
                <div style="font-size:10px; color:var(--c-label); font-family:var(--font-mono)">
                  ${r.jobName ? `${r.jobName} · lvl ${r.levelMin} · ` : ""}${r.mapCount} maps · ${r.count} total
                </div>
              </div>
            </div>
        `).join("");
        rsDropdown.style.display = "block";
    }

    function setResource(r: ResourceEntry | null): void {
        currentResource = r;
        if (!r) {
            currentResourceMaps = null;
            rsActive.style.display = "none";
            rsClear.style.display = "none";
            rsDropdown.style.display = "none";
            requestOverlayDraw();
            return;
        }
        rsActive.textContent = r.name;
        rsActive.style.display = "inline-block";
        rsClear.style.display = "inline-block";
        rsDropdown.style.display = "none";
        rsInput.value = "";
        currentResourceMaps = null;
        Promise.all([loadResourceMaps(r.typeId), ensureWorldGraphLoaded()]).then(([entries]) => {
            // Guard: user might have switched resources before the fetch resolved.
            if (currentResource?.typeId !== r.typeId) return;
            currentResourceMaps = entries;
            recomputeUndergroundCounts();
            // Show the "X maps on current wm" hint.
            if (catalogs) {
                const byId = new Map<number, MapEntry>();
                for (const m of catalogs.maps) byId.set(m.id, m);
                let onWm = 0;
                for (const [mid] of entries) {
                    const m = byId.get(mid);
                    if (m && m.worldMap === currentWorldMap) onWm++;
                }
                const undergroundCount = currentUndergroundCounts?.size ?? 0;
                const ugSuffix = undergroundCount > 0 ? `  · ${undergroundCount} entrées de grotte` : "";
                rsActive.textContent = `${r.name} · ${onWm}/${entries.length} ici${ugSuffix}`;
            }
            requestOverlayDraw();
        });
    }

    rsInput.addEventListener("focus", () => renderRsDropdown(rsInput.value));
    rsInput.addEventListener("input", () => renderRsDropdown(rsInput.value));
    rsInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { rsDropdown.style.display = "none"; rsInput.blur(); }
    });
    rsDropdown.addEventListener("click", (e) => {
        const item = (e.target as HTMLElement).closest(".wm-rs-item") as HTMLElement | null;
        if (!item) return;
        const tid = Number(item.dataset["tid"]);
        const r = resourcesCatalog.find(x => x.typeId === tid);
        if (r) setResource(r);
    });
    rsClear.addEventListener("click", () => setResource(null));

    // ---- Surface ↔ Souterrain quick-toggle ----
    const layerToggle = container.querySelector<HTMLDivElement>("#wm-layer-toggle")!;
    const btnSurface  = container.querySelector<HTMLButtonElement>("#wm-layer-surface")!;
    const btnUnder    = container.querySelector<HTMLButtonElement>("#wm-layer-under")!;
    function refreshLayerToggle(): void {
        // Toggle is only meaningful between wm=1 (Monde) and wm=-1 (Souterrain).
        // Hide it on other worldmaps (e.g. Incarnam) since the swap wouldn't make sense.
        const hasUnder = !!catalogs?.maps.some(m => m.worldMap === -1);
        const isSurfaceOrUnder = currentWorldMap === 1 || currentWorldMap === -1;
        layerToggle.style.display = hasUnder && isSurfaceOrUnder ? "inline-flex" : "none";
        const active = "background:#3a2a10; color:#ffc940";
        const inactive = "background:#111; color:#aaa";
        const baseStyle = "border:none; border-radius:0; padding:4px 8px; font-size:11px;";
        btnSurface.style.cssText = baseStyle + (currentWorldMap === 1 ? active : inactive);
        btnUnder.style.cssText = baseStyle + "border-left:1px solid #333;" + (currentWorldMap === -1 ? active : inactive);
    }
    function setLayer(wm: number): void {
        if (currentWorldMap === wm) return;
        currentWorldMap = wm;
        wmSelect.value = String(wm);
        void updateForWorldMap();
    }
    btnSurface.addEventListener("click", () => setLayer(1));
    btnUnder.addEventListener("click", () => setLayer(-1));
    // Close dropdown on outside click.
    document.addEventListener("mousedown", (e) => {
        const t = e.target as Node;
        if (rsInput.contains(t) || rsDropdown.contains(t)) return;
        rsDropdown.style.display = "none";
    });

    // Side-panel button — reload-from-disk only. Extract + coverage moved to
    // the Coverage tab (see panels/coverage.ts).
    side.querySelector<HTMLButtonElement>("#wm-reload")!.addEventListener("click", () => refresh());

    wmSelect.addEventListener("change", () => {
        currentWorldMap = parseInt(wmSelect.value, 10);
        void updateForWorldMap();
    });

    // "Show map" — jump to a (posX, posY), switching worldmap if needed.
    function parseCoords(s: string): [number, number] | null {
        const m = s.trim().match(/^(-?\d+)\s*[,\s]\s*(-?\d+)$/);
        if (!m) return null;
        return [parseInt(m[1]!, 10), parseInt(m[2]!, 10)];
    }
    async function jumpToCoords(x: number, y: number): Promise<void> {
        if (!catalogs) return;
        const candidates = catalogs.maps.filter(m => m.posX === x && m.posY === y);
        if (!candidates.length) { logRpcLine(`[world] no map at (${x}, ${y})`); return; }
        const same = candidates.find(m => m.worldMap === currentWorldMap);
        const target = same ?? candidates[0]!;
        if (target.worldMap !== currentWorldMap) {
            logRpcLine(`[world] (${x}, ${y}) not on wm=${currentWorldMap}, switching to wm=${target.worldMap}`);
            currentWorldMap = target.worldMap;
            wmSelect.value = String(currentWorldMap);
            await updateForWorldMap();
        }
        selected = target;
        renderDetail();
        render();
        setTimeout(() => centerOnMap(target), 250);
    }
    jumpBtn.addEventListener("click", () => {
        const parsed = parseCoords(jumpEl.value);
        if (!parsed) { logRpcLine("[world] bad coords — use 'x, y' (e.g. 4, -19)"); return; }
        void jumpToCoords(parsed[0], parsed[1]);
    });
    jumpEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") jumpBtn.click();
    });

    // ---------------------------------------------------------------------
    // Coverage plan orchestrator — moved to panels/coverage.ts.
    // ---------------------------------------------------------------------


    await refresh();
}
