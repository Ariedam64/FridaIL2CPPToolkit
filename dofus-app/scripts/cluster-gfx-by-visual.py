"""Cluster gfxIds by visual metadata from mapelements_assets_.bundle to test
whether visual-metadata clustering can propagate runtime-captured
(gfxId -> typeId) mappings to never-visited variants (cave/dungeon).

Source bundle:
  F:/Jeux/Dofus-dofus3/Dofus_Data/StreamingAssets/Content/Map/Data/
    mapelements_assets_.bundle

  Contains one MonoBehaviour `elements` with m_elementsMap = SerializedDictionary
  <int, ElementData>. m_elementsMap.m_keys: [int]; m_elementsMap.m_values: [{rid}].
  Actual ElementData lives in references.RefIds[*].data, keyed by rid.

  ElementData fields used here:
    m_id, m_type, m_gfxId, m_height,
    m_horizontalSymmetry, m_origin{x,y}, m_size{x,y}.

Hypothesis being tested:
  gfxIds with identical (m_type, m_size, m_origin, m_horizontalSymmetry)
  are visual variants of the same resource type. So one runtime-known
  (gfxId -> typeId) mapping in such a cluster propagates to all members.

We try three clustering schemes:
  STRICT : (m_type, m_size.x, m_size.y, m_origin.x, m_origin.y, m_horizontalSymmetry)
  LOOSE_A: (m_size.x, m_size.y) only
  LOOSE_B: (m_size.x // 5, m_size.y // 5) bucketed sizes

Outputs:
  - prints summary tables per scheme + cave-iron diagnostic
  - writes data/gfx-to-type-proposed.json with the STRICT-scheme proposed
    new mappings (does NOT touch the runtime data/gfx-to-type.json)
"""
import json
import sys
from collections import defaultdict, Counter
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
BUNDLE = Path(
    r"F:/Jeux/Dofus-dofus3/Dofus_Data/StreamingAssets/Content/Map/Data/"
    r"mapelements_assets_.bundle"
)
GFX_TO_TYPE = APP / "data" / "gfx-to-type.json"
OUT_PROPOSED = APP / "data" / "gfx-to-type-proposed.json"


# ----------------------------------------------------------------------------
# 1. Load bundle and expand m_elementsMap into a flat list of ElementData.
# ----------------------------------------------------------------------------
def load_elements() -> list[dict]:
    print(f"[load] reading {BUNDLE}", flush=True)
    env = UnityPy.load(str(BUNDLE))

    target_tree = None
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        if str(tree.get("m_Name", "")) == "elements":
            target_tree = tree
            break
    if target_tree is None:
        print("[load] FATAL: no MonoBehaviour named 'elements' found", file=sys.stderr)
        sys.exit(2)

    # rid -> data dict.
    refs_by_rid: dict[int, dict] = {}
    for r in (target_tree.get("references") or {}).get("RefIds") or []:
        if isinstance(r, dict) and r.get("rid") is not None:
            refs_by_rid[r["rid"]] = r.get("data") or {}

    em = target_tree.get("m_elementsMap") or {}
    keys = em.get("m_keys") or []
    values = em.get("m_values") or []
    print(f"[load] m_elementsMap: {len(keys)} keys, {len(values)} values, "
          f"{len(refs_by_rid)} refs", flush=True)

    elements: list[dict] = []
    skipped_no_ref = 0
    for k, v in zip(keys, values):
        rid = v.get("rid") if isinstance(v, dict) else None
        if rid is None or rid not in refs_by_rid:
            skipped_no_ref += 1
            continue
        d = refs_by_rid[rid]
        try:
            origin = d.get("m_origin") or {}
            size = d.get("m_size") or {}
            elements.append({
                "key": int(k),
                "m_id": int(d.get("m_id", k)),
                "m_type": int(d.get("m_type", 0)),
                "m_gfxId": int(d.get("m_gfxId", -1)),
                "m_height": int(d.get("m_height", 0)),
                "m_hsym": int(d.get("m_horizontalSymmetry", 0)),
                "ox": int(origin.get("x", 0)),
                "oy": int(origin.get("y", 0)),
                "sx": int(size.get("x", 0)),
                "sy": int(size.get("y", 0)),
            })
        except Exception as e:
            skipped_no_ref += 1
            continue
    print(f"[load] expanded {len(elements)} elements ({skipped_no_ref} skipped)",
          flush=True)
    return elements


