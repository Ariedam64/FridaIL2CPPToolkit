"""Build a smart coverage plan that maximizes gfxId/cluster coverage per visit.

The world panel's RUN COVERAGE PLAN orchestrator reads `data/coverage-plan.json`
and walks the player to each map via Dofus's native autopilot, capturing the
runtime-resolved interactive typeIds at every stop. Each new map visited grows
`data/gfx-to-type.json` (via `build-gfx-registry.py` after the run).

This script generates the plan greedily:
  1. Load every `data/maps/<id>.json` and its bundle-extracted `ie:[[cell,iid,gfx]]`
  2. Drop maps that already have runtime captures (`updatedAt` set) — already covered.
  3. For each remaining map, compute the SET OF UNMAPPED gfxIds it would resolve.
  4. CLUSTER unmapped gfxIds via `mapelements_assets_.bundle` visual metadata
     (m_size + m_origin + m_horizontalSymmetry tuple). Same cluster = same physical
     prop with sprite variants. Once one cluster member is captured, the others
     can be inferred via cluster-membership (see cluster-gfx-by-visual.py).
  5. Greedy pick: each iteration, choose the map adding the MOST NEW clusters.
     Skip maps whose contribution drops below MIN_NEW_CLUSTERS.
  6. Optional: prefer wm=1 (more reachable via autopilot) early in the order,
     push wm=-1 caves to later batches.

Output: `data/coverage-plan.json`
  {
    "note": "...",
    "generatedAt": "...",
    "stats": {
      "totalMaps": N, "alreadyCaptured": M, "unmappedClusters": K,
      "planSize": P, "expectedNewClusters": Q
    },
    "maps": [{ order, mapId, posX, posY, worldMap, subArea, name,
                newClusters, unmappedGfx, sampleGfx }, ...]
  }

Run: python dofus-app/scripts/build-coverage-plan.py
     python dofus-app/scripts/build-coverage-plan.py --max 80 --min-new 1
     python dofus-app/scripts/build-coverage-plan.py --caves-only   # wm=-1 maps + cave subareas
     python dofus-app/scripts/build-coverage-plan.py --include-captured  # don't skip visited
"""
import argparse
import datetime
import json
from collections import defaultdict, Counter
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
DATA = APP / "data"
CAT = DATA / "catalog"
MAPS_DIR = DATA / "maps"
MAPELEMENTS_BUNDLE = Path(
    r"F:/Jeux/Dofus-dofus3/Dofus_Data/StreamingAssets/Content/Map/Data/mapelements_assets_.bundle"
)
OUT = DATA / "coverage-plan.json"

# Subarea name keywords that hint at "cave / dungeon / underground" — the wm=-1
# maps live here and are the most likely source of UNKNOWN gfxIds (cave
# variants of surface resources). Used by --caves-only to filter.
CAVE_KEYWORDS = (
    "cave", "caves", "souterrain", "souterrains", "mine", "mines",
    "donjon", "égout", "egout", "crypte", "tombeau", "grotte", "grottes",
)


