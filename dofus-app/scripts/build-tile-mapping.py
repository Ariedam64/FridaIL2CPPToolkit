"""Build (worldMapId, tileIndex) → bundle file mapping using:

  1. worldmap-addressables.json  (RPC dumpWorldmapAddressables)
     Authoritative [address → GUID] per worldmap, from Unity's loaded
     Addressables catalog.
  2. cartography/manifest.json   (extract-worldmap-bundle.py + build-bundle-index.py)
     Bundle manifest with pathId + guid per tile — GUIDs come from the
     AssetBundle's m_Container table.
  3. wm-tile-names/wm<id>.json   (RPC listCartographyTileNames)
     Runtime-cached tile dims per worldmap (optional, for width/height).

GUIDs match 1:1 between addressables and bundle — the matcher just indexes
by GUID and produces a fully resolved (wm, address, tile_file) mapping.

Output: data/tile-mapping.json — keyed by wmId.
"""
import json
import re
from pathlib import Path
from collections import defaultdict

APP = Path(__file__).resolve().parent.parent
WMNAMES_DIR  = APP / "data" / "wm-tile-names"
MANIFEST     = APP / "data" / "cartography" / "manifest.json"
ADDRESSABLES = APP / "data" / "worldmap-addressables.json"
OUT          = APP / "data" / "tile-mapping.json"


def address_scale_index(addr):
    """Return (scale_str, tile_index) from an address like '0.5/2.jpg' or
    '34/1/5.jpg'. For the worldmap key suffix only the final "<scale>/<n>.jpg"
    form is expected since we stripped the wmId prefix in the RPC."""
    m = re.match(r"^([\d.]+(?:/\d+)?)/(\d+)\.jpg$", addr)
    if not m: return (None, None)
    return (m.group(1), int(m.group(2)))


def main():
    if not MANIFEST.exists():
        print(f"missing {MANIFEST} — run extract-worldmap-bundle.py first")
        return
    if not ADDRESSABLES.exists():
        print(f"missing {ADDRESSABLES} — click DUMP TILE NAMES first")
        return

    bundle = json.loads(MANIFEST.read_text(encoding="utf-8"))
    # GUID → list of bundle files (Texture2D + Sprite share a GUID, so we
    # pick just the Texture2D — identified by having m_Name and the file).
    # The extractor writes one file per Texture2D, so file count == texture
    # count. Multiple GUIDs may map to the same texture if the container
    # lists duplicates — use a list to handle that.
    bundle_by_guid = defaultdict(list)
    for b in bundle:
        g = b.get("guid")
        if g:
            bundle_by_guid[g].append(b)
    print(f"loaded {len(bundle)} bundle tiles ({len(bundle_by_guid)} unique GUIDs)")

    raw = json.loads(ADDRESSABLES.read_text(encoding="utf-8"))
    addressables = raw.get("result", raw)
    wm_dumps = addressables.get("worldmaps", [])
    print(f"loaded addressables: {len(wm_dumps)} worldmaps")

    wm_tiles_by_id = {}
    if WMNAMES_DIR.exists():
        for f in sorted(WMNAMES_DIR.glob("wm*.json")):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                wm_tiles_by_id[d["worldMapId"]] = d["tiles"]
            except Exception: pass
    print(f"loaded {len(wm_tiles_by_id)} runtime wm-tile-names dumps (for dims)")

    out = {}
    per_wm = []
    for wm in wm_dumps:
        wm_id = wm["worldMapId"]
        runtime_dims = {int(t["name"]): (t["width"], t["height"])
                        for t in wm_tiles_by_id.get(wm_id, [])}
        tiles_out = []
        for entry in wm["entries"]:
            addr = entry["address"]
            guid = entry.get("internalId", "")
            scale, idx = address_scale_index(addr)
            candidates = bundle_by_guid.get(guid, [])
            picked = candidates[0] if candidates else None
            w, h = (picked["width"], picked["height"]) if picked else (0, 0)
            if not w or not h:
                dims = runtime_dims.get(idx or 0)
                if dims: w, h = dims
            tiles_out.append({
                "index": (idx - 1) if idx else -1,
                "name": str(idx) if idx else "",
                "scale": scale or "",
                "address": addr,
                "guid": guid,
                "tile": picked["file"] if picked else None,
                "width": int(w or 0),
                "height": int(h or 0),
                "ambiguous": picked is None,
            })
        # Keep a stable order — group by scale then by tile index.
        tiles_out.sort(key=lambda t: (t["scale"], t["index"]))
        out[str(wm_id)] = tiles_out
        matched = sum(1 for t in tiles_out if t["tile"])
        per_wm.append((wm_id, matched, len(tiles_out)))

    OUT.write_text(json.dumps(out, indent=2), encoding="utf-8")
    total_matched = sum(m for _, m, _ in per_wm)
    total = sum(t for _, _, t in per_wm)
    print(f"matched {total_matched}/{total} tiles ({total_matched*100/max(total,1):.1f}%) across {len(out)} worldmaps")
    for wm_id, m, t in sorted(per_wm, key=lambda x: x[0]):
        pct = m * 100 / max(t, 1)
        print(f"  wm={wm_id:>3}  {m:>3}/{t:<3} ({pct:>4.0f}%)")
    print(f"saved: {OUT}")


if __name__ == "__main__":
    main()
