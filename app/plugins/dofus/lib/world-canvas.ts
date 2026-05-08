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

export function renderWorldCanvas(canvas: HTMLCanvasElement, opts: WorldCanvasOpts): WorldCanvasResult {
    if (opts.maps.length === 0) {
        canvas.width = 200; canvas.height = 60;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#888"; ctx.font = "12px sans-serif";
        ctx.fillText("No maps in this world", 10, 30);
        return { hitTest: () => null };
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
