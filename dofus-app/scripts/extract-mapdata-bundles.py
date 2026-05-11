"""Extract per-map cells + neighbors + interactives from Dofus Unity bundles.

Walks all mapdata_assets_world_*.bundle files under StreamingAssets/Content/Map/Data,
reads each MapMetadata MonoBehaviour via its embedded TypeTree, and emits one
compact JSON per mapId to dofus-app/data/maps/<mapId>.json.

Compact format (1 file per map, ~8-10 KB):
  {
    "mapId": 154644,
    "n": [top, bottom, left, right],              # neighbor map ids
    "a": [[top], [bottom], [left], [right]],      # arrow cell lists
    "ie": [[cellId, interactionId, gfxId], ...],  # interactive elements resolved from the
                                                  # bundle's SerializeReference table.
                                                  # gfxId is the graphical asset id — the
                                                  # hypothesis is that gfxId → typeId is 1:1,
                                                  # which would let us bulk-map instance ids
                                                  # to resource types from a handful of
                                                  # CAPTURE HERE runs.
    "c": [[flags, speed, mapChangeData, moveZone, linkedZone], ...]  # 560 cells, array index = cellNumber
  }

Cell flags bitfield:
  bit 0: mov (walkable)
  bit 1: los (line of sight)
  bit 2: nonWalkableDuringFight
  bit 3: nonWalkableDuringRP
  bit 4: farmCell
  bit 5: visible
  bit 6: havenbagCell

Note: the bundle also exposes `red`/`blue` per-cell flags, but those only
apply to a tiny subset of arena-preset maps and are not what the in-game
"combat preview" uses (that's runtime/server-driven) — so we drop them.

Usage: python dofus-app/scripts/extract-mapdata-bundles.py
"""
import sys, time, json
from pathlib import Path

import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent  # dofus-app/
REPO = APP.parent  # repo root
SRC_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Data")
# Output goes to the v2 toolkit's data dir (the live consumer). The legacy
# dofus-app/data/maps/ is no longer the source of truth.
OUT = REPO / "app" / "plugins" / "dofus" / "data" / "maps"
INDEX = REPO / "app" / "plugins" / "dofus" / "data" / "maps_index.json"


def pack_cell(c):
    flags = (
        (1 if c.get("mov") else 0) |
        ((1 if c.get("los") else 0) << 1) |
        ((1 if c.get("nonWalkableDuringFight") else 0) << 2) |
        ((1 if c.get("nonWalkableDuringRP") else 0) << 3) |
        ((1 if c.get("farmCell") else 0) << 4) |
        ((1 if c.get("visible") else 0) << 5) |
        ((1 if c.get("havenbagCell") else 0) << 6)
    )
    return [flags, c.get("speed", 0), c.get("mapChangeData", 0),
            c.get("moveZone", 0), c.get("linkedZone", 0)]


def resolve_interactives(interactive_refs, refids_by_rid):
    """Turn [{"rid": N}, ...] into [[cellId, interactionId, gfxId, posX, posY], ...].

    Each interactiveElement is a SerializeReference that points into the
    MapMetadata's `references` table; the referenced object
    (ClientInteractiveAnimatedElementTransform) carries cellId, m_interactionId,
    gfxId, and a 2D transform whose m31/m32 fields are the actual rendering
    position in world pixels.

    The transform position lets the consumer detect ghost interactives — those
    visible from this map but actually anchored on a neighbour. A ghost has
    m31/m32 OUTSIDE the iso-projected position of its (logical) cellId by far
    more than typical sub-cell variation. See the backend filter for the
    threshold.
    """
    out = []
    for e in interactive_refs:
        rid = e.get("rid", 0) if isinstance(e, dict) else 0
        d = refids_by_rid.get(rid)
        if not d:
            continue
        cell = d.get("cellId")
        iid = d.get("m_interactionId") or d.get("interactionId") or 0
        gfx = d.get("gfxId") or 0
        tr = d.get("transform") or {}
        m31 = tr.get("m31", 0.0)
        m32 = tr.get("m32", 0.0)
        if cell is None:
            continue
        # Round to 2 decimals to keep the JSON compact (positions are stored at
        # quarter-pixel precision in the bundle anyway).
        out.append([int(cell), int(iid), int(gfx), round(float(m31), 2), round(float(m32), 2)])
    return out


def process_bundle(path: Path):
    env = UnityPy.load(str(path))
    out = []
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        name = str(tree.get("m_Name", ""))
        if not name.startswith("map_"):
            continue
        try:
            mid = int(name[4:])
        except ValueError:
            continue
        md = tree.get("mapData")
        if not isinstance(md, dict):
            continue
        # Build rid → data lookup from the MapMetadata's SerializeReference table.
        refids_by_rid = {}
        refs = tree.get("references")
        if isinstance(refs, dict):
            for r in refs.get("RefIds") or []:
                rr = r.get("rid") if isinstance(r, dict) else None
                if rr is None or rr < 0:
                    continue
                data = r.get("data")
                if isinstance(data, dict):
                    refids_by_rid[rr] = data

        cells = md.get("cellsData") or []
        ies = md.get("interactiveElements") or []
        out.append({
            "mapId": mid,
            "n": [md.get("topNeighbourId", 0), md.get("bottomNeighbourId", 0),
                  md.get("leftNeighbourId", 0), md.get("rightNeighbourId", 0)],
            "a": [md.get("topArrowCellList") or [], md.get("bottomArrowCellList") or [],
                  md.get("leftArrowCellList") or [], md.get("rightArrowCellList") or []],
            "ie": resolve_interactives(ies, refids_by_rid),
            "c": [pack_cell(c) for c in cells],
        })
    return out


def main():
    if not SRC_DIR.exists():
        print(f"source not found: {SRC_DIR}")
        sys.exit(1)

    OUT.mkdir(parents=True, exist_ok=True)
    bundles = sorted(SRC_DIR.glob("mapdata_assets_world_*.bundle"))
    print(f"found {len(bundles)} bundles")

    total = 0
    errors = 0
    index = []
    t0 = time.time()
    for i, bp in enumerate(bundles, 1):
        try:
            maps = process_bundle(bp)
        except Exception as e:
            print(f"  [{i}/{len(bundles)}] {bp.name} FAILED: {str(e)[:120]}")
            errors += 1
            continue
        for m in maps:
            mid = m["mapId"]
            (OUT / f"{mid}.json").write_text(
                json.dumps(m, separators=(",", ":")), encoding="utf-8"
            )
            index.append([mid, len(m["c"])])
            total += 1
        if i % 50 == 0 or i == len(bundles):
            print(f"  [{i}/{len(bundles)}] {total} maps in {time.time() - t0:.1f}s")

    INDEX.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"\ndone: {total} maps, {errors} bundle errors in {time.time() - t0:.1f}s")
    print(f"output: {OUT}")
    print(f"index:  {INDEX}")


if __name__ == "__main__":
    main()
