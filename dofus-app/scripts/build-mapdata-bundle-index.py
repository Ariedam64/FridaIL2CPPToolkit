"""Index mapId → source world bundle filename.

extract-mapdata-bundles.py already writes per-map JSONs with cells/etc
but doesn't record which world bundle each map came from. The offline
renderer needs to re-read the full typetree (backgroundElements,
sortableElements, foregroundElements) for a specific mapId, so it needs
to know which bundle to open — scanning 577 bundles per render is
unusable.

Output: dofus-app/data/mapdata-bundle-index.json
  { "<mapId>": "mapdata_assets_world_0.bundle", ... }

Usage: python dofus-app/scripts/build-mapdata-bundle-index.py
"""
import sys, json, time
from pathlib import Path
import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
SRC_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Data")
OUT = APP / "data" / "mapdata-bundle-index.json"


def main():
    if not SRC_DIR.exists():
        print(f"source not found: {SRC_DIR}")
        sys.exit(1)
    bundles = sorted(SRC_DIR.glob("mapdata_assets_world_*.bundle"))
    print(f"found {len(bundles)} mapdata bundles")

    index = {}
    t0 = time.time()
    for i, bp in enumerate(bundles, 1):
        try:
            env = UnityPy.load(str(bp))
        except Exception as e:
            print(f"  [{i}/{len(bundles)}] {bp.name} load FAILED: {str(e)[:120]}")
            continue
        n = 0
        # Container is much faster than iterating all MonoBehaviours — avoids
        # reading each MB's typetree just to learn its name.
        for ab_obj in env.objects:
            if ab_obj.type.name != "AssetBundle":
                continue
            try:
                t = ab_obj.read_typetree()
                for entry in t.get("m_Container") or []:
                    k = entry[0] if isinstance(entry, (list, tuple)) else None
                    if not isinstance(k, str) or not k.startswith("map_"):
                        continue
                    # 'map_154644.asset' → 154644
                    try:
                        mid = int(k[4:].split(".")[0])
                    except ValueError:
                        continue
                    index[mid] = bp.name
                    n += 1
            except Exception:
                continue
        if i % 50 == 0 or i == len(bundles):
            print(f"  [{i}/{len(bundles)}] {bp.name}: +{n} maps ({len(index)} total, {time.time() - t0:.1f}s)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {len(index)} entries to {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
