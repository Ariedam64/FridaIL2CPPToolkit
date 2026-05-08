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

    const hitTest = (px: number, py: number): number | null => {
        const wx = Math.floor((px - padding) / tileSize) + minX;
        const wy = Math.floor((py - padding) / tileSize) + minY;
        return tileByXY[`${wx},${wy}`] ?? null;
    };
    return { hitTest };
}

const ATLAS_MAX_W = 3000;
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
        x: (posX - wm.origineX) * wm.mapWidth,
        y: (posY - wm.origineY) * wm.mapHeight,
        w: wm.mapWidth,
        h: wm.mapHeight,
    };
}

function atlasXYToWorld(wm: WorldMapDims, atlasX: number, atlasY: number) {
    return {
        posX: Math.floor(atlasX / wm.mapWidth)  + wm.origineX,
        posY: Math.floor(atlasY / wm.mapHeight) + wm.origineY,
    };
}

interface AtlasOpts {
    wm: WorldMapDims;
    tiles: MappedTile[];
    maps: WorldMap[];
    selectedMapId: number | null;
    hoveredMapId: number | null;
}

async function renderAtlas(canvas: HTMLCanvasElement, opts: AtlasOpts): Promise<WorldCanvasResult> {
    const wm = opts.wm;
    const scale = Math.min(1, ATLAS_MAX_W / wm.totalWidth);
    canvas.width  = Math.round(wm.totalWidth  * scale);
    canvas.height = Math.round(wm.totalHeight * scale);

    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;

    const tilesForScale = opts.tiles.filter((t) => t.scale === "0.2");

    let cursorX = 0, cursorY = 0, rowMaxH = 0;
    for (const t of tilesForScale) {
        if (cursorX + t.width > wm.totalWidth + 8) {
            cursorY += rowMaxH; cursorX = 0; rowMaxH = 0;
        }
        const dx = cursorX * scale, dy = cursorY * scale;
        const dw = t.width * scale, dh = t.height * scale;
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

    const tileByXY: Record<string, number> = {};
    ctx.globalAlpha = 0.35;
    for (const m of opts.maps) {
        const a = worldToAtlasXY(wm, m.posX, m.posY);
        ctx.fillStyle = areaColor(m.areaId, m.mapId);
        ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        tileByXY[`${m.posX},${m.posY}`] = m.mapId;
    }
    ctx.globalAlpha = 1;

    if (opts.selectedMapId != null) {
        const m = opts.maps.find((x) => x.mapId === opts.selectedMapId);
        if (m) {
            const a = worldToAtlasXY(wm, m.posX, m.posY);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.strokeRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        }
    }
    if (opts.hoveredMapId != null && opts.hoveredMapId !== opts.selectedMapId) {
        const m = opts.maps.find((x) => x.mapId === opts.hoveredMapId);
        if (m) {
            const a = worldToAtlasXY(wm, m.posX, m.posY);
            ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
            ctx.strokeRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        }
    }

    return {
        hitTest: (px, py) => {
            const { posX, posY } = atlasXYToWorld(wm, px / scale, py / scale);
            return tileByXY[`${posX},${posY}`] ?? null;
        },
    };
}
