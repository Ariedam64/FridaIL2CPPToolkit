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
        // 14.5 cols × 16 = 232 width, 41 × 4 = 164 height (2:1 iso ratio)
        expect(canvas.width).toBe(232);
        expect(canvas.height).toBe(164);
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
