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
