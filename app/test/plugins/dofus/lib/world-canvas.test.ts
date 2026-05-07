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
