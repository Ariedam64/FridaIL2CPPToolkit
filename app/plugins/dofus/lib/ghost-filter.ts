// Static heuristic to detect ghost interactives — sprites visible from this
// map but actually anchored on a neighbour. The bundle dump packs each
// interactive as [cellId, elementId, gfxId, posX, posY]; the (posX, posY)
// pair is the actual rendering position from the C# transform.m31/m32.
//
// Detection rules:
//   1. Cell with mapChangeData > 0 → transition cell, element belongs to the
//      neighbour map being transitioned to. Drop it.
//   2. (posX, posY) far from the iso-projected position of cellId → cellId is
//      a fallback (often 559) and the sprite renders elsewhere visually,
//      typically at a neighbour map's edge. Drop it.
//
// The threshold (30 px) was derived empirically: real elements consistently
// project to dist <= 9.4 px (sub-cell variation due to sprite origin), ghosts
// always to dist >= 86 px. Threshold sits in the empty space between.

const COLS = 14;
const CELL_W = 86;
const HALF_H = 21.5;
const BASE_X_ODD = -537.5;
const BASE_X_EVEN = -585.5;
const BASE_Y_ODD = 483.75;
const BASE_Y_EVEN = 475.75;
const GHOST_DISTANCE_PX = 30;

/** Iso-project a cellId to (posX, posY) in the bundle's pixel coordinate
 *  space. Constants derived from real elements on map 88082192. */
export function predictCellPos(cellId: number): { x: number; y: number } {
    const col = cellId % COLS;
    const row = Math.floor(cellId / COLS);
    const odd = (row % 2) === 1;
    const baseX = odd ? BASE_X_ODD : BASE_X_EVEN;
    const baseY = odd ? BASE_Y_ODD : BASE_Y_EVEN;
    return { x: baseX + col * CELL_W, y: baseY - row * HALF_H };
}

/** Cell tuple shape from the static map dump. The 4th/5th positions are
 *  optional — pre-migration dumps only had 3 elements. */
export type CellRow = readonly [number, number, number, number, number];     // [flags, speed, mcd, moveZone, linkedZone]

/** Returns true if the static interactive at this triple is a ghost — visible
 *  from this map but not actually interactable here. Pre-migration triples
 *  (without posX/posY) can only check the mcd rule.*/
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

    // Rule 2: position vs predicted projection. Only available when the dump
    // includes posX/posY (4th/5th tuple elements).
    if (typeof posX === "number" && typeof posY === "number") {
        const pred = predictCellPos(cell);
        const dx = posX - pred.x;
        const dy = posY - pred.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > GHOST_DISTANCE_PX) return true;
    }

    return false;
}
