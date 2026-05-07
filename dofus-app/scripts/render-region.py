"""Render a contiguous worldmap region as ONE seamless image (no per-map
seams, no decoration duplicates).

Each map is painted into a SHARED canvas at its slot position
(MAP_W_RENDER, MAP_H_RENDER world-units = pixels per map). Per-map
clip_rect ensures decorations bleeding past a map's slot don't overwrite
neighbours' content during the painter loop.

Multi-process: --workers N splits the Y range into N bands; each worker
renders its band independently (per-map clipping ensures no cross-band
content) and writes a strip PNG. Main stitches them vertically.

Usage:
  python dofus-app/scripts/render-region.py --wm 1 --x 2,7 --y -22,-15
  python dofus-app/scripts/render-region.py --wm 1 --x -4,13 --y -31,0 --scale 0.3 --workers 5

Output:
  data/world-region/<wm>[_<x0>-<x1>_<y0>-<y1>]_s<scale>.png
"""
import sys, json, time, argparse, os, math
from pathlib import Path
import multiprocessing as mp
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

import importlib.util
RMO_PATH = Path(__file__).resolve().parent / "render-map-offline.py"

# Worker-local module references — populated lazily on first call so the
# spawn() child process incurs the UnityPy import cost once and reuses
# UnityPy's bundle/sprite caches across all maps in its band.
_rmo = None


def _get_rmo():
    global _rmo
    if _rmo is None:
        spec = importlib.util.spec_from_file_location("rmo", str(RMO_PATH))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _rmo = m
    return _rmo


APP = Path(__file__).resolve().parent.parent
DATA_DIR = APP / "data"
CATALOG_FILE = DATA_DIR / "catalog" / "maps.json"
OUT_DIR = DATA_DIR / "world-region"
TMP_DIR = OUT_DIR / "_chunks"

# In-game frame measured via Frida hook on the live Dofus client.
# 1 Dofus world-unit = 1 screen pixel at 1080p. A map's iso play grid
# is 14 cols x 40 rows; standard cell = 86 wide, 43 tall. So tileable
# extents:
#   width  = 14 * 86  = 1204 px
#   height = 40 * 21.5 = 860 px (offset iso, half cell per row)
MAP_W_RENDER = 1204
MAP_H_RENDER = 860


def load_maps(wm_id: int):
    data = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    return [m for m in data.get("items", []) if m.get("worldMap") == wm_id]


def load_outdoor_graph(wm_id: int):
    """Returns dict { "posX,posY": mapId } of the canonical outdoor-
    connected map per coord, built by build-outdoor-graph.py via BFS
    through neighbour pointers. Empty dict if no graph file exists —
    caller falls back to heuristic dedup."""
    f = DATA_DIR / f"outdoor-graph-wm{wm_id}.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_render_overrides() -> dict:
    """Returns dict { mapId(str): { skip_indices: {layer: [i,i,...]}, skip_gfx_ids: [g,g,...] } }
    for manual element-skipping rules. Used by render-region.py to honour
    user-flagged "skip these elements" choices made via the world panel
    editor. Empty dict if no override file exists."""
    f = DATA_DIR / "render-overrides.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {}


