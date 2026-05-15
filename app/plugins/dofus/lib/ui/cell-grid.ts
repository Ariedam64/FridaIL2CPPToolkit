import { cellColor } from "../movement/cell-flags";

export interface CellGridOpts {
    cells: Array<[number, number, number, number, number]>;
    /** Pixel size of one cell. Default 16 → ~232×164 canvas (2:1 iso ratio). */
    cellSize?: number;
    /** Optional [cellIdx, elementId, typeId] tuples drawn as colored discs. */
    interactives?: Array<[number, number, number]>;
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
    const halfV = cellSize / 4;

    canvas.width  = (COLS + 0.5) * cellSize;
    canvas.height = (ROWS + 1) * halfV;

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
            const cy = row * halfV + halfV;

            ctx.beginPath();
            ctx.moveTo(cx,             cy - halfV);
            ctx.lineTo(cx + cellSize/2, cy);
            ctx.lineTo(cx,             cy + halfV);
            ctx.lineTo(cx - cellSize/2, cy);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.stroke();
        }
    }

    if (opts.interactives) {
        for (const [cellIdx, _elementId, typeId] of opts.interactives) {
            const row = Math.floor(cellIdx / COLS);
            const col = cellIdx % COLS;
            if (row < 0 || row >= ROWS || col < 0 || col >= COLS) continue;
            const cx = col * cellSize + (row & 1 ? cellSize / 2 : 0) + cellSize / 2;
            const cy = row * halfV + halfV;
            const radius = cellSize / 4;
            const hue = (typeId * 137) % 360;
            ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }
}
