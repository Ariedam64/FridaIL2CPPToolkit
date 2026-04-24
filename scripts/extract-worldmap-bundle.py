"""Extract cartography textures from Dofus worldmap_assets_.bundle.

The bundle holds 1020 Texture2D objects spread across all 35 worldmaps.
Container paths are opaque GUIDs and Addressables catalog parsing is
non-trivial — so we dump everything with an absolute bundle-order index
as the filename prefix. Pairing to a specific worldmap is left to the
caller (compare against in-game eat.dggm via listCartographyTileNames).

Usage: python scripts/extract-worldmap-bundle.py
"""
import sys, time, json
from pathlib import Path

import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

REPO = Path(__file__).resolve().parent.parent
BUNDLE = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Picto\Worldmaps\worldmap_assets_.bundle")
OUT = REPO / ".toolkit-data" / "cartography"
MANIFEST = OUT / "manifest.json"


def main():
    if not BUNDLE.exists():
        print(f"bundle not found: {BUNDLE}")
        sys.exit(1)

    OUT.mkdir(parents=True, exist_ok=True)
    print(f"loading {BUNDLE.stat().st_size / 1024 / 1024:.1f} MB")
    t0 = time.time()
    env = UnityPy.load(str(BUNDLE))
    print(f"  loaded in {time.time() - t0:.1f}s")

    tiles_dir = OUT / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    order = 0
    t1 = time.time()
    for obj in env.objects:
        if obj.type.name != "Texture2D":
            continue
        try:
            data = obj.read()
            img = data.image
            if img is None:
                continue
            # Filename: <6-digit-order>_<name>.jpg — order is absolute bundle
            # position so the same tile has a stable key across runs.
            name = str(data.m_Name)
            safe = "".join(c if c.isalnum() or c in "_-" else "_" for c in name)[:40] or "unnamed"
            fname = f"{order:06d}_{safe}.jpg"
            out_path = tiles_dir / fname
            img.convert("RGB").save(out_path, "JPEG", quality=88)
            manifest.append({
                "order": order,
                "name": name,
                "width": int(data.m_Width),
                "height": int(data.m_Height),
                "file": fname,
            })
            order += 1
        except Exception as e:
            print(f"  skip order={order}: {e}")

    MANIFEST.write_text(json.dumps(manifest), encoding="utf-8")
    print(f"\ndone: {order} tiles in {time.time() - t1:.1f}s")
    print(f"manifest: {MANIFEST}")
    print(f"tiles:    {tiles_dir}")


if __name__ == "__main__":
    main()
