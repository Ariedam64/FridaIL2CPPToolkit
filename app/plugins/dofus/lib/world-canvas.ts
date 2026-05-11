import type { WorldMapDims, MappedTile } from "./world-dims";

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
    /** Map the player is currently standing on. Rendered as a yellow disc
     *  centered on the tile (atlas mode) or on the cell (colored grid). */
    playerMapId?: number | null;
    /** Pixel size of one map tile in colored-grid fallback. Default 14. */
    tileSize?: number;
    /** When provided together with `tiles`, render the real Dofus atlas. */
    dims?: WorldMapDims;
    tiles?: MappedTile[];
}

export interface WorldCanvasResult {
    /** Convert canvas-local (px, py) to a mapId, or null if the click is outside any tile. */
    hitTest(px: number, py: number): number | null;
}

/**
 * Hash an areaId to a stable HSL color. Same formula as the original world.ts.
 * When areaId is 0/missing, fall back to mapId for variety (since we may not
 * have full sub-area→area mapping for all bundled maps in v1).
 */
function areaColor(areaId: number, mapIdFallback: number): string {
    const seed = areaId !== 0 ? areaId : mapIdFallback;
    const h = (seed * 137) % 360;
    return `hsl(${h}, 55%, 45%)`;
}

export function renderWorldCanvas(
    canvas: HTMLCanvasElement,
    opts: WorldCanvasOpts,
): WorldCanvasResult | Promise<WorldCanvasResult> {
    if (opts.maps.length === 0) {
        canvas.width = 200; canvas.height = 60;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#888"; ctx.font = "12px sans-serif";
        ctx.fillText("No maps in this world", 10, 30);
        return { hitTest: () => null };
    }
    if (opts.dims && opts.tiles && opts.tiles.length > 0) {
        return renderAtlas(canvas, {
            wm: opts.dims, tiles: opts.tiles, maps: opts.maps,
            selectedMapId: opts.selectedMapId ?? null,
            hoveredMapId: opts.hoveredMapId ?? null,
            playerMapId: opts.playerMapId ?? null,
        });
    }
    return renderColoredGrid(canvas, opts);
}

function renderColoredGrid(canvas: HTMLCanvasElement, opts: WorldCanvasOpts): WorldCanvasResult {
    const tileSize = opts.tileSize ?? 14;

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

        ctx.fillStyle = areaColor(m.areaId, m.mapId);
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

    // Player marker — yellow disc on the player's tile in fallback mode.
    if (opts.playerMapId != null) {
        const m = opts.maps.find((x) => x.mapId === opts.playerMapId);
        if (m) {
            const cx = (m.posX - minX) * tileSize + padding + tileSize / 2;
            const cy = (m.posY - minY) * tileSize + padding + tileSize / 2;
            const r = Math.max(3, tileSize * 0.35);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#000";
            ctx.stroke();
        }
    }

    const hitTest = (px: number, py: number): number | null => {
        const wx = Math.floor((px - padding) / tileSize) + minX;
        const wy = Math.floor((py - padding) / tileSize) + minY;
        return tileByXY[`${wx},${wy}`] ?? null;
    };
    return { hitTest };
}

// Canvas memory budget (max width). 6000 px wide × 4800 tall × 4 bytes ≈ 115 MB,
// which gives sharp pixels up to ~4× user zoom on a 1500-px host (the host shows
// ~1500 source pixels at zoom 1×, and zoom 4× exposes the same canvas data 4×
// magnified — at 6000 source pixels there's enough detail for that).
const ATLAS_MAX_W = 6000;
const tileImageCache = new Map<string, HTMLImageElement>();

function loadTileImage(url: string): Promise<HTMLImageElement> {
    const cached = tileImageCache.get(url);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { tileImageCache.set(url, img); resolve(img); };
        img.onerror = () => reject(new Error(`failed to load tile: ${url}`));
        img.src = url;
    });
}

function worldToAtlasXY(wm: WorldMapDims, posX: number, posY: number) {
    return {
        x: wm.origineX + posX * wm.mapWidth,
        y: wm.origineY + posY * wm.mapHeight,
        w: wm.mapWidth,
        h: wm.mapHeight,
    };
}

function atlasXYToWorld(wm: WorldMapDims, atlasX: number, atlasY: number) {
    return {
        posX: Math.floor((atlasX - wm.origineX) / wm.mapWidth),
        posY: Math.floor((atlasY - wm.origineY) / wm.mapHeight),
    };
}

interface AtlasOpts {
    wm: WorldMapDims;
    tiles: MappedTile[];
    maps: WorldMap[];
    selectedMapId: number | null;
    hoveredMapId: number | null;
    playerMapId: number | null;
}