def paint_map_into(canvas_np, map_id: int,
                   cx_canvas: float, cy_canvas: float,
                   sf: float, misses: dict) -> int:
    """Paint one map's bg → sortable → fg layers into the shared canvas
    at the given canvas-coord center, with element transforms scaled by
    sf and clipped to the map's slot rect (so this map's elements can't
    bleed into neighbour slots).
    """
    rmo = _get_rmo()
    half_w = MAP_W_RENDER * sf / 2
    half_h = MAP_H_RENDER * sf / 2
    clip_rect = (cx_canvas - half_w, cy_canvas - half_h,
                 cx_canvas + half_w, cy_canvas + half_h)
    tree = rmo.find_map_data(map_id)
    if tree is None:
        return 0
    md = tree.get("mapData") or {}
    bg = md.get("backgroundElements") or []
    sortable = md.get("sortableElements") or []
    fg = md.get("foregroundElements") or []

    refs_by_rid = {}
    for r in (tree.get("references") or {}).get("RefIds") or []:
        if isinstance(r, dict) and r.get("rid") is not None:
            refs_by_rid[r["rid"]] = r
    bg_blends       = rmo.build_blend_table(md.get("backgroundMaterialData") or {}, refs_by_rid)
    sortable_blends = rmo.build_blend_table(md.get("sortableMaterialData") or {},   refs_by_rid)
    fg_blends       = rmo.build_blend_table(md.get("foregroundMaterialData") or {}, refs_by_rid)

    def blend_for(layer_blends, el):
        mi = int(el.get("materialIndex", 0))
        if 0 <= mi < len(layer_blends):
            return layer_blends[mi]
        return (rmo.DEFAULT_BLEND, -1)

    def is_special_fx_tint(col_val: int) -> bool:
        r = (col_val >> 16) & 0xFF
        g = (col_val >>  8) & 0xFF
        b =  col_val        & 0xFF
        return (max(r, g, b) - min(r, g, b)) > 180

    drawn = 0
    for el in bg:
        bs, _ = blend_for(bg_blends, el)
        rmo.paste_element(canvas_np, el, cx_canvas, cy_canvas, misses, blend_spec=bs, sf=sf, clip_rect=clip_rect)
        drawn += 1

    for el in sorted(sortable, key=lambda e: (e.get("cellId", 0), e.get("innerCellRenderOrder", 0))):
        col = el.get("color") or {}
        try:
            cv = int(col.get("value", 0xFFFFFFFF)) & 0xFFFFFFFF
        except Exception:
            cv = 0xFFFFFFFF
        if is_special_fx_tint(cv):
            continue
        bs, shader_gfx = blend_for(sortable_blends, el)
        if shader_gfx >= 0 and bs != rmo.DEFAULT_BLEND:
            continue
        # Sortable layer = building bodies, trees, decorations. Big buildings
        # often extend past the slot — clipping cuts the body. Use no-clip
        # like FG so buildings span boundaries. Adjacent maps' sortables
        # may overdraw, but ordered by cellId+innerOrder they paint
        # consistently, and BG strict-clip stops ground tiles from leaking.
        rmo.paste_element(canvas_np, el, cx_canvas, cy_canvas, misses, blend_spec=bs, sf=sf)
        drawn += 1

    # FG layer holds building roofs that frequently span 2 maps (a big
    # bank/temple straddles 2 map slots). With strict slot clipping the
    # roof gets cut at the boundary — that's the misalignment the user
    # observed at (4,-18)/(4,-19). FG painters run AFTER bg/sortable and
    # are typically smaller decorations (no big BG ground tiles), so we
    # allow them to bleed across slot boundaries without risking another
    # map's content getting overwritten.
    #
    # Filters preserved: skip viewport-overlay rectangle, skip elements
    # pointing to a specialised shader (sun rays/glows).
    for el in fg:
        tr = el.get("transform") or {}
        sx = abs(float(tr.get("m11", 1.0)))
        sy = abs(float(tr.get("m22", 1.0)))
        tx = float(tr.get("m31", 0.0))
        ty = float(tr.get("m32", 0.0))
        if sx >= 0.9 and sy >= 0.9 and abs(tx) < 150 and abs(ty) < 150:
            continue
        bs, shader_gfx = blend_for(fg_blends, el)
        if shader_gfx >= 0:
            continue
        # No clip_rect — let roofs extend past the slot edge.
        rmo.paste_element(canvas_np, el, cx_canvas, cy_canvas, misses, blend_spec=bs, sf=sf)
        drawn += 1
    return drawn


def _get_map_layers(map_id: int):
    """Return (bg, sortable, fg, refs_by_rid) for a map. Cached per worker."""
    rmo = _get_rmo()
    tree = rmo.find_map_data(map_id)
    if tree is None:
        return None
    md = tree.get("mapData") or {}
    refs_by_rid = {}
    for r in (tree.get("references") or {}).get("RefIds") or []:
        if isinstance(r, dict) and r.get("rid") is not None:
            refs_by_rid[r["rid"]] = r
    return (
        md.get("backgroundElements") or [],
        md.get("sortableElements") or [],
        md.get("foregroundElements") or [],
        refs_by_rid,
    )


def _is_special_fx_tint(col_val: int) -> bool:
    r = (col_val >> 16) & 0xFF
    g = (col_val >>  8) & 0xFF
    b =  col_val        & 0xFF
    return (max(r, g, b) - min(r, g, b)) > 180


