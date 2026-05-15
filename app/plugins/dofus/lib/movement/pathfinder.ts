// A* on the Dofus iso cell grid. Pure — no IO, no IL2CPP. The output is a
// list of `keyMovements` (`(direction << 12) | cellId` ints) compressed to
// just the start, every direction-change pivot, and the end — exactly the
// format the game's MapMoveRequest (isa) carries on the wire.
//
// Topology (standard exterior maps): 14 columns × 40 rows = 560 cells stored
// flat as `cellId = row*14 + col`. Odd rows are visually offset by half a
// cell to the right (iso convention), so direction deltas alternate by row
// parity. See `directionDelta` for the table.

export const MAP_WIDTH = 14;
export const MAP_HEIGHT = 40;
export const CELL_COUNT = MAP_WIDTH * MAP_HEIGHT;

/** Tuple shape from MapDetail.cells: [flags, mcd, ?, ?, ?]. */
export type CellTuple = readonly [number, number, number, number, number];

/** Walkable in exploration mode. mov bit set, nonRP bit clear. */
function isWalkable(cellId: number, cells: ReadonlyArray<CellTuple | undefined>): boolean {
    if (cellId < 0 || cellId >= CELL_COUNT) return false;
    const cell = cells[cellId];
    if (!cell) return false;
    const flags = cell[0];
    return (flags & 1) !== 0 && (flags & 8) === 0;
}

/** (col-delta, row-delta) for each direction, depending on row parity.
 *  Even row: dCol/dRow as is. Odd row: see comments. */
function directionDelta(direction: number, oddRow: boolean): { dCol: number; dRow: number } | null {
    switch (direction) {
        case 0: return { dCol: +1, dRow:  0 }; // E
        case 1: return { dCol: oddRow ? +1 :  0, dRow: +1 }; // SE
        case 2: return { dCol:  0, dRow: +2 }; // S
        case 3: return { dCol: oddRow ?  0 : -1, dRow: +1 }; // SW
        case 4: return { dCol: -1, dRow:  0 }; // W
        case 5: return { dCol: oddRow ?  0 : -1, dRow: -1 }; // NW
        case 6: return { dCol:  0, dRow: -2 }; // N
        case 7: return { dCol: oddRow ? +1 :  0, dRow: -1 }; // NE
        default: return null;
    }
}

function neighbour(cellId: number, direction: number): number | null {
    const row = Math.floor(cellId / MAP_WIDTH);
    const col = cellId % MAP_WIDTH;
    const delta = directionDelta(direction, (row & 1) === 1);
    if (!delta) return null;
    const newCol = col + delta.dCol;
    const newRow = row + delta.dRow;
    if (newCol < 0 || newCol >= MAP_WIDTH || newRow < 0 || newRow >= MAP_HEIGHT) return null;
    return newRow * MAP_WIDTH + newCol;
}

/** Direction taken when stepping `from`→`to` (must be adjacent), or null. */
function directionFromTo(from: number, to: number): number | null {
    for (let d = 0; d < 8; d++) {
        if (neighbour(from, d) === to) return d;
    }
    return null;
}

/** BFS — equivalent to A* on this uniform-cost grid; simpler and bounded by
 *  ~560 cells so we don't bother with a heap. Returns every cell from start
 *  to end inclusive, or null if unreachable. */
function findPath(
    startCell: number,
    endCell: number,
    cells: ReadonlyArray<CellTuple | undefined>,
): number[] | null {
    if (startCell === endCell) return [startCell];
    if (!isWalkable(startCell, cells)) return null;
    if (!isWalkable(endCell, cells)) return null;

    const parent = new Map<number, number | null>();
    parent.set(startCell, null);
    const queue: number[] = [startCell];
    let head = 0;

    while (head < queue.length) {
        const cur = queue[head++];
        if (cur === endCell) {
            const path: number[] = [];
            let c: number | null = cur;
            while (c !== null) {
                path.push(c);
                c = parent.get(c) ?? null;
            }
            return path.reverse();
        }
        for (let dir = 0; dir < 8; dir++) {
            const next = neighbour(cur, dir);
            if (next === null) continue;
            if (parent.has(next)) continue;
            if (next !== endCell && !isWalkable(next, cells)) continue;
            parent.set(next, cur);
            queue.push(next);
        }
    }
    return null;
}

/** Compress the dense path to keyMovement records: start + every cell where
 *  the direction changes + end. The end record carries the direction of its
 *  incoming segment (matches what the game wire format uses). */
function compressPath(path: number[]): { cellId: number; direction: number }[] {
    if (path.length === 0) return [];
    if (path.length === 1) return [{ cellId: path[0], direction: 0 }];

    const out: { cellId: number; direction: number }[] = [];
    let prevDir = directionFromTo(path[0], path[1]);
    if (prevDir === null) throw new Error(`non-adjacent cells in path: ${path[0]} → ${path[1]}`);
    out.push({ cellId: path[0], direction: prevDir });

    for (let i = 1; i < path.length - 1; i++) {
        const dir = directionFromTo(path[i], path[i + 1]);
        if (dir === null) throw new Error(`non-adjacent cells in path: ${path[i]} → ${path[i + 1]}`);
        if (dir !== prevDir) {
            out.push({ cellId: path[i], direction: dir });
            prevDir = dir;
        }
    }
    out.push({ cellId: path[path.length - 1], direction: prevDir });
    return out;
}

function encodeKeyMovement(cellId: number, direction: number): number {
    return ((direction & 0x7) << 12) | (cellId & 0xFFF);
}

export interface ComputeCellPathSuccess {
    ok: true;
    /** Every cell traversed, start to end inclusive — useful for previews. */
    path: number[];
    /** What goes on the wire: `(direction << 12) | cellId` per pivot. */
    keyMovements: number[];
}

export interface ComputeCellPathFailure {
    ok: false;
    reason: string;
}

export type ComputeCellPathResult = ComputeCellPathSuccess | ComputeCellPathFailure;

export function computeCellPath(
    fromCell: number,
    toCell: number,
    cells: ReadonlyArray<CellTuple | undefined>,
): ComputeCellPathResult {
    if (fromCell < 0 || fromCell >= CELL_COUNT) return { ok: false, reason: `fromCell out of range: ${fromCell}` };
    if (toCell < 0 || toCell >= CELL_COUNT) return { ok: false, reason: `toCell out of range: ${toCell}` };
    if (!isWalkable(fromCell, cells)) return { ok: false, reason: `fromCell ${fromCell} is not walkable` };
    if (!isWalkable(toCell, cells)) return { ok: false, reason: `toCell ${toCell} is not walkable` };

    const path = findPath(fromCell, toCell, cells);
    if (!path) return { ok: false, reason: `no walkable path from ${fromCell} to ${toCell}` };

    const turns = compressPath(path);
    const keyMovements = turns.map((t) => encodeKeyMovement(t.cellId, t.direction));
    return { ok: true, path, keyMovements };
}

/** Decode a wire-format keyMovement int back into (cellId, direction). Used
 *  by tests / debug tools to verify what the game sent. */
export function decodeKeyMovement(km: number): { cellId: number; direction: number } {
    return { cellId: km & 0xFFF, direction: (km >>> 12) & 0x7 };
}
