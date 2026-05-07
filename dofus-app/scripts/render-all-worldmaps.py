"""Render every worldmap in the catalog to a single big PNG.

For each wm_id in the catalog:
  1. Compute outdoor bounds (use outdoor-graph if available, else catalog)
  2. Pick the largest scale that keeps canvas under SAFETY_PX_CAP
  3. Run render-region.py via subprocess

Output: dofus-app/data/world-region/wm{N}.png

Usage:
  python dofus-app/scripts/render-all-worldmaps.py
  python dofus-app/scripts/render-all-worldmaps.py --only 1,-1
  python dofus-app/scripts/render-all-worldmaps.py --skip-existing
"""
import sys, json, math, time, argparse, subprocess
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
DATA_DIR = APP / "data"
OUT_DIR = DATA_DIR / "world-region"
RENDER_SCRIPT = Path(__file__).resolve().parent / "render-region.py"

# Per-slot pixel dims at sf=1 (must match render-region.py).
MAP_W_RENDER = 1204
MAP_H_RENDER = 860
# Conservative ceiling — render-region.py rejects > 600 MP. Stay under
# to leave headroom for the per-band accumulator (RGBA float32 = 16B/px).
SAFETY_PX_CAP = 500_000_000


def load_worldmap_bounds():
    """Return { wm_id: (xmin, xmax, ymin, ymax, n_outdoor) } using outdoor-
    graph where available, else catalog-derived bounds."""
    catalog = json.loads((DATA_DIR / "catalog" / "maps.json").read_text(encoding="utf-8"))
    by_wm = {}
    for m in catalog.get("items", []):
        wm = m.get("worldMap")
        if wm is None: continue
        by_wm.setdefault(wm, []).append(m)
    bounds = {}
    for wm, items in by_wm.items():
        graph_file = DATA_DIR / f"outdoor-graph-wm{wm}.json"
        if graph_file.exists():
            try:
                graph = json.loads(graph_file.read_text(encoding="utf-8"))
                coords = [tuple(map(int, k.split(","))) for k in graph.keys()]
                if coords:
                    xs = [c[0] for c in coords]; ys = [c[1] for c in coords]
                    bounds[wm] = (min(xs), max(xs), min(ys), max(ys), len(coords))
                    continue
            except Exception:
                pass
        # Catalog bounds excluding (0,0) bucket (interior dungeons w/o coords).
        xs = [m["posX"] for m in items if not (m["posX"] == 0 and m["posY"] == 0)]
        ys = [m["posY"] for m in items if not (m["posX"] == 0 and m["posY"] == 0)]
        if not xs: xs, ys = [0], [0]
        bounds[wm] = (min(xs), max(xs), min(ys), max(ys), len(items))
    return bounds


def best_scale(cols, rows):
    """Pick the largest scale ≤ 0.5 such that canvas pixels ≤ SAFETY_PX_CAP."""
    raw = math.sqrt(SAFETY_PX_CAP / (cols * rows * MAP_W_RENDER * MAP_H_RENDER))
    return min(0.5, max(0.10, round(raw, 2)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=str, default=None,
                    help="comma-separated worldmap IDs to render (default: all)")
    ap.add_argument("--skip-existing", action="store_true",
                    help="skip wms whose output PNG already exists")
    ap.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()

    only_set = None
    if args.only:
        only_set = set(int(x.strip()) for x in args.only.split(","))

    bounds = load_worldmap_bounds()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Plan ordered by map count so big ones render first (parallelism /
    # nothing — but we keep the most important results visible early).
    plan = sorted(bounds.items(), key=lambda kv: -kv[1][4])

    for wm, (x0, x1, y0, y1, n) in plan:
        if only_set is not None and wm not in only_set: continue
        out_path = OUT_DIR / f"wm{wm}.png"
        if args.skip_existing and out_path.exists():
            print(f"[skip] wm={wm} (already exists)", flush=True)
            continue
        cols = x1 - x0 + 1
        rows = y1 - y0 + 1
        sf = best_scale(cols, rows)
        cw = int(round(cols * MAP_W_RENDER * sf))
        ch = int(round(rows * MAP_H_RENDER * sf))
        print(f"\n[wm={wm}] {n} maps | x[{x0},{x1}] y[{y0},{y1}] = {cols}x{rows} | "
              f"scale {sf} -> {cw}x{ch} = {cw*ch//1_000_000} MP", flush=True)
        t0 = time.time()
        cmd = [
            sys.executable, str(RENDER_SCRIPT),
            "--wm", str(wm),
            "--x", f"{x0},{x1}",
            "--y", f"{y0},{y1}",
            "--scale", str(sf),
            "--workers", str(args.workers),
            "--out", str(out_path),
        ]
        try:
            subprocess.run(cmd, check=True)
        except subprocess.CalledProcessError as e:
            print(f"[wm={wm}] FAILED: {e}", flush=True)
            continue
        dt = time.time() - t0
        print(f"[wm={wm}] DONE in {dt/60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