# ----------------------------------------------------------------------------
# 2. Cluster elements by a key function.
# ----------------------------------------------------------------------------
def cluster_by(elements: list[dict], keyfn) -> dict:
    out: dict = defaultdict(list)
    for e in elements:
        out[keyfn(e)].append(e)
    return out


def evaluate_scheme(name: str, clusters: dict, gfx_to_type: dict[str, dict]) -> dict:
    """Return a stats dict + the proposed mapping (gfxId -> typeId)."""
    cluster_sizes = [len(v) for v in clusters.values()]
    cluster_sizes.sort(reverse=True)
    proposed: dict[int, dict] = {}
    propagable_clusters = 0
    conflict_clusters = 0
    new_mappings = 0
    impactful = []  # (cluster_size, typeId, sample_size, new_count, sample_gfx)
    conflicts: list[tuple] = []

    for ckey, members in clusters.items():
        gfx_in_cluster = sorted({m["m_gfxId"] for m in members
                                 if m["m_gfxId"] >= 0})
        if not gfx_in_cluster:
            continue

        # Find runtime-known typeIds within this cluster.
        known: dict[int, dict] = {}  # gfxId -> {typeId, name}
        for g in gfx_in_cluster:
            info = gfx_to_type.get(str(g))
            if info is not None:
                known[g] = info
        if not known:
            continue

        # Conflict detection.
        type_set = {info["typeId"] for info in known.values()}
        if len(type_set) > 1:
            conflict_clusters += 1
            conflicts.append((ckey, dict(known)))
            # Don't propagate.
            continue

        propagable_clusters += 1
        chosen = next(iter(known.values()))
        type_id = chosen["typeId"]
        new_for_cluster = 0
        for g in gfx_in_cluster:
            if str(g) in gfx_to_type:
                continue
            if g in proposed:
                # Already proposed by another (overlapping) cluster — pick the
                # first (won't happen for STRICT, can for LOOSE).
                continue
            proposed[g] = {
                "typeId": type_id,
                "name": chosen.get("name", ""),
                "via": ckey,
            }
            new_for_cluster += 1
            new_mappings += 1
        sample = next((m for m in members if m["m_gfxId"] in gfx_in_cluster), None)
        impactful.append((
            len(gfx_in_cluster),
            type_id,
            chosen.get("name", ""),
            (sample["sx"], sample["sy"]) if sample else None,
            new_for_cluster,
            gfx_in_cluster[:5],
        ))

    impactful.sort(key=lambda t: -t[4])

    print(f"\n=== {name} ===")
    print(f"  total clusters       : {len(clusters)}")
    if cluster_sizes:
        print(f"  cluster size dist    : "
              f"max={cluster_sizes[0]}, "
              f"p90={cluster_sizes[max(0,len(cluster_sizes)//10)]}, "
              f"median={cluster_sizes[len(cluster_sizes)//2]}, "
              f"singletons={sum(1 for s in cluster_sizes if s == 1)}")
    print(f"  propagable clusters  : {propagable_clusters}")
    print(f"  conflict clusters    : {conflict_clusters} "
          f"(scheme says different typeIds for same cluster)")
    print(f"  NEW mappings gained  : {new_mappings} "
          f"(over {len(gfx_to_type)} known)")
    if conflicts:
        rate = conflict_clusters / max(1, propagable_clusters + conflict_clusters)
        print(f"  conflict rate        : {rate*100:.1f}% "
              f"of clusters that have any known mapping")

    print(f"  top 10 impactful clusters (size / typeId / name / sample size / "
          f"new gfxIds / first gfxIds):")
    for row in impactful[:10]:
        size, tid, name_, samp_size, new_count, sample_gfx = row
        print(f"    cluster_size={size:4d}  typeId={tid:4d}  "
              f"name={name_!r:30s}  sprite={samp_size}  "
              f"NEW={new_count:4d}  e.g. {sample_gfx}")

    if conflicts:
        print(f"  first 5 conflict clusters:")
        for ckey, kn in conflicts[:5]:
            preview = ", ".join(f"gfx={g} -> typeId={i['typeId']} "
                                f"({i.get('name','')})" for g, i in kn.items())
            print(f"    key={ckey} | {preview}")
    return {
        "name": name,
        "clusters": len(clusters),
        "propagable": propagable_clusters,
        "conflicts": conflict_clusters,
        "new_mappings": new_mappings,
        "proposed": proposed,
        "impactful": impactful,
    }


