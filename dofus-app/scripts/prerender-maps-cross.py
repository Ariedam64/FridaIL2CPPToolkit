"""Per-map preview renders with cardinal-cross fade context.

For each canonical map (one per (posX, posY) per worldmap), render a small
canvas covering the map's slot + half_F bleed margin, painting the central
map plus its 4 cardinal neighbours (N/S/E/W) using the same weighted-
average compositing as render-region.py. Save the central slot as
data/maps-preview-v2/<mapId>.png.

Cardinal-only (skip diagonal corners) cuts paint cost by ~44% vs full 3x3,
with negligible visual difference because the diagonal contribution only
affects a ~half_F × half_F corner region (~10x10 px on a 1204x860 preview).

Output: 1 PNG per map at native resolution (1204x860 by default), with
cross-fade visible at slot edges. When loaded side-by-side in the world
panel's lazy overlay, adjacent previews share the same cross-fade values
at their shared seam, so the result tiles seamlessly.

Usage:
  python dofus-app/scripts/prerender-maps-cross.py
  python dofus-app/scripts/prerender-maps-cross.py --wm 1
  python dofus-app/scripts/prerender-maps-cross.py --workers 6
  python dofus-app/scripts/prerender-maps-cross.py --skip-existing
  python dofus-app/scripts/prerender-maps-cross.py --limit 20    # debug
"""
import sys, json, time, argparse, math
from pathlib import Path
import multiprocessing as mp
import numpy as np
from PIL import Image, ImageEnhance

import importlib.util
RMO_PATH = Path(__file__).resolve().parent / "render-map-offline.py"

# Worker-local rmo module (loaded lazily on first use per process so the
# UnityPy import + bundle/sprite caches are reused across all maps a
# worker processes).
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
OUT_DIR = DATA_DIR / "maps-preview-v2"

MAP_W_RENDER = 1204
MAP_H_RENDER = 860


def _is_special_fx_tint(col_val: int) -> bool:
    r = (col_val >> 16) & 0xFF
    g = (col_val >>  8) & 0xFF
    b =  col_val        & 0xFF
    return (max(r, g, b) - min(r, g, b)) > 180


def load_render_overrides() -> dict:
    f = DATA_DIR / "render-overrides.json"
    if not f.exists(): return {}
    try: return json.loads(f.read_text(encoding="utf-8"))
    except Exception: return {}


def load_outdoor_graph(wm_id: int) -> dict:
    f = DATA_DIR / f"outdoor-graph-wm{wm_id}.json"
    if not f.exists(): return {}
    try: return json.loads(f.read_text(encoding="utf-8"))
    except Exception: return {}


def build_canonical_map_index() -> dict:
    """Returns { wm_id: { (posX, posY): canonical_mapId } } using same
    dedup logic as render-region.py: outdoor graph wins, fallback to
    subarea-size + nameId + lowest-id heuristic."""
    catalog = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    items = catalog.get("items", [])
    by_wm: dict = {}
    for m in items:
        wm = m.get("worldMap")
        if wm is None: continue
        by_wm.setdefault(wm, []).append(m)

    from collections import Counter
    canonical: dict = {}
    for wm, ms in by_wm.items():
        outdoor = load_outdoor_graph(wm)
        sa_size = Counter(m["subAreaId"] for m in ms)
        def priority(m):
            coord_key = f"{m['posX']},{m['posY']}"
            graph_id = outdoor.get(coord_key)
            in_graph = (graph_id == m["id"])
            return (0 if in_graph else 1, -sa_size[m["subAreaId"]],
                    0 if (m.get("nameId") or 0) == 0 else 1, int(m["id"]))
        by_coord: dict = {}
        for m in ms:
            k = (m["posX"], m["posY"])
            existing = by_coord.get(k)
            if existing is None or priority(m) < priority(existing):
                by_coord[k] = m
        canonical[wm] = {coord: m["id"] for coord, m in by_coord.items()}
    return canonical


