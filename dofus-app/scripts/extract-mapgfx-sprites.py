"""One-time sprite extraction: walk every mapgfx_1x_*_assets_all.bundle,
decode every Sprite, write to dofus-app/data/sprites/<gfxId>.png + a
sidecar JSON with the pivot (we lose Sprite metadata when we go to a
flat PNG).

This is the prerequisite for fast batch rendering. Once done, the
offline renderer reads small PNG files instead of holding UnityPy bundle
state + DXT-decoded textures in RAM. Render-time RAM drops from
~1-1.5 GB/worker to ~100-200 MB/worker, eliminating the OOM/swap
death-spiral that made 4-worker prerender slower than single-thread.

Disk cost: ~63k PNGs ≈ 3-5 GB. Single bundle is processed at a time so
extract itself never holds more than ~80 MB of bundle state.

Usage: python dofus-app/scripts/extract-mapgfx-sprites.py
       python dofus-app/scripts/extract-mapgfx-sprites.py --force
"""
import sys, json, time, argparse
from pathlib import Path
import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
SRC_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Textures\1x")
OUT_DIR = APP / "data" / "sprites"
META_FILE = APP / "data" / "sprite-meta.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-extract even if PNG already exists")
    args = ap.parse_args()

    if not SRC_DIR.exists():
        print(f"source not found: {SRC_DIR}", file=sys.stderr); sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bundles = sorted(SRC_DIR.glob("mapgfx_1x_*_assets_all.bundle"))
    print(f"found {len(bundles)} mapgfx bundles, target {OUT_DIR}")

    meta = {}
    if META_FILE.exists() and not args.force:
        try: meta = json.loads(META_FILE.read_text(encoding="utf-8"))
        except Exception: meta = {}
        print(f"loaded {len(meta)} pre-existing meta entries")

    total_new, total_seen, t0 = 0, 0, time.time()
    for i, bp in enumerate(bundles, 1):
        try:
            env = UnityPy.load(str(bp))
        except Exception as e:
            print(f"  [{i}/{len(bundles)}] {bp.name}: load FAILED {e}"); continue
        new_in_bundle = 0
        for obj in env.objects:
            if obj.type.name != "Sprite": continue
            try:
                d = obj.read()
                gfx = int(str(d.m_Name))
            except Exception:
                continue
            total_seen += 1
            out_path = OUT_DIR / f"{gfx}.png"
            # Skip the heavy decode + write if we've already got this sprite,
            # unless --force. Cheap path: just read pivot from cached meta.
            if out_path.exists() and str(gfx) in meta and not args.force:
                continue
            try:
                img = d.image
                if img is None: continue
                img = img.convert("RGBA")
                # Unity Sprite.pivot is normalised 0-1, Y up. We store
                # both the pivot and dimensions so the renderer doesn't
                # need to re-open the PNG just to find sprite size.
                px = py = 0.5
                try:
                    pv = getattr(d, "m_Pivot", None) or getattr(d, "pivot", None)
                    if pv is not None:
                        px = float(pv.X if hasattr(pv, "X") else pv.x)
                        py = float(pv.Y if hasattr(pv, "Y") else pv.y)
                except Exception:
                    pass
                meta[str(gfx)] = {"px": px, "py": py, "w": img.width, "h": img.height}
                # optimize=False — save speed beats file-size at extraction
                # time; PNG is already compressed, optimize gains a few %
                # but slows the write 5-10×.
                img.save(out_path, "PNG", optimize=False)
                new_in_bundle += 1
                total_new += 1
            except Exception:
                pass
        # Free the bundle's decoded data — UnityPy keeps refs to decoded
        # textures inside the env until it goes out of scope.
        env = None
        if i % 5 == 0 or i == len(bundles):
            elapsed = time.time() - t0
            rate = total_seen / elapsed if elapsed > 0 else 0
            print(f"  [{i}/{len(bundles)}] {bp.name}: +{new_in_bundle} new ({total_new} total new, {total_seen} seen, {rate:.0f}/s, {elapsed:.0f}s)")

    META_FILE.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    print(f"\nDONE — {total_new} sprites extracted in {time.time() - t0:.0f}s, meta has {len(meta)} entries ({META_FILE.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
