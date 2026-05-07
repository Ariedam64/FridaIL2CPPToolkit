"""Build a flat-maps coverage plan optimised for set-cover greedy at runtime.

The runtime (panels/coverage.ts) does:
  1. captured = set(knownGfx)
  2. Each iteration: score(map) = |map.gfxIds - captured|
  3. Pick the map with the highest score (tie-break: same subarea as player,
     then Manhattan distance from current map). Travel + capture. captured
     gets unioned with map.gfxIds. Remove from pool.
  4. Repeat until no map has score > 0 OR all are tried.

This script just dumps the raw "map → gfxIds it covers" relation, restricted to
maps that:
  - are on wm in {1, -1}
  - have subarea.level > 0 (skip instances/admin)
  - have at least one unmapped gfxId in their `ie` payload

The greedy logic is intentionally NOT pre-computed here because it depends on
the player's current position and the runtime captured set — a frozen plan
would invalidate after the first capture.

Output: data/resource-plan.json
  {
    "generatedAt": "...",
    "stats": { totalMaps, totalGfxToCapture, knownGfx, ... },
    "knownGfx": [ ... ],            # gfxIds the runtime should start with
    "maps": [
      { mapId, posX, posY, wm, subAreaId, subArea, outdoor, priority,
        gfxIds: [g1, g2, ...] },
      ...
    ]
  }

Run: python dofus-app/scripts/build-resource-plan.py
"""
import datetime
import json
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
DATA = APP / "data"
CAT = DATA / "catalog"
MAPS_DIR = DATA / "maps"
OUT = DATA / "resource-plan.json"


def main():
    maps_raw = json.loads((CAT / "maps.json").read_text(encoding="utf-8"))
    maps = maps_raw["items"] if isinstance(maps_raw, dict) else maps_raw
    by_mid = {m["id"]: m for m in maps}

    subs_raw = json.loads((CAT / "subareas.json").read_text(encoding="utf-8"))
    subs = {s["id"]: s for s in (subs_raw["items"] if isinstance(subs_raw, dict) else subs_raw)}

    known_gfx = set(int(k) for k in
                    json.loads((DATA / "gfx-to-type.json").read_text(encoding="utf-8")).keys())
    print(f"known gfx: {len(known_gfx)}")

    UNREACHABLE = {sid for sid, s in subs.items() if s.get("level", 0) == 0}
    print(f"hard-excluded subareas (level=0): {len(UNREACHABLE)}")

    # Event-only zones (Nowel = Xmas, Vulkania = summer) accessible only
    # during their event window. Filter by both subarea NAME and AREA name —
    # "Archipel de Vulkania" is an area containing 13 subareas with cryptic
    # names ("Cratère Pillar", "Lantamaï", "Kohrog"...) that don't carry the
    # keyword themselves.
    areas_raw = json.loads((CAT / "areas.json").read_text(encoding="utf-8"))
    areas = {a["id"]: a for a in (areas_raw["items"] if isinstance(areas_raw, dict) else areas_raw)}
    EVENT_KEYWORDS = ("nowel", "vulkania")
    EVENT_SUBAREAS = set()
    for sid, s in subs.items():
        sname = str(s.get("name", "")).lower()
        aname = str(areas.get(s.get("areaId", -1), {}).get("name", "")).lower()
        if any(k in sname for k in EVENT_KEYWORDS) or any(k in aname for k in EVENT_KEYWORDS):
            EVENT_SUBAREAS.add(sid)
    UNREACHABLE |= EVENT_SUBAREAS
    print(f"event-locked subareas excluded ({len(EVENT_SUBAREAS)}): "
          f"{sorted(subs[sid]['name'] for sid in EVENT_SUBAREAS)}")

    out_maps = []
    skipped_wm = skipped_sub = skipped_no_unmapped = no_ie = 0
    all_unmapped_gfxs = set()

    for f in MAPS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        mid = d.get("mapId")
        if mid is None:
            continue
        m = by_mid.get(mid)
        if not m:
            continue
        if m.get("worldMap") not in (1, -1):
            skipped_wm += 1
            continue
        if m.get("subAreaId") in UNREACHABLE:
            skipped_sub += 1
            continue
        ies = d.get("ie", [])
        if not ies:
            no_ie += 1
            continue
        # gfxIds present on the map (deduped). Even if a gfx is already captured
        # we keep it: the runtime needs the FULL set so its captured-after-visit
        # bookkeeping works (capturing this map adds ALL its gfx to captured,
        # which lets future entries see them as already-known).
        gfxs = sorted({int(g) for _, _, g in ies})
        # But if NONE of them are unmapped, this map contributes nothing.
        unmapped_here = [g for g in gfxs if g not in known_gfx]
        if not unmapped_here:
            skipped_no_unmapped += 1
            continue
        all_unmapped_gfxs.update(unmapped_here)
        sa = subs.get(m["subAreaId"], {})
        out_maps.append({
            "mapId": int(mid),
            "posX": m["posX"],
            "posY": m["posY"],
            "wm": m.get("worldMap"),
            "subAreaId": m["subAreaId"],
            "subArea": sa.get("name") or "",
            "outdoor": bool(m.get("outdoor")),
            "priority": bool(m.get("hasPriorityOnWorldmap")),
            "gfxIds": gfxs,
        })

    # Compute gfxCount: how many candidate maps contain each gfxId. Used by
    # the runtime to weight score = sum of mapCount(g) for unmapped g on map.
    # Maps containing many high-popularity gfxs rank higher → "common
    # interactables first" sort.
    gfx_count: dict[int, int] = {}
    for mp in out_maps:
        for g in mp["gfxIds"]:
            gfx_count[g] = gfx_count.get(g, 0) + 1

    # Static initial sort: weighted score (sum of gfx popularity for unmapped).
    out_maps.sort(key=lambda mp: (
        -sum(gfx_count.get(g, 1) for g in mp["gfxIds"] if g not in known_gfx),
        mp["subAreaId"],
        mp["mapId"],
    ))

    out = {
        "generatedAt": datetime.datetime.now(datetime.UTC).isoformat(),
        "stats": {
            "totalMaps": len(out_maps),
            "totalGfxToCapture": len(all_unmapped_gfxs),
            "knownGfx": len(known_gfx),
            "skipped": {
                "wmNotPlayable": skipped_wm,
                "subareaLevel0": skipped_sub,
                "noInteractives": no_ie,
                "noUnmappedGfx": skipped_no_unmapped,
            },
        },
        "knownGfx": sorted(known_gfx),
        # gfxId → how many candidate maps contain it. Runtime uses this to
        # weight the greedy score so common gfxs are prioritised.
        "gfxCount": gfx_count,
        "maps": out_maps,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"\nwrote {OUT}")
    print(f"  candidate maps: {len(out_maps)}")
    print(f"  unique gfxIds to capture: {len(all_unmapped_gfxs)}")
    if out_maps:
        top = out_maps[:5]
        print("  top 5 by initial score:")
        for mp in top:
            new = sum(1 for g in mp["gfxIds"] if g not in known_gfx)
            print(f"    {mp['mapId']:>10}  ({mp['posX']:>3},{mp['posY']:>3}) wm={mp['wm']:>2}  +{new:>3} new gfx  {mp['subArea'][:30]}")


if __name__ == "__main__":
    main()