def render_band(args) -> tuple:
    """Worker: render a horizontal band of maps to a strip PNG using
    interleaved painter order: all BGs first (with strict slot clip),
    then ALL sortables across ALL maps sorted by (posY, cellId,
    innerCellRenderOrder) (no clip — bodies span boundaries), then all
    FGs sorted by posY (no clip — roofs span). FG painted absolutely
    last so it never gets overwritten by a neighbour's sortable bleed.
    Returns (band_y0, strip_path, drawn_count, elapsed_s).
    """
    band_y0, band_y1, full_x0, full_x1, sf, wm_id, tmp_dir = args
    t0 = time.time()
    rmo = _get_rmo()  # warm UnityPy cache once per worker

    all_maps = load_maps(wm_id)
    outdoor = load_outdoor_graph(wm_id)
    # Extend band's painting range by 1 row above + 1 row below. These
    # extra-row maps have their slot center outside the band canvas but
    # their cross-fade mask (half_F px past slot) bleeds into the band's
    # top/bottom edges, contributing the same accum/weight values that
    # the adjacent band computes for the same pair of maps. Result: the
    # horizontal seams at band boundaries get the same cross-fade as the
    # in-band vertical seams (no more sharp horizontal lines).
    band_maps = [m for m in all_maps
                 if full_x0 <= m["posX"] <= full_x1
                 and (band_y0 - 1) <= m["posY"] <= (band_y1 + 1)]
    # Dedupe by (posX, posY): wm=1 has 289 coords with multiple mapIds
    # (interior dungeons sharing the surface coord, alt-versions, the (0,0)
    # bucket). Picking randomly = e.g. Planque des Vilinsekts interior at
    # (6,-15) instead of Cité d'Astrub. We prefer the map whose subAreaId
    # has more total maps in wm=1 — overworld subareas (Cité 73 maps, Champs
    # ...) dominate over hideout/dungeon subareas (Planque 9, etc.). Tie
    # broken by catalog order.
    # Dedup priority: outdoor connectivity graph is THE source of truth —
    # it lists exactly the map reachable by walking from the seed. If the
    # graph has an entry for a coord, that's the right map. We fall back
    # to heuristics (subarea size, nameId==0, lowest mapId) only for
    # coords the graph doesn't cover (unwalked dungeons, isolated
    # zones whose seed wasn't visited).
    from collections import Counter
    sa_size = Counter(m["subAreaId"] for m in all_maps)
    def priority(m):
        coord_key = f"{m['posX']},{m['posY']}"
        graph_id = outdoor.get(coord_key)
        in_graph = (graph_id == m["id"])
        return (
            0 if in_graph else 1,
            -sa_size[m["subAreaId"]],
            0 if (m.get("nameId") or 0) == 0 else 1,
            int(m["id"]),
        )
    by_coord = {}
    for m in band_maps:
        k = (m["posX"], m["posY"])
        existing = by_coord.get(k)
        if existing is None or priority(m) < priority(existing):
            by_coord[k] = m
    band_maps = list(by_coord.values())
    band_maps.sort(key=lambda m: (m["posY"], m["posX"]))

    # Manual overrides: skip element indices/gfxIds the user flagged via UI.
    # Plus a "*" key for globals that apply to every map (zaap lens, light
    # beams, sun halos, water shimmer — sprites the live game renders with
    # custom shaders we can't reproduce offline).
    overrides = load_render_overrides()
    global_skip_gfx = set((overrides.get("*") or {}).get("skip_gfx_ids") or [])

    cols = full_x1 - full_x0 + 1
    rows = band_y1 - band_y0 + 1
    canvas_w = int(round(cols * MAP_W_RENDER * sf))
    canvas_h = int(round(rows * MAP_H_RENDER * sf))

    # Weighted-average compositing for unbiased cross-fade between
    # adjacent maps. Each map renders into its own (slot+F)-sized buffer
    # with track_alpha=True so the buffer's alpha records this map's
    # painted footprint. We then accumulate buf.rgb * mask into accum
    # and buf.alpha * mask into weight, where mask is a 2D function that
    # is 1 in the slot core, fades 1→0 over an F-wide ring around the
    # slot, and 0 outside. Adjacent slots' masks SUM to 1 in the overlap
    # band, so dividing accum by weight at the end gives a true 50/50
    # blend (no painter-order bias). Where only one map painted, the
    # division returns its content unchanged.
    accumulator = np.zeros((canvas_h, canvas_w, 3), dtype=np.float32)
    weight      = np.zeros((canvas_h, canvas_w),    dtype=np.float32)

    misses = {}
    drawn = 0

    half_w = MAP_W_RENDER * sf / 2
    half_h = MAP_H_RENDER * sf / 2

    # Cross-fade ring width F (px). Half goes inside the slot, half
    # outside, so two neighbour maps' masks sum to 1 across the band.
    # Larger F = softer transition, hides more misalignment, but at the
    # cost of more "blur" in the overlap zone.
    F = max(24, int(60 * sf))
    half_F = F // 2
    slot_w = int(round(MAP_W_RENDER * sf))
    slot_h = int(round(MAP_H_RENDER * sf))
    buf_w = slot_w + 2 * half_F
    buf_h = slot_h + 2 * half_F

    # Pre-compute per-map mask. Slot extents in buffer coords are
    # [half_F, half_F+slot_w] × [half_F, half_F+slot_h]. For each pixel,
    # d = signed distance to nearest slot edge (positive inside slot,
    # negative outside in bleed). mask = clip((d + half_F) / F, 0, 1):
    # at slot core (d ≥ half_F): mask = 1 ; at slot edge (d=0): mask = 0.5
    # ; at bleed edge (d = -half_F): mask = 0.
    _ys = np.arange(buf_h, dtype=np.float32)[:, None]
    _xs = np.arange(buf_w, dtype=np.float32)[None, :]
    _dx = np.minimum(_xs - half_F, (half_F + slot_w - 1) - _xs)
    _dy = np.minimum(_ys - half_F, (half_F + slot_h - 1) - _ys)
    _d = np.minimum(_dx, _dy)
    mask = np.clip((_d + half_F) / F, 0.0, 1.0).astype(np.float32)

    # Per-map buffer (allocated once per worker, reset per map).
    buf = np.zeros((buf_h, buf_w, 4), dtype=np.float32)

    for m in band_maps:
        layers = _get_map_layers(int(m["id"]))
        if layers is None: continue
        bg, sortable, fg, refs_by_rid = layers
        tree = rmo.find_map_data(int(m["id"]))
        md = tree.get("mapData") or {}
        bg_blends       = rmo.build_blend_table(md.get("backgroundMaterialData") or {}, refs_by_rid)
        sortable_blends = rmo.build_blend_table(md.get("sortableMaterialData") or {},   refs_by_rid)
        fg_blends       = rmo.build_blend_table(md.get("foregroundMaterialData") or {}, refs_by_rid)

        cx_canvas = ((m["posX"] - full_x0) + 0.5) * MAP_W_RENDER * sf
        cy_canvas = ((m["posY"] - band_y0) + 0.5) * MAP_H_RENDER * sf

        ovr = overrides.get(str(m["id"]), {})
        skip_idx_by_layer = ovr.get("skip_indices", {})
        skip_gfx = set(ovr.get("skip_gfx_ids", [])) | global_skip_gfx

        def blend_for(layer_blends, el):
            mi = int(el.get("materialIndex", 0))
            if 0 <= mi < len(layer_blends):
                return layer_blends[mi]
            return (rmo.DEFAULT_BLEND, -1)

        # Reset per-map buffer (transparent black) and paint into it
        # using buffer-local center coords. Buffer holds slot+F bleed,
        # so paste_element clip_rect covers the whole buffer (sprites
        # that fall outside don't cause issues — clipped naturally).
        buf.fill(0.0)
        cx_local = buf_w / 2
        cy_local = buf_h / 2

        bg_skip = set(skip_idx_by_layer.get("bg") or [])
        for i, el in enumerate(bg):
            if i in bg_skip or el.get("gfxId") in skip_gfx: continue
            bs, _ = blend_for(bg_blends, el)
            rmo.paste_element(buf, el, cx_local, cy_local, misses,
                              blend_spec=bs, sf=sf, track_alpha=True)
            drawn += 1

        so_skip = set(skip_idx_by_layer.get("sortable") or [])
        sortable_indexed = [(i, el) for i, el in enumerate(sortable)]
        sortable_indexed.sort(key=lambda ie: (ie[1].get("cellId", 0), ie[1].get("innerCellRenderOrder", 0)))
        for i, el in sortable_indexed:
            if i in so_skip or el.get("gfxId") in skip_gfx: continue
            cv = (el.get("color") or {}).get("value", 0xFFFFFFFF) & 0xFFFFFFFF
            if _is_special_fx_tint(cv): continue
            bs, sg = blend_for(sortable_blends, el)
            if sg >= 0 and bs != rmo.DEFAULT_BLEND: continue
            rmo.paste_element(buf, el, cx_local, cy_local, misses,
                              blend_spec=bs, sf=sf, track_alpha=True)
            drawn += 1

        fg_skip = set(skip_idx_by_layer.get("fg") or [])
        for i, el in enumerate(fg):
            if i in fg_skip or el.get("gfxId") in skip_gfx: continue
            tr = el.get("transform") or {}
            sx = abs(float(tr.get("m11", 1.0)))
            sy = abs(float(tr.get("m22", 1.0)))
            tx = float(tr.get("m31", 0.0))
            ty = float(tr.get("m32", 0.0))
            if sx >= 0.9 and sy >= 0.9 and abs(tx) < 150 and abs(ty) < 150:
                continue
            bs, sg = blend_for(fg_blends, el)
            if sg >= 0: continue
            rmo.paste_element(buf, el, cx_local, cy_local, misses,
                              blend_spec=bs, sf=sf, track_alpha=True)
            drawn += 1

        # Composite buffer onto accumulator/weight via weighted-average.
        # buf.rgb is in PREMULTIPLIED form (init transparent + unity_blend
        # gives premult), so accumulator += buf.rgb * mask already encodes
        # true_color * buf_alpha * mask. weight += buf.alpha * mask. Final
        # divide gives true_color = Σ(true_rgb_i*α_i*mask_i) / Σ(α_i*mask_i).
        paste_x = int(round(cx_canvas - buf_w / 2))
        paste_y = int(round(cy_canvas - buf_h / 2))
        x0 = max(0, paste_x); y0 = max(0, paste_y)
        x1 = min(canvas_w, paste_x + buf_w); y1 = min(canvas_h, paste_y + buf_h)
        if x0 < x1 and y0 < y1:
            bx0 = x0 - paste_x; by0 = y0 - paste_y
            bx1 = bx0 + (x1 - x0); by1 = by0 + (y1 - y0)
            buf_rgb_slice   = buf [by0:by1, bx0:bx1, :3]
            buf_alpha_slice = buf [by0:by1, bx0:bx1,  3]
            mask_slice      = mask[by0:by1, bx0:bx1]
            accumulator[y0:y1, x0:x1] += buf_rgb_slice * mask_slice[..., None]
            weight     [y0:y1, x0:x1] += buf_alpha_slice * mask_slice

    # Final divide: true_rgb = accumulator / weight where weight > 0,
    # else 0 (canvas black). Add small epsilon to avoid /0; gate with
    # explicit threshold to keep unrender ed pixels at black instead of
    # tiny noise.
    eps = 1e-6
    safe_w = np.maximum(weight, eps)
    final_rgb = accumulator / safe_w[..., None]
    has_content = (weight > eps)
    final_rgb = np.where(has_content[..., None], final_rgb, 0.0)
    final_alpha = np.where(has_content, 1.0, 1.0).astype(np.float32)  # opaque output
    final = np.concatenate([final_rgb, final_alpha[..., None]], axis=-1)

    # Encode strip as PNG to avoid pickling a huge numpy array back to main.
    img = Image.fromarray(np.clip(final * 255.0, 0, 255).astype(np.uint8), "RGBA")
    strip_path = tmp_dir / f"band_y{band_y0}_{band_y1}.png"
    img.save(strip_path, "PNG", optimize=False)
    elapsed = time.time() - t0
    print(f"  [worker pid={os.getpid()}] band y[{band_y0},{band_y1}]: "
          f"{len(band_maps)} maps, drawn {drawn} in {elapsed:.0f}s", flush=True)
    return (band_y0, strip_path, drawn, elapsed)