def load_clusters() -> dict[int, tuple]:
    """Returns {gfxId: cluster_key}. Cluster key = (m_size_x, m_size_y, m_origin_x,
    m_origin_y, m_horizontalSymmetry). Same cluster = visual variants of the same
    physical prop. m_type is intentionally NOT in the key — variants of the same
    sprite sometimes flip categories (decorative vs interactive) but keep the
    same silhouette/anchor."""
    print(f"loading mapelements bundle…")
    env = UnityPy.load(str(MAPELEMENTS_BUNDLE))
    out: dict[int, tuple] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        if str(tree.get("m_Name", "")) != "elements":
            continue
        em = tree.get("m_elementsMap", {})
        keys = em.get("m_keys", [])
        vals = em.get("m_values", [])
        refs = {r["rid"]: r.get("data", {})
                for r in (tree.get("references") or {}).get("RefIds", [])
                if isinstance(r, dict) and r.get("rid") is not None}
        for k, v in zip(keys, vals):
            rid = v.get("rid") if isinstance(v, dict) else None
            d = refs.get(rid) if rid is not None else None
            if not isinstance(d, dict):
                continue
            gfx = d.get("m_gfxId")
            if not gfx:
                continue
            sz = d.get("m_size") or {}
            org = d.get("m_origin") or {}
            key = (sz.get("x", 0), sz.get("y", 0),
                   org.get("x", 0), org.get("y", 0),
                   d.get("m_horizontalSymmetry", 0))
            # Multiple m_ids may share the same gfxId — first wins, they share key anyway.
            out.setdefault(int(gfx), key)
        break
    print(f"  {len(out)} gfxIds clustered into {len(set(out.values()))} clusters")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max", type=int, default=99999,
                        help="max plan size (default 99999 = unlimited; min-new threshold stops earlier)")
    parser.add_argument("--min-new", type=int, default=1,
                        help="stop when next-best map adds fewer than N new clusters (default 1)")
    parser.add_argument("--caves-only", action="store_true",
                        help="restrict to wm=-1 + cave-named subareas")
    parser.add_argument("--include-captured", action="store_true",
                        help="don't skip maps that already have runtime captures")
    parser.add_argument("--prefer-wm1", action="store_true", default=True,
                        help="put wm=1 maps before wm=-1 in the order (default on)")
    parser.add_argument("--max-hop", type=int, default=5,
                        help="max Manhattan distance per consecutive hop (default 5). "
                             "Longer hops are densified by inserting waypoint maps from the "
                             "outdoor catalog. Set to 999 to disable.")
    parser.add_argument("--start-x", type=int, default=0,
                        help="player's current x at plan execution start (default 0 = Astrub area)")
    parser.add_argument("--start-y", type=int, default=0,
                        help="player's current y at plan execution start (default 0)")
    parser.add_argument("--exclude-subareas", type=str, default="",
                        help="comma-separated subarea IDs to EXCLUDE (e.g. 25,537,538 for Wabbit)")
    parser.add_argument("--only-subareas", type=str, default="",
                        help="comma-separated subarea IDs to RESTRICT to (mutually exclusive with exclude)")
    parser.add_argument("--exclude-wabbit", action="store_true",
                        help="shortcut: exclude all Wabbit subareas (25 Souterrains, 537 Château, 538 Terrier)")
    parser.add_argument("--wabbit-only", action="store_true",
                        help="shortcut: only Wabbit subareas (25, 537, 538)")
    parser.add_argument("--out", type=str, default="",
                        help="override output filename (default coverage-plan.json)")
    args = parser.parse_args()

    WABBIT_SUBAREAS = {25, 537, 538}
    excluded_ids: set[int] = set()
    only_ids: set[int] = set()
    if args.exclude_wabbit:
        excluded_ids |= WABBIT_SUBAREAS
    if args.wabbit_only:
        only_ids |= WABBIT_SUBAREAS
    if args.exclude_subareas.strip():
        excluded_ids |= {int(x) for x in args.exclude_subareas.split(",") if x.strip()}
    if args.only_subareas.strip():
        only_ids |= {int(x) for x in args.only_subareas.split(",") if x.strip()}
    if excluded_ids and only_ids:
        print("WARNING: both --exclude and --only specified; only-set takes precedence")

    # ----- Load static data -----
    maps = json.loads((CAT / "maps.json").read_text(encoding="utf-8"))["items"]
    subareas = {s["id"]: s for s in json.loads((CAT / "subareas.json").read_text(encoding="utf-8"))["items"]}
    by_mid = {m["id"]: m for m in maps}
    gfx_to_type = json.loads((DATA / "gfx-to-type.json").read_text(encoding="utf-8"))
    known_gfx = set(int(g) for g in gfx_to_type.keys())

    # ----- Load mapelements clusters -----
    if not MAPELEMENTS_BUNDLE.exists():
        print(f"WARNING: mapelements bundle not found at {MAPELEMENTS_BUNDLE}")
        print(f"  → falling back to per-gfxId scoring (no cluster dedup)")
        cluster_of: dict[int, tuple] = {}
    else:
        cluster_of = load_clusters()

    def gfx_cluster(gfx: int):
        # If a gfxId is missing from the bundle (e.g. surface ores), use the gfxId
        # itself as a singleton cluster. Worst case: one map per missing gfx (no
        # dedup) but still correct.
        return cluster_of.get(gfx, ("solo", gfx))

    # Cluster every KNOWN gfxId so we can mark its cluster as "already covered"
    # before planning starts.
    known_clusters = {gfx_cluster(g) for g in known_gfx}
    print(f"runtime gfx-to-type knows {len(known_gfx)} gfxIds across {len(known_clusters)} clusters")

    # ----- Build per-map "what would visiting this map contribute" -----
    map_payload = []  # (map, set of NEW clusters this map could resolve)
    # ----- Filter out non-autopilot-able subareas -----
    # Subareas with level=0 are special instances/admin maps (Prison, Base des
    # Justiciers, Mode tactique, Cartes de combat, Havres-Sacs, Halls de guilde,
    # Résidences, etc.). They're "on" wm=1 but NOT walking-reachable from outdoor
    # maps. Including them in the plan = guaranteed bbd reject + cache pollution.
    UNREACHABLE_SUBAREA_IDS = {s["id"] for s in subareas.values() if s.get("level", 0) == 0}
    print(f"filtering out {len(UNREACHABLE_SUBAREA_IDS)} non-autopilot-able subareas (level=0 = instances/special)")
    # NOTE: we deliberately do NOT filter on `hasPriorityOnWorldmap` here even
    # though the field is now extracted. Interior/transition maps share coords
    # with their outdoor twin but contain DIFFERENT interactives (NPCs, furniture,
    # shop props) — skipping them = losing capture data. The orchestrator's
    # runtime probe handles unreachable targets cleanly (next map). The flag
    # is used by `findMapIdByCoords` for the manual Travel(x,y) picker, which
    # IS a one-map-per-coord problem.

    captured_count = 0
    skipped_unreachable_subarea = 0
    for f in MAPS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        mid = d.get("mapId")
        m = by_mid.get(mid)
        if not m:
            continue

        # Hard exclude: instance/admin maps
        if m["subAreaId"] in UNREACHABLE_SUBAREA_IDS:
            skipped_unreachable_subarea += 1
            continue

        # CLI exclude/only filters (Wabbit, custom subareas).
        if only_ids and m["subAreaId"] not in only_ids:
            continue
        if excluded_ids and m["subAreaId"] in excluded_ids:
            continue

        if args.caves_only:
            sa = subareas.get(m["subAreaId"], {})
            sa_name_lower = (sa.get("name") or "").lower()
            is_cave_sub = any(k in sa_name_lower for k in CAVE_KEYWORDS)
            if m["worldMap"] != -1 and not is_cave_sub:
                continue

        # Already captured (runtime payload merged in)?
        if d.get("updatedAt") and not args.include_captured:
            captured_count += 1
            continue

        ies = d.get("ie", [])
        if not ies:
            continue

        unmapped_gfx = {gfx for _, _, gfx in ies if gfx not in known_gfx}
        if not unmapped_gfx:
            continue

        # Reduce to clusters — visiting any one of these clusters suffices to
        # learn the typeId for every member.
        new_clusters = {gfx_cluster(g) for g in unmapped_gfx} - known_clusters
        if not new_clusters:
            continue

        map_payload.append({
            "mapId": mid, "posX": m["posX"], "posY": m["posY"],
            "worldMap": m["worldMap"], "subAreaId": m["subAreaId"],
            "subArea": (subareas.get(m["subAreaId"], {}).get("name") or ""),
            "name": m.get("name", ""),
            "unmappedGfx": sorted(unmapped_gfx),
            "newClusters": new_clusters,
        })

    print(f"candidate maps: {len(map_payload)}  "
          f"(skipped: {captured_count} already-captured, {skipped_unreachable_subarea} in instance/admin subareas)")
    if not map_payload:
        print("nothing to plan — all known interactives already mapped or no candidates after filter")
        return

    # ----- Greedy selection -----
    # Each iteration: pick the map adding the most NEW clusters that aren't
    # already covered by previously picked maps. wm=1 wins ties (more reachable).
    covered: set = set()
    plan = []
    remaining = map_payload.copy()

    def sort_key(p):
        contribution = len(p["newClusters"] - covered)
        # Prefer wm=1 over wm=-1 (more autopilot-reachable). Within same wm,
        # prefer maps closer to (0,0) — Astrub area, well-traveled.
        wm_pref = 0 if (args.prefer_wm1 and p["worldMap"] == 1) else 1
        dist = abs(p["posX"]) + abs(p["posY"])
        # negative contribution → max first; then wm=1 first; then closer to origin.
        return (-contribution, wm_pref, dist)

    while len(plan) < args.max and remaining:
        remaining.sort(key=sort_key)
        best = remaining[0]
        new_for_this = best["newClusters"] - covered
        if len(new_for_this) < args.min_new:
            print(f"stopping: next-best map only adds {len(new_for_this)} new clusters "
                  f"(threshold {args.min_new})")
            break
        plan.append(best)
        covered |= new_for_this
        remaining.pop(0)
        # Drop maps whose entire contribution was already covered.
        remaining = [p for p in remaining if (p["newClusters"] - covered)]

    # ----- Order via greedy nearest-neighbor TSP -----
    # Start from the player's actual current position (override via --start-x/y).
    # At each step, hop to the nearest remaining capture target. Cost = Manhattan
    # within same worldmap; cross-wm hops penalized so same-wm maps batch
    # together (one zaap warp per batch instead of zigzagging).
    WM_CHANGE_PENALTY = 1000

    def cost(a: dict, b: dict) -> int:
        if a["worldMap"] != b["worldMap"]:
            return WM_CHANGE_PENALTY
        return abs(a["posX"] - b["posX"]) + abs(a["posY"] - b["posY"])

    remaining = list(plan)
    ordered: list[dict] = []
    current = {"posX": args.start_x, "posY": args.start_y,
               "worldMap": 1 if args.prefer_wm1 else -1}
    while remaining:
        nxt = min(remaining, key=lambda p: cost(current, p))
        ordered.append(nxt)
        remaining.remove(nxt)
        current = nxt
    plan = ordered

    # ----- Densify: insert BRIDGE waypoints based on real worldgraph reachability -----
    # Replaces the old "Manhattan grid BFS" densifier (which assumed any map at
    # adjacent coords was a valid waypoint, blind to the actual edge graph).
    # Now we load the dumped worldgraph adjacency (via /api/worldgraph or the
    # reachability checker UI) and insert ONLY waypoints W such that
    # `is_reachable(prev → W)` AND `is_reachable(W → target)` — both proven
    # reachable per the game's actual edges. Targets non-reachable even with
    # bridges are dropped (with a log line) — the runner would silent-reject
    # them and corrupt the worldgraph state otherwise.
    wg_path = DATA / "worldgraph-adjacency.json"
    if wg_path.exists():
        wg = json.loads(wg_path.read_text(encoding="utf-8"))
        adj_raw = wg.get("adjacency", {})
        uid_to_mid_raw = wg.get("uidToMapId", {})
        if not uid_to_mid_raw:
            print("WARNING: worldgraph-adjacency.json is in old format (no uidToMapId) — re-dump via the reachability checker REFRESH button")
            wg = None
        else:
            adj = {int(k): v for k, v in adj_raw.items()}
            uid_to_mid = {int(k): v for k, v in uid_to_mid_raw.items()}
            mid_to_uids: dict[int, list[int]] = defaultdict(list)
            for uid, mid in uid_to_mid.items():
                mid_to_uids[mid].append(uid)
            # Reverse adjacency for "what maps can reach this one" queries
            from collections import defaultdict as _dd
            reverse_adj: dict[int, list[int]] = _dd(list)
            for src_uid, dests in adj.items():
                for d in dests:
                    reverse_adj[d].append(src_uid)

            def is_reachable_mid(src_mid: int, dst_mid: int, max_hops: int = 40) -> bool:
                if src_mid == dst_mid:
                    return True
                start_uids = mid_to_uids.get(src_mid, [])
                if not start_uids:
                    return False
                visited = {src_mid}
                frontier = list(start_uids)
                for _ in range(max_hops):
                    if not frontier:
                        return False
                    next_frontier = []
                    for uid in frontier:
                        for d in adj.get(uid, []):
                            dm = uid_to_mid.get(d)
                            if not dm or dm in visited:
                                continue
                            if dm == dst_mid:
                                return True
                            visited.add(dm)
                            next_frontier.extend(mid_to_uids.get(dm, []))
                    frontier = next_frontier
                return False

            def reachable_set_from(src_mid: int, max_hops: int = 25) -> set[int]:
                visited = {src_mid}
                frontier = list(mid_to_uids.get(src_mid, []))
                for _ in range(max_hops):
                    if not frontier:
                        break
                    nxt = []
                    for uid in frontier:
                        for d in adj.get(uid, []):
                            dm = uid_to_mid.get(d)
                            if not dm or dm in visited:
                                continue
                            visited.add(dm)
                            nxt.extend(mid_to_uids.get(dm, []))
                    frontier = nxt
                return visited

            def reachable_set_to(dst_mid: int, max_hops: int = 25) -> set[int]:
                visited = {dst_mid}
                frontier = list(mid_to_uids.get(dst_mid, []))
                for _ in range(max_hops):
                    if not frontier:
                        break
                    nxt = []
                    for uid in frontier:
                        for s in reverse_adj.get(uid, []):
                            sm = uid_to_mid.get(s)
                            if not sm or sm in visited:
                                continue
                            visited.add(sm)
                            nxt.extend(mid_to_uids.get(sm, []))
                    frontier = nxt
                return visited

            def find_bridge_waypoint(a_mid: int, b_mid: int) -> dict | None:
                """W such that A→W reachable AND W→B reachable. Picks the
                candidate closest to B geographically (Manhattan)."""
                r_from_a = reachable_set_from(a_mid, 20)
                r_to_b = reachable_set_to(b_mid, 20)
                bridges = (r_from_a & r_to_b) - {a_mid, b_mid}
                if not bridges:
                    return None
                b_meta = by_mid.get(b_mid, {})
                bx, by = b_meta.get("posX", 0), b_meta.get("posY", 0)
                # Filter to known reachable subarea (level>0, not Wabbit-excluded)
                ok_bridges = []
                for w_mid in bridges:
                    w = by_mid.get(w_mid)
                    if not w or w["subAreaId"] in UNREACHABLE_SUBAREA_IDS:
                        continue
                    if excluded_ids and w["subAreaId"] in excluded_ids:
                        continue
                    ok_bridges.append((abs(w["posX"] - bx) + abs(w["posY"] - by), w))
                if not ok_bridges:
                    return None
                ok_bridges.sort(key=lambda kv: kv[0])
                return ok_bridges[0][1]

            # No waypoint insertion (user requested "no +0gfx maps in queue").
            # We only USE the worldgraph for diagnostics: log how many targets
            # are walking-reachable from the previous target vs need a zaap
            # (zaaps are NOT in the worldgraph dump — only walking edges).
            # The agent-side BFS pre-check in autoTravelInstant will skip
            # genuinely-isolated targets at runtime; zaap-required targets
            # rely on the game pathfinder to handle them naturally.
            walk_reachable = 0
            walk_unreachable = 0
            cur_mid: int | None = None
            for p in plan:
                target_mid = p["mapId"]
                if cur_mid is not None:
                    if is_reachable_mid(cur_mid, target_mid):
                        walk_reachable += 1
                    else:
                        walk_unreachable += 1
                cur_mid = target_mid
            print(f"reachability stats: {walk_reachable} targets walking-reachable from previous, {walk_unreachable} need zaap (worldgraph BFS, ignores zaaps)")
    else:
        print(f"WARNING: {wg_path} not found — densification skipped")
        print(f"         (open the reachability checker UI and click REFRESH to dump the worldgraph)")

    for i, p in enumerate(plan, 1):
        p["order"] = i

    # Quick travel-cost stats for the chosen order — useful sanity check.
    total_dist = 0
    max_hop_seen = 0
    long_hops = 0
    wm_changes = 0
    prev = {"posX": args.start_x, "posY": args.start_y,
            "worldMap": 1 if args.prefer_wm1 else -1}
    for p in plan:
        if prev["worldMap"] != p["worldMap"]:
            wm_changes += 1
        else:
            d = abs(prev["posX"] - p["posX"]) + abs(prev["posY"] - p["posY"])
            total_dist += d
            max_hop_seen = max(max_hop_seen, d)
            if d > args.max_hop: long_hops += 1
        prev = p
    print(f"order: {wm_changes} cross-wm hops, {total_dist} cells walked total "
          f"(avg {total_dist // max(1, len(plan))} cells/map, "
          f"max-hop seen={max_hop_seen}, hops > {args.max_hop}: {long_hops})")

    # ----- Stats + write -----
    out_maps = []
    for p in plan:
        entry = {
            "order": p["order"], "mapId": p["mapId"],
            "posX": p["posX"], "posY": p["posY"], "worldMap": p["worldMap"],
            "subArea": p["subArea"], "name": p["name"],
            "newClusters": len(p["newClusters"]),
            "unmappedGfx": len(p["unmappedGfx"]),
            "sampleGfx": p["unmappedGfx"][:6] if isinstance(p["unmappedGfx"], list) else [],
        }
        if p.get("isWaypoint"):
            entry["isWaypoint"] = True
        out_maps.append(entry)
    body = {
        "note": ("Auto-generated coverage plan — greedy by NEW clusters per visit. "
                 + ("Caves/dungeons only. " if args.caves_only else "")
                 + f"max={args.max} min-new={args.min_new}"),
        "generatedAt": datetime.datetime.now().isoformat() + "Z",
        "stats": {
            "totalCandidates": len(map_payload),
            "alreadyCaptured": captured_count,
            "totalUnmappedClusters": len({c for p in map_payload for c in p["newClusters"]}),
            "planSize": len(plan),
            "expectedNewClusters": len(covered),
        },
        "maps": out_maps,
    }
    out_path = (DATA / args.out) if args.out else OUT
    out_path.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nwrote {out_path}")
    print(f"  plan: {len(plan)} maps - expected {len(covered)} new clusters")
    print(f"  wm distribution: {Counter(p['worldMap'] for p in plan)}")
    print(f"  subarea top-5: {Counter(p['subArea'] for p in plan).most_common(5)}")


if __name__ == "__main__":
    main()
