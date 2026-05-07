// Cell flags bitfield (from the Dofus mapdata bundles, reverse-engineered):
//   bit 0 mov, 1 los, 2 nonWalkableDuringFight (unused here),
//   3 nonWalkableDuringRP, 4 farmCell, 5 visible, 6 havenbagCell.

export interface CellFlags {
    mov: boolean;       // walkable in RP mode
    los: boolean;       // line-of-sight blocking when non-mov
    nonRP: boolean;     // non-walkable during RP (cell skipped from render)
    farm: boolean;      // farm cell (resources)
    visible: boolean;   // any-rendered cell — non-visible cells are skipped
    havenbag: boolean;  // havenbag drop cell
}

export function decodeCellFlags(flags: number): CellFlags {
    return {
        mov:      !!(flags & 1),
        los:      !!((flags >> 1) & 1),
        nonRP:    !!((flags >> 3) & 1),
        farm:     !!((flags >> 4) & 1),
        visible:  !!((flags >> 5) & 1),
        havenbag: !!((flags >> 6) & 1),
    };
}

/** Returns the fill color for a cell, or null if the cell should not be drawn. */
export function cellColor(flags: number, mcd: number): string | null {
    const f = decodeCellFlags(flags);
    if (!f.visible) return null;
    if (!f.mov)     return f.los ? "#4a4030" : "#2a2520";
    if (f.nonRP)    return null;
    if (mcd)        return "#ff9d00";
    if (f.farm)     return "#d9b02c";
    if (f.havenbag) return "#3cd";
    return "#3a7b3a";
}