# ----------------------------------------------------------------------------
# Cave-iron diagnostic.
# ----------------------------------------------------------------------------
def cave_iron_check(elements: list[dict], clusters_strict: dict, keyfn,
                    gfx_to_type: dict[str, dict]) -> None:
    print("\n=== CAVE-IRON DIAGNOSTIC ===")
    target_gfx = 63849  # cave iron variant (per task description)
    by_gfx = defaultdict(list)
    for e in elements:
        by_gfx[e["m_gfxId"]].append(e)

    # Locate the cluster containing 63849.
    found_key = None
    for k, members in clusters_strict.items():
        for m in members:
            if m["m_gfxId"] == target_gfx:
                found_key = k
                break
        if found_key is not None:
            break

    if found_key is None:
        print(f"  gfxId {target_gfx} not present in m_elementsMap at all")
        # Still check 4918 and known cave variants.
    else:
        members = clusters_strict[found_key]
        print(f"  gfxId {target_gfx} cluster key = {found_key}")
        print(f"  cluster contains {len(members)} elements "
              f"({len({m['m_gfxId'] for m in members})} unique gfxIds)")
        unique_gfx = sorted({m["m_gfxId"] for m in members})
        for g in unique_gfx:
            samples = [m for m in members if m["m_gfxId"] == g]
            mid = samples[0]["m_id"]
            in_runtime = gfx_to_type.get(str(g))
            tag = f"runtime-known typeId={in_runtime['typeId']} ({in_runtime.get('name','')})" \
                if in_runtime else "(unknown)"
            print(f"    gfxId={g:6d}  m_id={mid:6d}  count={len(samples):3d}  {tag}")

    # Check surface iron.
    surface_gfx = 4918
    surf_records = by_gfx.get(surface_gfx, [])
    if not surf_records:
        print(f"  WARNING: surface iron gfxId {surface_gfx} not present in "
              f"m_elementsMap at all -- cluster comparison impossible")
    else:
        e0 = surf_records[0]
        surf_key = keyfn(e0)
        print(f"  surface iron gfxId {surface_gfx} (m_id={e0['m_id']}) cluster key = {surf_key}")
        if found_key is not None and surf_key != found_key:
            print("  ** HYPOTHESIS PARTIAL FAILURE **: surface iron and cave iron")
            print("     are in DIFFERENT strict clusters. Their (size, origin, hsym, type)")
            print("     differ:")
            print(f"       cave 63849 (m_id={by_gfx[target_gfx][0]['m_id']}): {found_key}")
            print(f"       surface 4918 (m_id={e0['m_id']}): {surf_key}")
            print("     Strict clustering will NOT propagate surface iron's typeId=17")
            print("     onto the cave iron variants. They have to share at least the")
            print("     same cluster *or* runtime mapping must already cover one cave variant.")
        elif found_key is not None:
            print("  GOOD: surface and cave iron are in the same strict cluster.")