def parse_range(s):
    if not s:
        return None
    a, b = s.split(",")
    return int(a), int(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wm",      type=int, default=1)
    ap.add_argument("--x",       type=str, default=None)
    ap.add_argument("--y",       type=str, default=None)
    ap.add_argument("--scale",   type=float, default=0.5)
    ap.add_argument("--workers", type=int, default=max(1, mp.cpu_count() - 2))
    ap.add_argument("--out",     type=str, default=None)
    args = ap.parse_args()

    all_maps = load_maps(args.wm)
    if not all_maps:
        print(f"no maps for wm={args.wm}", file=sys.stderr); sys.exit(1)

    xr = parse_range(args.x)
    yr = parse_range(args.y)
    if xr or yr:
        if not xr:
            xr = (min(m["posX"] for m in all_maps), max(m["posX"] for m in all_maps))
        if not yr:
            yr = (min(m["posY"] for m in all_maps), max(m["posY"] for m in all_maps))
    else:
        xr = (min(m["posX"] for m in all_maps), max(m["posX"] for m in all_maps))
        yr = (min(m["posY"] for m in all_maps), max(m["posY"] for m in all_maps))

    region_maps = [m for m in all_maps
                   if xr[0] <= m["posX"] <= xr[1]
                   and yr[0] <= m["posY"] <= yr[1]]
    if not region_maps:
        print(f"no maps in region x={xr} y={yr}", file=sys.stderr); sys.exit(1)

    cols = xr[1] - xr[0] + 1
    rows = yr[1] - yr[0] + 1
    sf   = float(args.scale)
    canvas_w = int(round(cols * MAP_W_RENDER * sf))
    canvas_h = int(round(rows * MAP_H_RENDER * sf))

    print(f"[region] wm={args.wm} | maps={len(region_maps)} | "
          f"x{xr} y{yr} | output {canvas_w}x{canvas_h} | "
          f"workers={args.workers}", flush=True)

    if canvas_w * canvas_h > 600_000_000:
        print(f"[region] canvas too big ({canvas_w*canvas_h:,} px). Reduce --scale.",
              file=sys.stderr); sys.exit(2)

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Split Y range into bands, ~equal map count per band so workers
    # finish around the same time. Bands are at posY granularity.
    band_size = max(1, math.ceil(rows / args.workers))
    bands = []
    y0 = yr[0]
    while y0 <= yr[1]:
        y1 = min(yr[1], y0 + band_size - 1)
        bands.append((y0, y1))
        y0 = y1 + 1
    print(f"[region] {len(bands)} bands of ~{band_size} rows each", flush=True)

    t0 = time.time()
    tasks = [(by0, by1, xr[0], xr[1], sf, args.wm, TMP_DIR) for by0, by1 in bands]
    with mp.Pool(args.workers) as pool:
        results = pool.map(render_band, tasks)

    # Stitch strips vertically into the final canvas. Each strip's PNG is
    # already at the correct horizontal extent (full xr); we paste it at
    # its band's y offset in the output.
    print(f"[region] stitching {len(results)} strips...", flush=True)
    out_img = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 255))
    for band_y0, strip_path, drawn, elapsed in results:
        band_yi = band_y0 - yr[0]
        py0 = int(round(band_yi * MAP_H_RENDER * sf))
        strip = Image.open(strip_path)
        out_img.paste(strip, (0, py0))
        try: strip_path.unlink()
        except Exception: pass

    out_img = ImageEnhance.Color(out_img).enhance(1.1)
    out_img = ImageEnhance.Contrast(out_img).enhance(1.05)
    out_img = ImageEnhance.Brightness(out_img).enhance(2.0)

    if args.out:
        out_path = Path(args.out)
    else:
        suffix = f"_x{xr[0]}-{xr[1]}_y{yr[0]}-{yr[1]}_s{args.scale}.png"
        out_path = OUT_DIR / f"wm{args.wm}{suffix}"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(out_path, "PNG", optimize=False)
    elapsed = time.time() - t0
    print(f"[region] done in {elapsed:.0f}s -> {out_path} "
          f"({out_path.stat().st_size // 1024} KB)", flush=True)


if __name__ == "__main__":
    main()
