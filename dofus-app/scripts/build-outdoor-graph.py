"""Build the canonical (posX, posY) -> mapId table for the outdoor world.

Why: many coords on wm=1 host MULTIPLE mapIds — the regular outdoor map
plus event/temple/instance variants ("Temple des Douze" at (6,-19),
"Planque des Vilinsekts" at (6,-15), tournament copies, etc.). When
rendering a continuous worldmap, we must pick the OUTDOOR-CONNECTED
version. Cheap heuristics (subarea size, nameId==0) get most cases
right but miss tied ties.

Approach: BFS from a seed mapId via each map's [top, bot, left, right]
neighbour pointers. The connected component IS the navigable outdoor
world — alt/event maps aren't reachable by walking, so they get
naturally excluded.

Output: data/outdoor-graph-wm<N>.json
  { "(posX,posY)": mapId, ... }

Usage:
  python dofus-app/scripts/build-outdoor-graph.py            # seed = Astrub (3,-19)
  python dofus-app/scripts/build-outdoor-graph.py --seed 191102976
"""
import sys, json, argparse, time
from pathlib import Path
from collections import deque

APP = Path(__file__).resolve().parent.parent
DATA = APP / "data"
MAPS_DIR = DATA / "maps"
CATALOG = DATA / "catalog" / "maps.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=191102976,
                    help="seed mapId (default = Astrub Cité 3,-19 wm=1)")
    ap.add_argument("--out",  type=str, default=None)
    args = ap.parse_args()

    # Load catalog: {mapId: {posX, posY, worldMap}}.
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    info = {m["id"]: m for m in cat["items"]}
    seed = args.seed
    if seed not in info:
        print(f"seed {seed} not in catalog", file=sys.stderr); sys.exit(1)
    seed_wm = info[seed]["worldMap"]
    print(f"[graph] seed={seed} ({info[seed]['posX']},{info[seed]['posY']}) wm={seed_wm}")

    # BFS via per-map JSON's "n" = [top, bot, left, right] neighbour ids.
    visited = set()
    queue = deque([seed])
    by_coord = {}
    misses = 0
    skipped_other_wm = 0
    t0 = time.time()
    while queue:
        mid = queue.popleft()
        if mid in visited or mid <= 0:
            continue
        visited.add(mid)
        m_info = info.get(mid)
        if not m_info:
            misses += 1; continue
        # Cross-world links exist (Incarnam <-> Monde des Douze via portals).
        # We constrain to the seed's worldMap so the graph is the outdoor
        # world we actually care about.
        if m_info.get("worldMap") != seed_wm:
            skipped_other_wm += 1; continue

        f = MAPS_DIR / f"{mid}.json"
        if not f.exists():
            misses += 1; continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            misses += 1; continue
        n = data.get("n") or []
        if not n:
            continue

        coord = (m_info["posX"], m_info["posY"])
        # First wins per coord — BFS spreads from seed, so the FIRST map
        # claiming a coord is the one closest in walking distance to the
        # seed: that's necessarily the outdoor-connected one. Any later
        # map at the same coord (reached via a teleport-like link) is the
        # alt-version we want to skip.
        if coord not in by_coord:
            by_coord[coord] = mid

        for nid in n:
            if nid > 0 and nid not in visited:
                queue.append(nid)

    elapsed = time.time() - t0
    print(f"[graph] visited {len(visited)} maps in {elapsed:.0f}s "
          f"(coords: {len(by_coord)}, misses: {misses}, "
          f"skipped wm!={seed_wm}: {skipped_other_wm})")

    out = {f"{x},{y}": mid for (x, y), mid in by_coord.items()}
    out_path = Path(args.out) if args.out else (DATA / f"outdoor-graph-wm{seed_wm}.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"[graph] wrote {out_path} ({out_path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