async function renderAtlas(canvas: HTMLCanvasElement, opts: AtlasOpts): Promise<WorldCanvasResult> {
    const wm = opts.wm;

    // Different worlds expose different scale sets (Amakna: 0.2/0.4/0.6/0.8/1 ;
    // the 34 other worlds: 0.25/0.5/0.75/1). Pick the largest scale that still
    // fits within ATLAS_MAX_W at native (renderScale=1 → no source downsampling),
    // for maximum sharpness at user zoom. Fall back to the smallest if even
    // that exceeds the budget (still rendered, just downsampled).
    const allScales = [...new Set(opts.tiles.map((t) => parseFloat(t.scale)))]
        .filter((s) => Number.isFinite(s))
        .sort((a, b) => a - b);
    if (allScales.length === 0) {
        // No parseable scales — fall back to colored-grid.
        return renderColoredGrid(canvas, {
            maps: opts.maps, selectedMapId: opts.selectedMapId, hoveredMapId: opts.hoveredMapId,
        });
    }
    const maxScaleByBudget = ATLAS_MAX_W / wm.totalWidth;
    let tileScale = allScales[0]; // smallest as fallback
    for (const s of allScales) {
        if (s <= maxScaleByBudget) tileScale = s;
    }
    const tilesForScale = opts.tiles.filter((t) => parseFloat(t.scale) === tileScale);

    // Atlas dimensions in tile-pixels (= world-pixels × tileScale).
    const tilesAtlasW = wm.totalWidth  * tileScale;
    const tilesAtlasH = wm.totalHeight * tileScale;
    const renderScale = Math.min(1, ATLAS_MAX_W / tilesAtlasW);
    canvas.width  = Math.round(tilesAtlasW * renderScale);
    canvas.height = Math.round(tilesAtlasH * renderScale);

    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;

    // Flowing-row layout: wrap when the next tile would overflow the atlas width (in tile-px).
    let cursorX = 0, cursorY = 0, rowMaxH = 0;
    for (const t of tilesForScale) {
        if (cursorX + t.width > tilesAtlasW + 8) {
            cursorY += rowMaxH; cursorX = 0; rowMaxH = 0;
        }
        const dx = cursorX * renderScale, dy = cursorY * renderScale;
        const dw = t.width  * renderScale, dh = t.height * renderScale;
        if (t.tile) {
            try {
                const img = await loadTileImage(`/api/dofus/cartography/tile/${t.tile}`);
                ctx.drawImage(img, dx, dy, dw, dh);
            } catch {
                ctx.fillStyle = "#332"; ctx.fillRect(dx, dy, dw, dh);
            }
        } else {
            ctx.fillStyle = "#222"; ctx.fillRect(dx, dy, dw, dh);
        }
        cursorX += t.width;
        if (t.height > rowMaxH) rowMaxH = t.height;
    }

    // Build the (posX,posY) → mapId index for hit-testing. Markers are NOT drawn:
    // the atlas tiles already convey area boundaries, and a 6203-map overlay
    // (Amakna) tints the whole atlas to noise. Selected/hovered outlines below
    // are the only visible markers.
    const tileByXY: Record<string, number> = {};
    for (const m of opts.maps) {
        tileByXY[`${m.posX},${m.posY}`] = m.mapId;
    }

    // Selected outline (full alpha, white).
    if (opts.selectedMapId != null) {
        const m = opts.maps.find((x) => x.mapId === opts.selectedMapId);
        if (m) {
            const a = worldToAtlasXY(wm, m.posX, m.posY);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.strokeRect(a.x * tileScale * renderScale, a.y * tileScale * renderScale,
                           a.w * tileScale * renderScale, a.h * tileScale * renderScale);
        }
    }
    // Hovered outline (semi-white, only when distinct from selected).
    if (opts.hoveredMapId != null && opts.hoveredMapId !== opts.selectedMapId) {
        const m = opts.maps.find((x) => x.mapId === opts.hoveredMapId);
        if (m) {
            const a = worldToAtlasXY(wm, m.posX, m.posY);
            ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
            ctx.strokeRect(a.x * tileScale * renderScale, a.y * tileScale * renderScale,
                           a.w * tileScale * renderScale, a.h * tileScale * renderScale);
        }
    }

    // Player marker — yellow disc centered on the tile the player is on.
    // Drawn last so it sits on top of selection/hover outlines.
    if (opts.playerMapId != null) {
        const m = opts.maps.find((x) => x.mapId === opts.playerMapId);
        if (m) {
            const a = worldToAtlasXY(wm, m.posX, m.posY);
            const cx = (a.x + a.w / 2) * tileScale * renderScale;
            const cy = (a.y + a.h / 2) * tileScale * renderScale;
            // Radius proportional to tile size so it stays visible at all zooms.
            const r = Math.max(4, Math.min(a.w, a.h) * tileScale * renderScale * 0.18);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#000";
            ctx.stroke();
            // Inner dot for high-zoom clarity.
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1, r * 0.25), 0, Math.PI * 2);
            ctx.fillStyle = "#000";
            ctx.fill();
        }
    }

    // Inverse hit-test: canvas-px → tile-px → world-px → world coords.
    return {
        hitTest: (px, py) => {
            const wx = (px / renderScale) / tileScale;
            const wy = (py / renderScale) / tileScale;
            const { posX, posY } = atlasXYToWorld(wm, wx, wy);
            return tileByXY[`${posX},${posY}`] ?? null;
        },
    };
}
