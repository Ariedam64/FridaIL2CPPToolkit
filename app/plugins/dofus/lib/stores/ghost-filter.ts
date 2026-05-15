// Static heuristic to detect ghost interactives — sprites visible from this
// map but not actually interactable here. The bundle dump packs each
// interactive as [cellId, elementId, gfxId, posX, posY]; the (posX, posY)
// pair is the actual rendering position from the C# transform.m31/m32.
//
// Detection rules:
//   1. Cell with mapChangeData > 0 → transition cell, element belongs to the
//      neighbour map being transitioned to. Drop it.
//   2. Reverse-project (posX, posY) to fractional (col, row). If the result
//      falls OUTSIDE the playable grid [0, 13] × [0, 39] (with ±0.5 tol),
//      the sprite is drawn outside the playable area → ghost.
//      - Catches the cell=559 sentinel pattern (sprite belongs to a
//        neighbour, fallback cellId 559 on this side).
//      - Catches sprites drawn off-grid that exist in the bundle but are
//        not actionable from this map (e.g. dead content, removed pickups).
//      - Tall sprites (panneaux, statues) whose anchor sits high above
//        their base cell still project to a valid in-grid (col, row) because
//        the anchor is just somewhere in the grid → kept correctly.

const COLS = 14;
const ROWS = 40;
const CELL_W = 86;
const HALF_H = 21.5;
const BASE_X_ODD = -537.5;
const BASE_X_EVEN = -585.5;
const BASE_Y_ODD = 483.75;
const BASE_Y_EVEN = 475.75;
/** Tolerance on each side of the grid bounds. 0.5 = half a cell. */
const GRID_TOL = 0.5;

/** Iso-project a cellId to (posX, posY) in the bundle's pixel coordinate
 *  space. Constants derived from real elements on map 88082192. Kept as a
 *  public helper for diagnostics. */
export function predictCellPos(cellId: number): { x: number; y: number } {
    const col = cellId % COLS;
    const row = Math.floor(cellId / COLS);
    const odd = (row % 2) === 1;
    const baseX = odd ? BASE_X_ODD : BASE_X_EVEN;
    const baseY = odd ? BASE_Y_ODD : BASE_Y_EVEN;
    return { x: baseX + col * CELL_W, y: baseY - row * HALF_H };
}

/** Inverse of predictCellPos. Given a render position (m31, m32), return the
 *  fractional (col, row) the sprite would occupy on the grid. Out-of-grid
 *  results (col < 0, row < 0, col > 13, row > 39) signal a ghost. */
function projectPosToGrid(posX: number, posY: number): { col: number; row: number } {
    // We don't know the row's parity yet (different base_x per parity).
    // Use the even-row base for the initial row guess, then refine col with
    // the parity of the rounded row.
    const rowFrac = (BASE_Y_EVEN - posY) / HALF_H;
    const row = Math.round(rowFrac);
    const odd = ((row % 2) + 2) % 2 === 1;
    const baseX = odd ? BASE_X_ODD : BASE_X_EVEN;
    const colFrac = (posX - baseX) / CELL_W;
    return { col: colFrac, row: rowFrac };
}

/** Cell tuple shape from the static map dump. The 4th/5th positions are
 *  optional — pre-migration dumps only had 3 elements. */
export type CellRow = readonly [number, number, number, number, number];     // [flags, speed, mcd, moveZone, linkedZone]

/** Returns true if the static interactive at this triple is a ghost.
 *  Pre-migration triples (without posX/posY) can only check the mcd rule. */
export function isGhostInteractive(
    triple: readonly (number | undefined)[],
    cellsData: ReadonlyArray<CellRow>,
): boolean {
    const cell = triple[0] as number;
    const posX = triple[3];
    const posY = triple[4];

    // Rule 1: transition cell — always a ghost.
    const cellEntry = cellsData[cell];
    const mcd = cellEntry?.[2] ?? 0;
    if (mcd > 0) return true;

    // Rule 2: inverse-project sprite position to (col, row). Out-of-grid
    // means the sprite is drawn outside the playable area → ghost. Only
    // available when the dump includes posX/posY (4th/5th tuple elements).
    if (typeof posX === "number" && typeof posY === "number") {
        const { col, row } = projectPosToGrid(posX, posY);
        if (col < -GRID_TOL || col > (COLS - 1) + GRID_TOL) return true;
        if (row < -GRID_TOL || row > (ROWS - 1) + GRID_TOL) return true;
    }

    return false;
}
