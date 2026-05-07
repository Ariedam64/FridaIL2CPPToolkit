"""Index every Sprite in the mapgfx bundles by its gfxId (m_Name).

Each `mapgfx_1x_<N>_assets_all.bundle` contains ~1300 (Sprite, Texture2D)
pairs where the Sprite's `m_Name` is the integer gfxId referenced from
map data `backgroundElements`/`sortableElements`. Runtime offline map
rendering needs to go from gfxId → (bundle, path_id) fast, without
re-scanning 30 bundles for each sprite.

Output: dofus-app/data/mapgfx-index.json
  { "<gfxId>": { "b": "mapgfx_1x_0_assets_all.bundle", "p": 1234 }, ... }

Usage: python dofus-app/scripts/build-mapgfx-index.py
"""
import sys, json, time
from pathlib import Path
import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
SRC_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Textures\1x")
OUT = APP / "data" / "mapgfx-index.json"


def main():
    if not SRC_DIR.exists():
        print(f"source not found: {SRC_DIR}")
        sys.exit(1)
    bundles = sorted(SRC_DIR.glob("mapgfx_1x_*_assets_all.bundle"))
    print(f"found {len(bundles)} mapgfx bundles")

    index = {}
    total = 0
    t0 = time.time()
    for i, bp in enumerate(bundles, 1):
        try:
            env = UnityPy.load(str(bp))
        except Exception as e:
            print(f"  [{i}/{len(bundles)}] {bp.name} load FAILED: {str(e)[:120]}")
            continue
        n = 0
        for obj in env.objects:
            if obj.type.name != "Sprite":
                continue
            try:
                d = obj.read()
                name = str(d.m_Name)
                gfx = int(name)
            except Exception:
                continue
            # Duplicate gfxIds across bundles are rare; last wins (they should
            # point at equivalent art). We log the count below regardless.
            index[gfx] = {"b": bp.name, "p": int(obj.path_id)}
            n += 1
        total += n
        print(f"  [{i}/{len(bundles)}] {bp.name}: +{n} sprites ({total} total, {time.time() - t0:.1f}s)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {len(index)} entries to {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
