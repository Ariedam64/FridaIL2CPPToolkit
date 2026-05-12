"""Probe a specific map's MapMetadata MonoBehaviour from the Unity bundles.

Dumps the FULL typetree of `mapData` (all keys) and every entry in the
`references.RefIds` SerializeReference table. Use this to diagnose interactives
that the extract script silently drops — typically because they sit in a
mapData field other than `interactiveElements`, or their ref data carries
cellId under a different key.

Usage: python dofus-app/scripts/inspect-map-bundle.py <mapId>
"""
import sys, json
from pathlib import Path

import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
REPO = APP.parent
SRC_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Data")
OUT_DIR = APP / "data" / "_inspect"


def summarize(value, depth=0, max_depth=4):
    """Recursively shrink a typetree value to something printable. Big arrays
    are summarized by length + first item; deep nesting is truncated."""
    if depth > max_depth:
        return "<...>"
    if isinstance(value, dict):
        return {k: summarize(v, depth + 1, max_depth) for k, v in value.items()}
    if isinstance(value, list):
        n = len(value)
        if n == 0:
            return []
        if n > 4:
            return [f"<{n} items>"] + [summarize(value[0], depth + 1, max_depth)]
        return [summarize(v, depth + 1, max_depth) for v in value]
    return value


def main():
    if len(sys.argv) < 2:
        print("usage: inspect-map-bundle.py <mapId>")
        sys.exit(1)
    map_id = int(sys.argv[1])
    target_name = f"map_{map_id}"

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / target_name
    out_path.mkdir(parents=True, exist_ok=True)

    bundles = sorted(SRC_DIR.glob("mapdata_assets_world_*.bundle"))
    print(f"scanning {len(bundles)} bundles for {target_name}...")

    for bp in bundles:
        try:
            env = UnityPy.load(str(bp))
        except Exception as e:
            print(f"  skip {bp.name}: {e}")
            continue
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            try:
                tree = obj.read_typetree()
            except Exception:
                continue
            if str(tree.get("m_Name", "")) != target_name:
                continue
            print(f"found in {bp.name}")

            # Full mapData dump
            md = tree.get("mapData") or {}
            md_full_path = out_path / "mapData_full.json"
            md_full_path.write_text(json.dumps(md, indent=2, default=str), encoding="utf-8")
            print(f"  wrote {md_full_path} ({md_full_path.stat().st_size} bytes)")

            # Just the keys + their shape
            md_keys = {}
            for k, v in md.items():
                if isinstance(v, list):
                    md_keys[k] = f"array[{len(v)}]" + (f" of {type(v[0]).__name__}" if v else "")
                elif isinstance(v, dict):
                    md_keys[k] = f"dict[{len(v)} keys]: {list(v.keys())[:8]}"
                else:
                    md_keys[k] = f"{type(v).__name__}={v!r}"[:80]
            (out_path / "mapData_keys.json").write_text(
                json.dumps(md_keys, indent=2), encoding="utf-8")

            # References table — full dump, every rid with its data
            refs_dump = []
            refs = tree.get("references")
            if isinstance(refs, dict):
                ref_ids = refs.get("RefIds") or []
                for r in ref_ids:
                    rid = r.get("rid") if isinstance(r, dict) else None
                    data = r.get("data") if isinstance(r, dict) else None
                    type_info = r.get("type") if isinstance(r, dict) else None
                    # type_info usually carries class + assembly + namespace
                    cls_name = None
                    if isinstance(type_info, dict):
                        cls_name = type_info.get("class") or type_info.get("m_ClassName")
                    refs_dump.append({
                        "rid": rid,
                        "class": cls_name,
                        "data_keys": list(data.keys()) if isinstance(data, dict) else None,
                        "has_cellId": isinstance(data, dict) and ("cellId" in data),
                        "cellId": data.get("cellId") if isinstance(data, dict) else None,
                        "interactionId": data.get("m_interactionId") if isinstance(data, dict) else None,
                        "gfxId": data.get("gfxId") if isinstance(data, dict) else None,
                    })
            (out_path / "references_summary.json").write_text(
                json.dumps(refs_dump, indent=2, default=str), encoding="utf-8")
            print(f"  wrote references_summary.json ({len(refs_dump)} refs)")

            # Group references by class — easier to spot patterns
            by_class = {}
            for r in refs_dump:
                by_class.setdefault(r.get("class") or "<unknown>", []).append(r["rid"])
            (out_path / "refs_by_class.json").write_text(
                json.dumps({k: {"count": len(v), "rids": v[:10]} for k, v in by_class.items()},
                           indent=2), encoding="utf-8")

            # Cross-ref: which rids does interactiveElements point to, vs which
            # rids are in references but NOT pointed-to (= orphans / handled
            # elsewhere). This is the smoking gun if interactives live in a
            # different mapData field.
            ie_rids = set()
            for e in md.get("interactiveElements") or []:
                rid = e.get("rid") if isinstance(e, dict) else None
                if rid is not None:
                    ie_rids.add(rid)
            all_rids = {r["rid"] for r in refs_dump}
            orphan_rids = sorted(r for r in all_rids if r not in ie_rids and r >= 0)
            # Only the orphans that LOOK LIKE interactives (have cellId)
            orphan_with_cell = [
                r for r in refs_dump
                if r["rid"] in orphan_rids and r["has_cellId"]
            ]
            (out_path / "orphans.json").write_text(
                json.dumps({
                    "interactiveElements_rids": sorted(ie_rids),
                    "orphan_rids_total": len(orphan_rids),
                    "orphans_with_cellId": orphan_with_cell,
                }, indent=2), encoding="utf-8")
            print(f"  interactiveElements points to {len(ie_rids)} rids")
            print(f"  references has {len(all_rids)} rids total")
            print(f"  orphans WITH cellId: {len(orphan_with_cell)}  <-- likely missed interactives")

            return

    print("not found in any bundle")


if __name__ == "__main__":
    main()
