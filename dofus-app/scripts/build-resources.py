"""Build a joined resources catalog: interactive type → matched item → skill → job → itemtype.

Inputs (read-only):
  data/catalog/interactives.json   — typeId → name (Frêne, Ortie, ...)
  data/catalog/items.json          — itemId → iconId, name, typeId, level
  data/catalog/skills.json         — skillId → parentJobId, gatheredResourceItem, levelMin
  data/catalog/jobs.json           — jobId → name
  data/catalog/itemtypes.json      — itemTypeId → name (Bois, Minerai, ...)
  data/gfx-to-type.json            — gfxId → typeId (runtime-captured, ~71 known)
  data/maps/<id>.json              — per-map ie:[[cell,iid,gfx], ...]

Output:
  data/resources.json — flat list, one entry per known interactive typeId:
    {
      typeId, name, sampleGfxId, sampleIconId, isResource,
      jobId, jobName, levelMin,
      itemId, itemName, itemTypeId, itemTypeName,
      count, mapCount
    }

  data/resource-maps.json — typeId → [[mapId, count], ...]  (for the popup
    and the worldmap bubble overlay; sorted by count desc)

Match strategy (typeId → item):
  1. Build the set of "gatherable items" = items referenced by some skill's
     gatheredResourceItem (elementActionId=1). This is the only set we care about.
     ~70 items, eliminates false positives like "Clef de la Maison Fantôme".
  2. For each interactive, match against this gatherable set:
     a. EXACT match (normalized): interactive.name == item.name → win
     b. Token match: interactive.name is a token in item.name (word-boundary)
        → prefer items where it's the LAST token (e.g. "Bois de Frêne")
     c. Otherwise no match — entry emitted with isResource=False (Maison, Zaap, ...).

Run: python dofus-app/scripts/build-resources.py
"""
import json, re, unicodedata
from pathlib import Path
from collections import Counter, defaultdict

