"""Build per-map cell-overlay offsets by reading interactive transforms from bundles.

Each interactive element has m31/m32 (sprite pivot in world coords). For most
Dofus sprites pivot is at center (px=py=0.5), so pivot screen position equals
the cell's intended visible center. Thus the offset to apply to our naive
cell formula is: (slot_center + (m31, -m32)) - my_formula(cellId).

Average across all interactives on the map → per-map offset robust to sprite
variation. For maps with 0 interactives, no entry is written (panel uses fallback).

Output: data/cell-offsets.json
  { "<mapId>": [ox, oy], ... }

Run: python dofus-app/scripts/build-cell-offsets.py
"""
import json, time
from pathlib import Path
import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"
APP = Path(__file__).resolve().parent.parent
SRC = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Data")
OUT = APP / "data" / "cell-offsets.json"

# Slot geometry (matches prerender-maps-cross.py + world.ts).
SLOT_W = 1204
SLOT_H = 860
CELL_W = 86
CELL_H = 43
GRID_COLS = 14


def cell_formula(cell_id: int) -> tuple[float, float]:
    """My naive cellId → slot screen coord (matches world.ts renderCellGrid pre-offset)."""
    col = cell_id % GRID_COLS
    row = cell_id // GRID_COLS
    cx = col * CELL_W + (row % 2) * (CELL_W / 2) + CELL_W / 2
    cy = row * (CELL_H / 2) + CELL_H / 2
    return cx, cy


def process_bundle(path: Path) -> dict[int, list[float]]:
    """Returns {mapId: [ox, oy]} for maps in this bundle that have interactives."""
    out: dict[int, list[float]] = {}
    env = UnityPy.load(str(path))
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
        md = tree.get("mapData") or {}
        ies = md.get("interactiveElements") or []
        if not ies:
            continue

        refs_by_rid: dict = {}
        for r in (tree.get("references") or {}).get("RefIds") or []:
            if isinstance(r, dict) and r.get("rid") is not None:
                d = r.get("data") or {}
                refs_by_rid[r["rid"]] = d

        offsets = []
        for e in ies:
            rid = e.get("rid", 0) if isinstance(e, dict) else 0
            d = refs_by_rid.get(rid)
            if not d:
                continue
            cell = d.get("cellId")
            tr = d.get("transform") or {}
            m31 = tr.get("m31")
            m32 = tr.get("m32")
            if cell is None or m31 is None or m32 is None:
                continue
            cx_formula, cy_formula = cell_formula(int(cell))
            # Slot center = (SLOT_W/2, SLOT_H/2) = (602, 430). Sprite pivot lands at
            # (slot_center_x + m31, slot_center_y - m32).
            actual_x = SLOT_W / 2 + float(m31)
            actual_y = SLOT_H / 2 - float(m32)
            offsets.append((actual_x - cx_formula, actual_y - cy_formula))

        if not offsets:
            continue
        # Some bundles place multiple "decorative" interactives all under the
        # same cellId (typically corner 559) with transforms pointing far from
        # that cell — they pollute a naive median (e.g. 3 normal + 3 outlier
        # gives median between them). Use the MODE instead: bin deltas into
        # integer (px) buckets, pick the most-frequent bucket. Robust because
        # similar sprites on the map share identical sprite-pivot offsets, so
        # the "real" delta naturally clusters tightly.
        from collections import Counter
        bucketed = Counter((round(ox), round(oy)) for ox, oy in offsets)
        best, _ = bucketed.most_common(1)[0]
        bx, by = float(best[0]), float(best[1])
        # Sanity-clamp: if the mode is unreasonably far from the global default
        # (-21.5, -75.2), the map's interactives are probably all decoy/decorative
        # placements (often the case on combat-arena or special maps). Use the
        # global default rather than poison the panel with a wild offset.
        if abs(bx - (-21.5)) > 50 or abs(by - (-75.2)) > 100:
            continue  # don't write — panel will fall back to CELL_OX_DEFAULT
        out[mid] = [bx, by]
    return out


def main():
    if not SRC.exists():
        print(f"source not found: {SRC}")
        return

    bundles = sorted(SRC.glob("mapdata_assets_world_*.bundle"))
    print(f"found {len(bundles)} bundles", flush=True)

    all_offsets: dict[int, list[float]] = {}
    t0 = time.time()
    for i, bp in enumerate(bundles, 1):
        try:
            offs = process_bundle(bp)
            all_offsets.update(offs)
        except Exception as e:
            print(f"  [{i}/{len(bundles)}] {bp.name} FAIL: {str(e)[:120]}", flush=True)
            continue
        if i % 50 == 0 or i == len(bundles):
            print(f"  [{i}/{len(bundles)}] {len(all_offsets)} offsets in {time.time() - t0:.1f}s", flush=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({str(k): v for k, v in sorted(all_offsets.items())},
                              separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {OUT} ({len(all_offsets)} maps, {OUT.stat().st_size // 1024} KB)")

    # Distribution stats so we can pick a good FALLBACK for maps with no interactives.
    if all_offsets:
        oxs = sorted(o[0] for o in all_offsets.values())
        oys = sorted(o[1] for o in all_offsets.values())
        n = len(oxs)
        print(f"\nox: min={oxs[0]:.1f} median={oxs[n//2]:.1f} max={oxs[-1]:.1f}")
        print(f"oy: min={oys[0]:.1f} median={oys[n//2]:.1f} max={oys[-1]:.1f}")


if __name__ == "__main__":
    main()
