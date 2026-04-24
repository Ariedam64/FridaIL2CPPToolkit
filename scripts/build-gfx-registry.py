"""Aggregate runtime-captured (cell, typeId, name) into a global gfxId → {typeId, name}
registry, so the panel can label interactives across ALL 17k maps from the
runtime info collected on a few hundred captured maps.

Output: .toolkit-data/catalog/gfx-to-type.json
"""
import json
from pathlib import Path
from collections import Counter

REPO = Path(__file__).resolve().parent.parent
MAPS = REPO / ".toolkit-data" / "maps"
OUT = REPO / ".toolkit-data" / "catalog" / "gfx-to-type.json"

# Multi-vote: a gfxId could be associated with different typeIds across captures
# (rare but possible if visual variants reuse). Pick the most-frequently-seen.
votes: dict[int, Counter] = {}
name_for: dict[int, str] = {}

for f in MAPS.glob("*.json"):
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        continue
    if not d.get("updatedAt"):
        continue
    bundle_ie = {cell: gfx for cell, iid, gfx in (d.get("ie") or [])}
    for it in (d.get("interactives") or []):
        cell = it.get("cell"); tid = it.get("typeId"); name = it.get("name", "")
        gfx = bundle_ie.get(cell)
        if not gfx or tid is None or tid < 0:
            continue
        votes.setdefault(gfx, Counter())[tid] += 1
        if name and tid not in name_for:
            name_for[tid] = name
        elif name:
            # keep first non-empty name we saw for a typeId
            pass

registry: dict[str, dict] = {}
for gfx, counts in votes.items():
    tid, _ = counts.most_common(1)[0]
    registry[str(gfx)] = {
        "typeId": tid,
        "name": name_for.get(tid, ""),
    }

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"learned {len(registry)} gfxId mappings from runtime captures")
print(f"saved: {OUT}")

# Stats: how many of the 17k maps' interactives can be resolved?
total_ie = 0; resolved = 0
for f in MAPS.glob("*.json"):
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        continue
    for cell, iid, gfx in (d.get("ie") or []):
        total_ie += 1
        if str(gfx) in registry:
            resolved += 1
print(f"\ncoverage: {resolved}/{total_ie} interactives ({resolved*100/max(total_ie,1):.1f}%) named via gfxId registry")
