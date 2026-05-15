/** Per-world atlas dimensions extracted from WorldMapsDataRoot.json. */
export interface WorldMapDims {
    origineX: number;
    origineY: number;
    mapWidth: number;
    mapHeight: number;
    totalWidth: number;
    totalHeight: number;
}

/** One entry from tile-mapping.json — describes a single cartography tile. */
export interface MappedTile {
    index: number;
    name: string;
    scale: string;
    address: string;
    guid: string;
    tile: string | null;
    width: number;
    height: number;
    ambiguous: boolean;
}

interface DimsCarrier {
    origineX?: number; origineY?: number;
    mapWidth?: number; mapHeight?: number;
    totalWidth?: number; totalHeight?: number;
    m_origineX?: number; m_origineY?: number;
    m_mapWidth?: number; m_mapHeight?: number;
    m_totalWidth?: number; m_totalHeight?: number;
}

/**
 * Pull the 6 atlas dims from a DataCenter world record. Tries canonical
 * field names first (origineX, mapWidth, totalWidth, ...) then falls back
 * to m_-prefixed names. Returns undefined if any field is missing or
 * non-finite — caller should treat this world as "no atlas".
 */
export function extractWorldDims(w: DimsCarrier): WorldMapDims | undefined {
    const origineX = w.origineX ?? w.m_origineX;
    const origineY = w.origineY ?? w.m_origineY;
    const mapWidth = w.mapWidth ?? w.m_mapWidth;
    const mapHeight = w.mapHeight ?? w.m_mapHeight;
    const totalWidth = w.totalWidth ?? w.m_totalWidth;
    const totalHeight = w.totalHeight ?? w.m_totalHeight;
    const all = [origineX, origineY, mapWidth, mapHeight, totalWidth, totalHeight];
    if (all.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return {
            origineX: origineX as number, origineY: origineY as number,
            mapWidth: mapWidth as number, mapHeight: mapHeight as number,
            totalWidth: totalWidth as number, totalHeight: totalHeight as number,
        };
    }
    return undefined;
}
