"""Quick A/B test: render (4,-19) and (4,-18) tiled, with various FG
strategies to see if the bank roof aligns better when we remove one
of the two maps' FG layers."""
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageEnhance

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util
spec = importlib.util.spec_from_file_location("rmo", str(Path(__file__).resolve().parent / "render-map-offline.py"))
rmo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rmo)

MAP_W, MAP_H = 1204, 860
SCALE = 0.6


def paint(canvas_np, mid, cx, cy, sf, misses, layers=("bg", "sortable", "fg"), clip=True):
    half_w, half_h = MAP_W * sf / 2, MAP_H * sf / 2
    clip_rect = (cx - half_w, cy - half_h, cx + half_w, cy + half_h) if clip else None
    tree = rmo.find_map_data(mid)
    if not tree: return 0
    md = tree.get("mapData") or {}
    refs_by_rid = {}
    for r in (tree.get("references") or {}).get("RefIds") or []:
        if isinstance(r, dict) and r.get("rid") is not None:
            refs_by_rid[r["rid"]] = r
    bg_blends       = rmo.build_blend_table(md.get("backgroundMaterialData") or {}, refs_by_rid)
    sortable_blends = rmo.build_blend_table(md.get("sortableMaterialData") or {}, refs_by_rid)
    fg_blends       = rmo.build_blend_table(md.get("foregroundMaterialData") or {}, refs_by_rid)

    def blend_for(layer_blends, el):
        mi = int(el.get("materialIndex", 0))
        if 0 <= mi < len(layer_blends):
            return layer_blends[mi]
        return (rmo.DEFAULT_BLEND, -1)

    def is_fx_tint(cv):
        r = (cv >> 16) & 0xFF; g = (cv >> 8) & 0xFF; b = cv & 0xFF
        return (max(r,g,b) - min(r,g,b)) > 180

    drawn = 0
    if "bg" in layers:
        for el in md.get("backgroundElements") or []:
            bs, _ = blend_for(bg_blends, el)
            rmo.paste_element(canvas_np, el, cx, cy, {}, blend_spec=bs, sf=sf, clip_rect=clip_rect)
            drawn += 1
    if "sortable" in layers:
        for el in sorted(md.get("sortableElements") or [], key=lambda e: (e.get("cellId", 0), e.get("innerCellRenderOrder", 0))):
            cv = (el.get("color") or {}).get("value", 0xFFFFFFFF) & 0xFFFFFFFF
            if is_fx_tint(cv): continue
            bs, sg = blend_for(sortable_blends, el)
            if sg >= 0 and bs != rmo.DEFAULT_BLEND: continue
            rmo.paste_element(canvas_np, el, cx, cy, {}, blend_spec=bs, sf=sf, clip_rect=clip_rect)
            drawn += 1
    if "fg" in layers:
        for el in md.get("foregroundElements") or []:
            tr = el.get("transform") or {}
            sx, sy = abs(float(tr.get("m11",1))), abs(float(tr.get("m22",1)))
            tx, ty = float(tr.get("m31",0)), float(tr.get("m32",0))
            if sx >= 0.9 and sy >= 0.9 and abs(tx) < 150 and abs(ty) < 150: continue
            bs, sg = blend_for(fg_blends, el)
            if sg >= 0: continue
            # FG no-clip
            rmo.paste_element(canvas_np, el, cx, cy, {}, blend_spec=bs, sf=sf)
            drawn += 1
    return drawn


def render_pair(map_north_id, map_south_id, layers_north, layers_south, out_path):
    cw = int(MAP_W * SCALE)
    ch = int(2 * MAP_H * SCALE)
    canvas = np.zeros((ch, cw, 4), dtype=np.float32)
    canvas[..., 3] = 1.0
    cy_north = MAP_H * SCALE / 2          # north tile center
    cy_south = MAP_H * SCALE + cy_north    # south tile center
    cx = cw / 2
    paint(canvas, map_north_id, cx, cy_north, SCALE, {}, layers=layers_north)
    paint(canvas, map_south_id, cx, cy_south, SCALE, {}, layers=layers_south)
    img = Image.fromarray(np.clip(canvas * 255.0, 0, 255).astype(np.uint8), "RGBA")
    img = ImageEnhance.Color(img).enhance(1.1)
    img = ImageEnhance.Contrast(img).enhance(1.05)
    img.save(out_path, "PNG", optimize=False)
    print(f"saved {out_path} ({out_path.stat().st_size//1024} KB)")


# (4,-19) = 191104000 (north), (4,-18) = 191104002 (south)
N = 191104000
S = 191104002

OUT = Path(__file__).resolve().parent.parent / "data" / "world-region"
render_pair(N, S, ("bg","sortable","fg"), ("bg","sortable","fg"),       OUT / "test_pair_v8_normal.png")
render_pair(N, S, ("bg","sortable"),       ("bg","sortable","fg"),      OUT / "test_pair_no_north_fg.png")
render_pair(N, S, ("bg","sortable","fg"), ("bg","sortable"),            OUT / "test_pair_no_south_fg.png")