# ----------------------------------------------------------------------------
# Main.
# ----------------------------------------------------------------------------
def main() -> None:
    elements = load_elements()
    if not elements:
        print("[main] no elements loaded", file=sys.stderr); sys.exit(2)

    # Quick raw stats.
    types = Counter(e["m_type"] for e in elements)
    print(f"[stats] m_type distribution: "
          f"{dict(sorted(types.items())[:20])}{'...' if len(types) > 20 else ''}",
          flush=True)
    unique_gfx = {e["m_gfxId"] for e in elements}
    print(f"[stats] unique gfxIds in mapelements: {len(unique_gfx)}", flush=True)

    # Load runtime-known mappings.
    gfx_to_type = json.loads(GFX_TO_TYPE.read_text(encoding="utf-8"))
    print(f"[stats] runtime gfx-to-type entries: {len(gfx_to_type)}", flush=True)
    runtime_in_bundle = sum(1 for g in unique_gfx if str(g) in gfx_to_type)
    print(f"[stats] runtime entries that ARE in mapelements: {runtime_in_bundle}",
          flush=True)

    # ---- STRICT scheme.
    def key_strict(e):
        return (e["m_type"], e["sx"], e["sy"], e["ox"], e["oy"], e["m_hsym"])

    cl_strict = cluster_by(elements, key_strict)
    res_strict = evaluate_scheme("STRICT (type, size, origin, hsym)",
                                 cl_strict, gfx_to_type)

    # Cave iron diagnostic on STRICT only.
    cave_iron_check(elements, cl_strict, key_strict, gfx_to_type)

    # ---- LOOSE_A: size only.
    def key_loose_a(e):
        return (e["sx"], e["sy"])

    cl_loose_a = cluster_by(elements, key_loose_a)
    res_loose_a = evaluate_scheme("LOOSE_A (size only)", cl_loose_a, gfx_to_type)

    # ---- LOOSE_B: bucketed size.
    def key_loose_b(e):
        return (e["sx"] // 5, e["sy"] // 5)

    cl_loose_b = cluster_by(elements, key_loose_b)
    res_loose_b = evaluate_scheme("LOOSE_B (size // 5)", cl_loose_b, gfx_to_type)

    # ---- Final summary table.
    print("\n=== SUMMARY TABLE ===")
    print(f"{'scheme':<36}  {'clusters':>9}  {'propag':>7}  {'confl':>6}  {'NEW':>6}")
    for r in (res_strict, res_loose_a, res_loose_b):
        print(f"{r['name']:<36}  {r['clusters']:>9}  {r['propagable']:>7}  "
              f"{r['conflicts']:>6}  {r['new_mappings']:>6}")

    # ---- Write proposed file. We bundle all 3 schemes side-by-side so the
    # caller can choose. STRICT yields 0 here (because every known gfxId is
    # a singleton cluster), so the useful data is in LOOSE_A / LOOSE_B.
    def serialize(scheme_res):
        out = {}
        for g, info in scheme_res["proposed"].items():
            out[str(g)] = {
                "typeId": info["typeId"],
                "name": info["name"],
            }
        return out

    bundle = {
        "_schema": "Proposed gfxId -> typeId mappings derived from "
                   "mapelements_assets_.bundle visual clustering. NOT runtime-"
                   "verified. STRICT is empty by design (known gfxIds are mostly "
                   "singletons). LOOSE_A is conservative (exact size match). "
                   "LOOSE_B is aggressive (size bucketed by 5px).",
        "strict": serialize(res_strict),
        "loose_a_size_exact": serialize(res_loose_a),
        "loose_b_size_bucketed": serialize(res_loose_b),
    }
    OUT_PROPOSED.parent.mkdir(parents=True, exist_ok=True)
    OUT_PROPOSED.write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n[out] wrote proposals (strict={len(bundle['strict'])}, "
          f"loose_a={len(bundle['loose_a_size_exact'])}, "
          f"loose_b={len(bundle['loose_b_size_bucketed'])}) -> {OUT_PROPOSED}")


if __name__ == "__main__":
    main()