APP = Path(__file__).resolve().parent.parent
DATA = APP / "data"
CAT = DATA / "catalog"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def load_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def main():
    interactives = {i["id"]: i for i in load_json(CAT / "interactives.json")["items"]}
    items_all = load_json(CAT / "items.json")["items"]
    items_by_id = {i["id"]: i for i in items_all}
    skills = load_json(CAT / "skills.json")["items"]
    jobs = {j["id"]: j for j in load_json(CAT / "jobs.json")["items"]}
    itemtypes = {t["id"]: t for t in load_json(CAT / "itemtypes.json")["items"]}
    gfx_to_type = load_json(DATA / "gfx-to-type.json")  # {"650": {"typeId": 1, "name": "Frêne"}, ...}

    # Skills indexed by gathered item id (for quick lookup).
    skill_by_item = {}
    for s in skills:
        if s.get("elementActionId") == 1 and s.get("gatheredResourceItem", -1) > 0:
            # If multiple skills target the same item (rare), keep the lowest-level one.
            prev = skill_by_item.get(s["gatheredResourceItem"])
            if prev is None or s.get("levelMin", 999) < prev.get("levelMin", 999):
                skill_by_item[s["gatheredResourceItem"]] = s

    # The only items we care about: ones actually gathered by a skill. ~70 items.
    gatherable_items = [items_by_id[i] for i in skill_by_item if i in items_by_id]
    print(f"loaded: {len(interactives)} interactives, {len(items_all)} items "
          f"({len(gatherable_items)} gatherable-items), {len(skills)} skills, {len(itemtypes)} itemtypes")

    # ----- count instances per typeId across all maps -----
    type_count = Counter()                              # typeId → total instance count
    type_map_counts = defaultdict(Counter)              # typeId → Counter(mapId → count_on_that_map)
    type_gfx = defaultdict(Counter)                     # typeId → Counter(gfxId)
    total_ie = 0
    for f in (DATA / "maps").glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        mid = d.get("mapId")
        if mid is None:
            continue
        # Some captured files stored mapId as a string — coerce so downstream
        # sorts (mixed int/str) don't blow up.
        mid = int(mid)
        for cell, iid, gfx in (d.get("ie") or []):
            total_ie += 1
            entry = gfx_to_type.get(str(gfx))
            if not entry:
                continue
            tid = entry["typeId"]
            type_count[tid] += 1
            type_map_counts[tid][mid] += 1
            type_gfx[tid][gfx] += 1
    print(f"scanned {total_ie} interactive instances across maps; {len(type_count)} typeIds matched")

    # ----- build per-typeId resource entry -----
    out = []
    resource_maps = {}  # typeId → sorted list of mapIds (for popup)
    matched_resource = 0
    matched_only_partial = 0
    for typeId, cnt in sorted(type_count.items(), key=lambda x: -x[1]):
        interactive = interactives.get(typeId)
        if not interactive:
            continue
        iname = interactive["name"]
        iname_norm = norm(iname)

        # Score each gatherable item:
        #   3 = exact match (iname == item name)
        #   2 = iname is the LAST token of item name (e.g. "Bois de Frêne" ↔ "Frêne")
        #   1 = iname is some token of item name
        #   0 = no token match
        # Tie-break: lower level wins (base resource).
        def score(item):
            iname_t = iname_norm
            item_t = norm(item["name"])
            if not iname_t: return 0
            if iname_t == item_t: return 3
            tokens = re.findall(r"[a-z0-9]+", item_t)
            tokens_full = item_t.split()
            if not tokens: return 0
            iname_tokens = re.findall(r"[a-z0-9]+", iname_t)
            # iname (possibly multi-word like "Trèfle à 5 feuilles") must appear
            # as a contiguous suffix of item tokens for last-token match.
            if iname_tokens and tokens[-len(iname_tokens):] == iname_tokens: return 2
            if iname_tokens and all(t in tokens for t in iname_tokens): return 1
            return 0

        scored = [(score(it), it.get("level", 999), it) for it in gatherable_items]
        scored = [s for s in scored if s[0] > 0]
        scored.sort(key=lambda s: (-s[0], s[1]))
        matched_item = scored[0][2] if scored else None

        item_type = itemtypes.get(matched_item.get("typeId")) if matched_item else None
        skill = skill_by_item.get(matched_item["id"]) if matched_item else None
        job = jobs.get(skill.get("parentJobId")) if skill else None

        # Sample gfxId = the most common gfx for this typeId.
        sample_gfx = type_gfx[typeId].most_common(1)[0][0] if type_gfx[typeId] else 0

        is_resource = bool(matched_item)
        if is_resource:
            matched_resource += 1
        elif typeId not in (16, 70, 84, 85, 105, 106, 300, 316):  # zaap, porte, puits, coffre, poubelle, zaapi, maison, panneau
            matched_only_partial += 1

        entry = {
            "typeId": typeId,
            "name": iname,
            "sampleGfxId": sample_gfx,
            "sampleIconId": matched_item["iconId"] if matched_item else 0,
            "isResource": is_resource,
            "jobId": job["id"] if job else 0,
            "jobName": job["name"] if job else "",
            "levelMin": skill.get("levelMin", 0) if skill else 0,
            "itemId": matched_item["id"] if matched_item else 0,
            "itemName": matched_item["name"] if matched_item else "",
            "itemTypeId": matched_item["typeId"] if matched_item else 0,
            "itemTypeName": item_type["name"] if item_type else "",
            "count": cnt,
            "mapCount": len(type_map_counts[typeId]),
        }
        out.append(entry)
        # Sort by per-map count desc (richest maps first), then by mapId for stability.
        resource_maps[str(typeId)] = sorted(
            ([mid, c] for mid, c in type_map_counts[typeId].items()),
            key=lambda x: (-x[1], x[0]),
        )

    print(f"matched as resource: {matched_resource}/{len(out)} "
          f"(unmatched-but-non-static: {matched_only_partial})")

    # Write outputs.
    (DATA / "resources.json").write_text(
        json.dumps({"updatedAt": __import__("datetime").datetime.now().isoformat() + "Z",
                    "totalTypes": len(out), "items": out},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    (DATA / "resource-maps.json").write_text(
        json.dumps(resource_maps, separators=(",", ":")),
        encoding="utf-8")
    print(f"wrote data/resources.json ({len(out)} types)")
    print(f"wrote data/resource-maps.json ({sum(len(v) for v in resource_maps.values())} mapId refs)")

    # Quick stats summary.
    by_job = Counter(e["jobName"] or "(none)" for e in out)
    print("\nbreakdown by job:")
    for job, c in by_job.most_common():
        print(f"  {job:20s} {c:>4d} types")


if __name__ == "__main__":
    main()
