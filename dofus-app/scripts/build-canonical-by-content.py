"""Build canonical (posX, posY) -> mapId map by analysing actual rendered
preview content (brightness + green ratio), not just metadata heuristics.

For each coord with multiple maps, we score each candidate's preview PNG
(v2 if present, else v1) and pick the one that looks most outdoor:

  score = mean_brightness + green_ratio*30 + (10 if v2 exists else 0)

This catches the "Îlot des Tombeaux" vs "Îlot de la Couronne" type case
where two outdoor-named subareas share a coord but one map is actually a
cave interior — the cave one has dark mean RGB, the outdoor one has
visible greens.

Output: data/canonical-coords-wm<N>.json
        { "x,y": mapId, ... }

Usage:
  python dofus-app/scripts/build-canonical-by-content.py
  python dofus-app/scripts/build-canonical-by-content.py --wm 1
"""
import sys, json, time, argparse
from pathlib import Path
from collections import defaultdict
import multiprocessing as mp
import numpy as np
from PIL import Image

APP = Path(__file__).resolve().parent.parent
DATA = APP / "data"
CATALOG = DATA / "catalog" / "maps.json"
V2_DIR = DATA / "maps-preview-v2"
V1_DIR = DATA / "maps-preview"


def score_one(map_id: int):
    """Returns (map_id, score, has_v2). score = -1 if no preview at all."""
    p = V2_DIR / f"{map_id}.png"
    has_v2 = p.exists()
    if not has_v2:
        p = V1_DIR / f"{map_id}.png"
        if not p.exists():
            return (map_id, -1.0, False)
    try:
        im = np.asarray(Image.open(p).convert("RGB"))
    except Exception:
        return (map_id, -1.0, has_v2)
    r = im[:, :, 0].astype(np.float32)
    g = im[:, :, 1].astype(np.float32)
    mean_brightness = float(im.mean())
    green_ratio = float((g > r + 20).mean())  # 0..1
    score = mean_brightness + green_ratio * 30.0 + (10.0 if has_v2 else 0.0)
    return (map_id, score, has_v2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wm", type=int, default=None,
                    help="restrict to one worldmap (default: all)")
    ap.add_argument("--workers", type=int, default=max(1, mp.cpu_count() - 2))
    args = ap.parse_args()

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    items = catalog.get("items", [])

    # Group catalog maps by (wm, posX, posY).
    by_coord: dict = defaultdict(list)
    for m in items:
        wm = m.get("worldMap")
        if wm is None: continue
        if args.wm is not None and wm != args.wm: continue
        if m["posX"] == 0 and m["posY"] == 0:
            # (0,0) bucket of orphan dungeons — skip the whole thing for
            # big worldmaps. For small wms (0,0) might be a real coord
            # but usually still a dump bucket. Easier to skip uniformly.
            continue
        by_coord[(wm, m["posX"], m["posY"])].append(m["id"])

    # Collect every map_id we'll need to score (deduped).
    all_ids = set()
    for ids in by_coord.values():
        all_ids.update(ids)
    print(f"[canonical] {len(by_coord)} coords across {len(all_ids)} candidate mapIds | workers={args.workers}", flush=True)

    # Parallel score.
    t0 = time.time()
    scores: dict = {}
    with mp.Pool(args.workers) as pool:
        done = 0
        total = len(all_ids)
        for (mid, sc, has_v2) in pool.imap_unordered(score_one, all_ids, chunksize=64):
            scores[mid] = (sc, has_v2)
            done += 1
            if done % 1000 == 0 or done == total:
                print(f"  scored {done}/{total} ({(time.time()-t0):.0f}s)", flush=True)

    # Pick canonical per coord.
    by_wm: dict = defaultdict(dict)
    no_preview = 0
    for (wm, x, y), ids in by_coord.items():
        scored = [(mid, *scores.get(mid, (-1.0, False))) for mid in ids]
        # Sort: highest score first, tie-break by lowest mapId for stability.
        scored.sort(key=lambda t: (-t[1], t[0]))
        best_id, best_sc, best_v2 = scored[0]
        if best_sc < 0:
            no_preview += 1
            continue
        by_wm[wm][f"{x},{y}"] = best_id

    print(f"[canonical] picked canonicals for {sum(len(v) for v in by_wm.values())} coords "
          f"({no_preview} skipped — no preview at all)", flush=True)

    DATA.mkdir(exist_ok=True, parents=True)
    for wm, mapping in by_wm.items():
        out = DATA / f"canonical-coords-wm{wm}.json"
        out.write_text(json.dumps(mapping, separators=(",", ":")), encoding="utf-8")
        print(f"  wrote {out} ({len(mapping)} coords, {out.stat().st_size//1024} KB)", flush=True)


if __name__ == "__main__":
    main()
