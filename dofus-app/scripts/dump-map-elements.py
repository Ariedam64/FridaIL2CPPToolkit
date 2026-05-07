"""Dump a map's full element list (per layer, with index, gfxId, transform,
color, etc.) to JSON so the UI editor can show + checkbox-skip them.

Output: dofus-app/data/map-elements/<mapId>.json
"""
import sys, json
from pathlib import Path

import importlib.util
RMO_PATH = Path(__file__).resolve().parent / "render-map-offline.py"
spec = importlib.util.spec_from_file_location("rmo", str(RMO_PATH))
rmo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rmo)

APP = Path(__file__).resolve().parent.parent
OUT_DIR = APP / "data" / "map-elements"


def main():
    if len(sys.argv) < 2:
        print("usage: dump-map-elements.py <mapId>", file=sys.stderr); sys.exit(1)
    map_id = int(sys.argv[1])
    tree = rmo.find_map_data(map_id)
    if tree is None:
        print(json.dumps({"ok": False, "reason": f"map {map_id} not found"})); sys.exit(2)
    md = tree.get("mapData") or {}

    def serialize(layer_name, layer_list):
        out = []
        for i, el in enumerate(layer_list or []):
            tr = el.get("transform") or {}
            color = el.get("color") or {}
            out.append({
                "layer": layer_name,
                "index": i,
                "gfxId": el.get("gfxId"),
                "m11": tr.get("m11", 1), "m12": tr.get("m12", 0),
                "m21": tr.get("m21", 0), "m22": tr.get("m22", 1),
                "m31": tr.get("m31", 0), "m32": tr.get("m32", 0),
                "color": color.get("value", 0xFFFFFFFF),
                "materialIndex": el.get("materialIndex", 0),
                "cellId": el.get("cellId"),
                "innerCellRenderOrder": el.get("innerCellRenderOrder"),
            })
        return out

    elements = (
        serialize("bg",       md.get("backgroundElements"))
        + serialize("sortable", md.get("sortableElements"))
        + serialize("fg",       md.get("foregroundElements"))
    )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{map_id}.json"
    out_path.write_text(json.dumps({"mapId": map_id, "elements": elements},
                                   separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"ok": True, "mapId": map_id, "count": len(elements),
                      "out": str(out_path)}))


if __name__ == "__main__":
    main()