def render_one_map(args) -> tuple:
    """Worker: render ONE map's preview with 4-cardinal cross context.
    Returns (mapId, ok, drawn, elapsed)."""
    target_id, neighbours, sf, out_dir_str, overrides = args
    rmo = _get_rmo()
    t0 = time.time()
    out_dir = Path(out_dir_str)

    F = max(24, int(60 * sf))
    half_F = F // 2
    slot_w = int(round(MAP_W_RENDER * sf))
    slot_h = int(round(MAP_H_RENDER * sf))

    # Accumulator covers central slot + half_F ring on each side. Anything
    # past that doesn't affect our saved central slot pixels (mask = 0).
    acc_w = slot_w + F
    acc_h = slot_h + F
    accumulator = np.zeros((acc_h, acc_w, 3), dtype=np.float32)
    weight      = np.zeros((acc_h, acc_w),    dtype=np.float32)

    # Per-map buffer: slot + 2*half_F bleed, reused across the 5 maps.
    buf_w = slot_w + 2 * half_F
    buf_h = slot_h + 2 * half_F
    buf = np.zeros((buf_h, buf_w, 4), dtype=np.float32)

    # Pre-compute the per-map mask (same formula as render-region.py).
    _ys = np.arange(buf_h, dtype=np.float32)[:, None]
    _xs = np.arange(buf_w, dtype=np.float32)[None, :]
    _dx = np.minimum(_xs - half_F, (half_F + slot_w - 1) - _xs)
    _dy = np.minimum(_ys - half_F, (half_F + slot_h - 1) - _ys)
    _d  = np.minimum(_dx, _dy)
    mask = np.clip((_d + half_F) / F, 0.0, 1.0).astype(np.float32)

    global_skip_gfx = set((overrides.get("*") or {}).get("skip_gfx_ids") or [])

    misses: dict = {}
    drawn = 0

    # Central slot lives at the center of the accumulator.
    cx_acc = acc_w / 2
    cy_acc = acc_h / 2

    # 5 maps to render: central + 4 cardinal neighbours. (None when there
    # is no neighbour at that direction.)
    maps_to_render = [
        (target_id,        0,  0),
        (neighbours["N"],  0, -1),
        (neighbours["S"],  0, +1),
        (neighbours["W"], -1,  0),
        (neighbours["E"], +1,  0),
    ]

    for map_id, dx_slot, dy_slot in maps_to_render:
        if map_id is None: continue
        tree = rmo.find_map_data(int(map_id))
        if tree is None: continue
        md = tree.get("mapData") or {}
        bg = md.get("backgroundElements") or []
        sortable = md.get("sortableElements") or []
        fg = md.get("foregroundElements") or []

        refs_by_rid: dict = {}
        for r in (tree.get("references") or {}).get("RefIds") or []:
            if isinstance(r, dict) and r.get("rid") is not None:
                refs_by_rid[r["rid"]] = r
        bg_blends       = rmo.build_blend_table(md.get("backgroundMaterialData") or {}, refs_by_rid)
        sortable_blends = rmo.build_blend_table(md.get("sortableMaterialData") or {},   refs_by_rid)
        fg_blends       = rmo.build_blend_table(md.get("foregroundMaterialData") or {}, refs_by_rid)

        ovr = overrides.get(str(map_id), {})
        skip_idx_by_layer = ovr.get("skip_indices", {})
        skip_gfx = set(ovr.get("skip_gfx_ids", [])) | global_skip_gfx

        def blend_for(layer_blends, el):
            mi = int(el.get("materialIndex", 0))
            if 0 <= mi < len(layer_blends):
                return layer_blends[mi]
            return (rmo.DEFAULT_BLEND, -1)

        # Reset buffer (transparent black) and paint into it centered.
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
            sx_t = abs(float(tr.get("m11", 1.0)))
            sy_t = abs(float(tr.get("m22", 1.0)))
            tx_t = float(tr.get("m31", 0.0))
            ty_t = float(tr.get("m32", 0.0))
            if sx_t >= 0.9 and sy_t >= 0.9 and abs(tx_t) < 150 and abs(ty_t) < 150:
                continue
            bs, sg = blend_for(fg_blends, el)
            if sg >= 0: continue
            rmo.paste_element(buf, el, cx_local, cy_local, misses,
                              blend_spec=bs, sf=sf, track_alpha=True)
            drawn += 1

        # Composite this map's buffer into the accumulator at its slot
        # offset. Neighbour buffers' content mostly falls outside the
        # accumulator (clipped during composite) — only their fade-zone
        # bleed into the central slot region actually contributes.
        offset_x = dx_slot * MAP_W_RENDER * sf
        offset_y = dy_slot * MAP_H_RENDER * sf
        paste_x = int(round(cx_acc + offset_x - buf_w / 2))
        paste_y = int(round(cy_acc + offset_y - buf_h / 2))
        x0 = max(0, paste_x); y0 = max(0, paste_y)
        x1 = min(acc_w, paste_x + buf_w); y1 = min(acc_h, paste_y + buf_h)
        if x0 < x1 and y0 < y1:
            bx0 = x0 - paste_x; by0 = y0 - paste_y
            bx1 = bx0 + (x1 - x0); by1 = by0 + (y1 - y0)
            buf_rgb_slice   = buf [by0:by1, bx0:bx1, :3]
            buf_alpha_slice = buf [by0:by1, bx0:bx1,  3]
            mask_slice      = mask[by0:by1, bx0:bx1]
            accumulator[y0:y1, x0:x1] += buf_rgb_slice * mask_slice[..., None]
            weight     [y0:y1, x0:x1] += buf_alpha_slice * mask_slice

    # Final divide → true RGB. Pixels with no contribution stay black.
    eps = 1e-6
    safe_w = np.maximum(weight, eps)
    final_rgb = accumulator / safe_w[..., None]
    has_content = (weight > eps)
    final_rgb = np.where(has_content[..., None], final_rgb, 0.0)
    final_alpha = np.ones((acc_h, acc_w), dtype=np.float32)
    final = np.concatenate([final_rgb, final_alpha[..., None]], axis=-1)

    img = Image.fromarray(np.clip(final * 255.0, 0, 255).astype(np.uint8), "RGBA")
    # Crop to central slot (drop the half_F margin used for fade reception).
    img = img.crop((half_F, half_F, half_F + slot_w, half_F + slot_h))

    # Same post-process chain as render-region.py.
    img = ImageEnhance.Color(img).enhance(1.1)
    img = ImageEnhance.Contrast(img).enhance(1.05)
    img = ImageEnhance.Brightness(img).enhance(2.0)

    out_path = out_dir / f"{target_id}.png"
    img.save(out_path, "PNG", optimize=False)
    elapsed = time.time() - t0
    return (target_id, True, drawn, elapsed)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wm", type=int, default=None,
                    help="restrict to a single worldmap ID (default: all)")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="render scale (default 1.0 = native 1204x860 per map)")
    ap.add_argument("--workers", type=int, default=max(1, mp.cpu_count() - 2))
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N maps (debug)")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[prerender] building canonical map index...", flush=True)
    canonical = build_canonical_map_index()
    overrides = load_render_overrides()

    tasks = []
    for wm, coord_to_id in canonical.items():
        if args.wm is not None and wm != args.wm: continue
        for (x, y), map_id in coord_to_id.items():
            out_path = OUT_DIR / f"{map_id}.png"
            if args.skip_existing and out_path.exists(): continue
            neighbours = {
                "N": coord_to_id.get((x, y - 1)),
                "S": coord_to_id.get((x, y + 1)),
                "W": coord_to_id.get((x - 1, y)),
                "E": coord_to_id.get((x + 1, y)),
            }
            tasks.append((map_id, neighbours, args.scale, str(OUT_DIR), overrides))

    if args.limit:
        tasks = tasks[:args.limit]

    print(f"[prerender] {len(tasks)} maps to render | scale={args.scale} | workers={args.workers}", flush=True)
    print(f"[prerender] output dir: {OUT_DIR}", flush=True)

    t0 = time.time()
    done = 0
    # maxtasksperchild=150 → after 150 maps, the worker process exits and
    # is replaced. Forces eviction of accumulated UnityPy bundle cache (no
    # built-in LRU there) so RAM doesn't keep climbing across the run.
    # Cost: bundle reload on restart (~1-2s amortised over 150 maps = <1%).
    with mp.Pool(args.workers, maxtasksperchild=150) as pool:
        for result in pool.imap_unordered(render_one_map, tasks, chunksize=4):
            done += 1
            if done % 50 == 0 or done == len(tasks):
                elapsed = time.time() - t0
                eta = elapsed / done * (len(tasks) - done)
                print(f"  [{done}/{len(tasks)}] elapsed {elapsed:.0f}s, ETA {eta/60:.1f} min", flush=True)

    print(f"[prerender] DONE in {(time.time()-t0)/60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
