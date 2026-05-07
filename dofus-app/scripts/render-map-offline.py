"""Compose a Dofus map preview offline from the game's sprite assets.

Given a mapId, reads its MapMetadata from the world bundle (looked up via
mapdata-bundle-index.json), then for each element in
backgroundElements → sortableElements → foregroundElements:
  1. finds the sprite by gfxId (via mapgfx-index.json)
  2. applies the element's 2×3 affine transform
     (m11=sx, m22=sy, m12/m21=0 in practice, m31/m32=tx/ty in screen pixels)
  3. respects Unity's Sprite pivot (usually (0.5, 0.5) but not always —
     decorations that "stand on the ground" have pivot at bottom-center)
  4. flips horizontally/vertically on negative scale
  5. alpha-composites onto the canvas

Sortable elements are painter-order sorted by (cellId, innerCellRenderOrder)
which matches Dofus's in-engine back-to-front render order.

Usage:
  python dofus-app/scripts/render-map-offline.py <mapId> [out_path]
  python dofus-app/scripts/render-map-offline.py 154644
  python dofus-app/scripts/render-map-offline.py 154644 F:/tmp/154644.png
"""
import sys, json, time
from collections import OrderedDict
from pathlib import Path
import numpy as np
from PIL import Image, ImageChops, ImageEnhance, ImageOps

import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"


# Unity UnityEngine.Rendering.BlendMode enum — used by the per-material
# shader blend factors we pull from the map's shaderData.
UNITY_BLEND = {
    0: "Zero", 1: "One", 2: "DstColor", 3: "SrcColor",
    4: "OneMinusDstColor", 5: "SrcAlpha", 6: "OneMinusSrcColor",
    7: "DstAlpha", 8: "OneMinusDstAlpha", 9: "SrcAlphaSaturate",
    10: "OneMinusSrcAlpha",
}
# Default blend: SrcAlpha / OneMinusSrcAlpha / Add — matches Dofus's
# Custom/SpriteCustom shader (gfxId=-1 default in shaderData).
DEFAULT_BLEND = (5, 10, 0)


def _blend_factor(kind: int, src: np.ndarray, dst: np.ndarray):
    """Resolve a Unity blend factor enum to a per-pixel multiplier.
    src/dst are HxWx4 float arrays in [0, 1]. Return value has same
    shape-broadcast semantics that numpy needs — scalar, (H,W,1), or
    (H,W,3). Alpha factors broadcast as (H,W,1) so they affect all
    three RGB channels uniformly.
    """
    if kind == 0:  return 0.0
    if kind == 1:  return 1.0
    if kind == 2:  return dst[:, :, :3]
    if kind == 3:  return src[:, :, :3]
    if kind == 4:  return 1.0 - dst[:, :, :3]
    if kind == 5:  return src[:, :, 3:4]
    if kind == 6:  return 1.0 - src[:, :, :3]
    if kind == 7:  return dst[:, :, 3:4]
    if kind == 8:  return 1.0 - dst[:, :, 3:4]
    if kind == 10: return 1.0 - src[:, :, 3:4]
    return 1.0  # fallback including SrcAlphaSaturate (rare; approximated as One)


def unity_blend(dst_rgba: np.ndarray, src_rgba: np.ndarray,
                src_factor: int, dst_factor: int, op: int) -> np.ndarray:
    """Apply Unity's blend formula: out = op(src × srcF, dst × dstF).
    Called per-element after the sprite has been tinted with element.color
    — matches Dofus's fixed-function blend stage. The shader's own
    fragment output is `tex × color`, which is what we feed in as src."""
    sf = _blend_factor(src_factor, src_rgba, dst_rgba)
    df = _blend_factor(dst_factor, src_rgba, dst_rgba)
    src_rgb = src_rgba[:, :, :3]
    dst_rgb = dst_rgba[:, :, :3]
    if op == 0:  # Add
        out_rgb = src_rgb * sf + dst_rgb * df
    elif op == 1:  # Sub
        out_rgb = src_rgb * sf - dst_rgb * df
    elif op == 2:  # RevSub
        out_rgb = dst_rgb * df - src_rgb * sf
    elif op == 3:  # Min
        out_rgb = np.minimum(src_rgb * sf, dst_rgb * df)
    elif op == 4:  # Max
        out_rgb = np.maximum(src_rgb * sf, dst_rgb * df)
    else:
        out_rgb = src_rgb * sf + dst_rgb * df
    np.clip(out_rgb, 0.0, 1.0, out=out_rgb)
    # Keep dst alpha — sprites carve their own coverage via the RGB
    # factors. Preserving alpha keeps post-processing sane.
    return np.concatenate([out_rgb, dst_rgba[:, :, 3:4]], axis=-1)

APP = Path(__file__).resolve().parent.parent
DATA_DIR = APP / "data"
MAPDATA_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Data")
MAPGFX_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Map\Textures\1x")
MAPGFX_INDEX_FILE = DATA_DIR / "mapgfx-index.json"
MAPDATA_INDEX_FILE = DATA_DIR / "mapdata-bundle-index.json"
SPRITES_DIR = DATA_DIR / "sprites"
SPRITE_META_FILE = DATA_DIR / "sprite-meta.json"
DEFAULT_OUT_DIR = DATA_DIR / "maps-preview"


# Canvas wide enough to hold any Dofus map. Content bbox is cropped after.
# Element coord ranges we saw were ~[-1186, 1085] × [-743, 580], plus sprite
# extents push further out — 2800×1800 gives comfortable margin.
CANVAS_W = 2800
CANVAS_H = 1800

# True per-map tileable extent in world-units (= screen-px at 1080p; reverse-
# engineered from the live client via Frida — see memory note
# `dofus_render_geometry`). 14 cols × 86 px = 1204 wide, 40 rows × 21.5 px
# (offset iso) = 860 tall. Cropping to this exact rectangle (instead of the
# 2080×1107 FG ambient sprite that was used previously) means adjacent map
# previews tile seamlessly when placed at their atlas slot positions —
# no more 30-50% camera-margin overlap producing the "doubled decorations"
# bug the user reported.
MAP_W_RENDER = 1204
MAP_H_RENDER = 860

# Per-process caches. A single render on a cold cache opens ~6 bundles and
# decodes hundreds of sprites — each bundle load is ~1-2s, each sprite
# decode ~10-50ms. Keeping them in memory makes subsequent renders within
# the same invocation much faster (when a server process renders many maps
# in sequence).
_env_cache = {}           # bundle filename → UnityPy.Environment (only used as fallback)
# LRU sprite cache with a byte budget. Keeping the same sprites in RAM
# across maps massively cuts repeat decode cost (a single mapgfx_*_assets
# bundle's worth of common ground tiles gets reused on dozens of nearby
# maps). 1 GB budget per worker — at 5 workers that's ~5 GB of cache,
# leaving plenty of headroom on a 16 GB box. Sprites bigger than the
# budget can't be cached at all (would evict everything else they touch
# anyway), so we just skip caching them.
SPRITE_CACHE_MAX_BYTES = 1024 * 1024 * 1024
_sprite_cache: "OrderedDict[int, tuple]" = OrderedDict()  # gfx_id → (PIL.Image RGBA, pivot_x_px, pivot_y_px)
_sprite_cache_bytes = 0
_mapgfx_index = None
_mapdata_index = None
_sprite_meta = None       # gfx_id (str) → {px, py, w, h} from sprite-meta.json


def _cache_get(gfx_id: int):
    """LRU access: move accessed entry to the most-recently-used end."""
    entry = _sprite_cache.get(gfx_id)
    if entry is not None:
        _sprite_cache.move_to_end(gfx_id)
    return entry


def _cache_put(gfx_id: int, entry: tuple) -> None:
    """Insert + evict oldest entries until we're under the byte budget.
    Skips caching entirely for sprites bigger than the whole budget."""
    global _sprite_cache_bytes
    img = entry[0]
    nbytes = img.width * img.height * 4  # RGBA uint8
    if nbytes > SPRITE_CACHE_MAX_BYTES:
        return
    if gfx_id in _sprite_cache:
        prev = _sprite_cache.pop(gfx_id)
        _sprite_cache_bytes -= prev[0].width * prev[0].height * 4
    _sprite_cache[gfx_id] = entry
    _sprite_cache_bytes += nbytes
    while _sprite_cache_bytes > SPRITE_CACHE_MAX_BYTES and len(_sprite_cache) > 1:
        _, old_entry = _sprite_cache.popitem(last=False)
        _sprite_cache_bytes -= old_entry[0].width * old_entry[0].height * 4


def _cache_clear() -> None:
    global _sprite_cache_bytes
    _sprite_cache.clear()
    _sprite_cache_bytes = 0


def get_mapgfx_index():
    global _mapgfx_index
    if _mapgfx_index is None:
        _mapgfx_index = json.loads(MAPGFX_INDEX_FILE.read_text(encoding="utf-8"))
    return _mapgfx_index


def get_mapdata_index():
    global _mapdata_index
    if _mapdata_index is None:
        _mapdata_index = json.loads(MAPDATA_INDEX_FILE.read_text(encoding="utf-8"))
    return _mapdata_index


def load_bundle(src_dir: Path, name: str):
    env = _env_cache.get(name)
    if env is None:
        env = UnityPy.load(str(src_dir / name))
        _env_cache[name] = env
    return env


def get_sprite_meta():
    """Returns the gfxId → {px, py, w, h} dict from sprite-meta.json,
    written by extract-mapgfx-sprites.py. Empty dict means we'll fall
    back to UnityPy decoding (slow, RAM-heavy)."""
    global _sprite_meta
    if _sprite_meta is None:
        if SPRITE_META_FILE.exists():
            try:
                _sprite_meta = json.loads(SPRITE_META_FILE.read_text(encoding="utf-8"))
            except Exception:
                _sprite_meta = {}
        else:
            _sprite_meta = {}
    return _sprite_meta


def get_sprite(gfx_id: int):
    """Returns (PIL.Image RGBA, pivot_x_px_from_left, pivot_y_px_from_bottom)
    or None if gfxId is not extractable.

    Hot path: load PIL Image from data/sprites/<gfxId>.png — pre-extracted
    by extract-mapgfx-sprites.py. ~50× faster than UnityPy decode and
    drops worker RAM from ~1 GB to ~150 MB (no UnityPy bundle state held).
    Falls back to UnityPy mapgfx bundle decode when the PNG is missing
    (so single-map renders work without the offline extract being run)."""
    cached = _cache_get(gfx_id)
    if cached is not None:
        return cached

    # Fast path: pre-extracted PNG on disk + pivot from sidecar.
    meta = get_sprite_meta()
    info = meta.get(str(gfx_id))
    if info:
        png_path = SPRITES_DIR / f"{gfx_id}.png"
        if png_path.exists():
            try:
                img = Image.open(png_path).convert("RGBA")
                pivot_px = float(info["px"]) * img.width
                pivot_py = float(info["py"]) * img.height
                entry = (img, pivot_px, pivot_py)
                _cache_put(gfx_id, entry)
                return entry
            except Exception:
                pass  # fall through to UnityPy fallback

    # Fallback path: decode from mapgfx bundle via UnityPy. Slow + RAM-heavy
    # because the env_cache holds the bundle's full object graph. Only used
    # when sprites haven't been pre-extracted yet.
    idx = get_mapgfx_index()
    info = idx.get(str(gfx_id))
    if not info:
        return None
    env = load_bundle(MAPGFX_DIR, info["b"])
    obj = next((o for o in env.objects if o.path_id == info["p"]), None)
    if obj is None:
        return None
    try:
        d = obj.read()
        img = d.image
        if img is None:
            return None
        img = img.convert("RGBA")
        px_norm = py_norm = 0.5
        try:
            pv = getattr(d, "m_Pivot", None) or getattr(d, "pivot", None)
            if pv is not None:
                px_norm = float(pv.X if hasattr(pv, "X") else pv.x)
                py_norm = float(pv.Y if hasattr(pv, "Y") else pv.y)
        except Exception:
            pass
        pivot_px = px_norm * img.width
        pivot_py = py_norm * img.height
        entry = (img, pivot_px, pivot_py)
        _cache_put(gfx_id, entry)
        return entry
    except Exception:
        return None


def apply_color_tint(img: Image.Image, argb_int: int, allow_2x_modulate: bool = False) -> Image.Image:
    """Multiply RGBA channels by an ARGB32 tint. With `allow_2x_modulate`
    True (only for sortable layer) and a grayscale tint we double the
    channels before multiplying — that's Dofus's "2x modulate" shader
    convention where a mid-gray tint is a no-op and the sprite's native
    colour shows through. Crucial for buildings/props whose sprites are
    coloured but whose per-instance tint is grayscale (for lighting).
    Under plain ×1 multiply those sprites crush to near-black (the
    "transparent building with trees showing through" artefact).

    Restricted to sortables because BG ground tiles also use grayscale
    tints and applying 2x to them turns the whole map fluorescent
    yellow — ground tiles in Dofus are already full-colour in the
    bundle and the gray tint is meant as a very light shade pass.
    """
    if argb_int == 0xFFFFFFFF:
        return img
    a = (argb_int >> 24) & 0xFF
    r = (argb_int >> 16) & 0xFF
    g = (argb_int >>  8) & 0xFF
    b =  argb_int        & 0xFF
    if allow_2x_modulate and abs(r - g) <= 12 and abs(g - b) <= 12 and abs(r - b) <= 12:
        r = min(255, r * 2)
        g = min(255, g * 2)
        b = min(255, b * 2)
        # Dofus uses tint alpha as a shader parameter (not as render
        # translucency) for these lighting-tinted sprites. Multiplying
        # by e.g. 0xA5 here leaks through as 65% transparency — the
        # "transparent foreground building" artefact. Force full
        # opacity so the sprite keeps its native alpha mask.
        a = 255
    tint = Image.new("RGBA", img.size, (r, g, b, a))
    return ImageChops.multiply(img, tint)


def paste_element(canvas_np: np.ndarray, element: dict, cx: float, cy: float,
                  misses: dict, blend_spec=DEFAULT_BLEND, sf: float = 1.0,
                  clip_rect: tuple | None = None,
                  track_alpha: bool = False):
    """Blit one element onto the float32 canvas using its material's
    Unity blend formula. `canvas_np` is HxWx4 in [0,1]; `blend_spec` is
    (srcFactor, destFactor, blendOp) pulled from the map's shaderData
    for the element's materialIndex.

    `sf` (scale factor) is applied uniformly to translation AND sprite
    scale, enabling rendering at different output resolutions than the
    native per-map preview (2080×1107). Sf=1 reproduces the original
    behaviour. The continuous-region renderer passes sf<1 to fit many
    maps into one shared canvas at lower per-map resolution.

    Sprite → PIL RGBA → scale/flip → tint (fragment output tex × _Color)
    → numpy float → region-blend into canvas via unity_blend(). Mirrors
    Dofus's two-stage render: the fragment shader does `tex × color`,
    then the fixed-function blend stage combines with the framebuffer
    using the material's srcFactor/destFactor/op.
    """
    gfx_id = element.get("gfxId")
    if gfx_id is None:
        return
    tr = element.get("transform") or {}
    sx = float(tr.get("m11", 1.0)) * sf
    sy = float(tr.get("m22", 1.0)) * sf
    tx = float(tr.get("m31", 0.0)) * sf
    ty = float(tr.get("m32", 0.0)) * sf
    col_val = 0xFFFFFFFF
    try:
        c = element.get("color")
        if isinstance(c, dict):
            col_val = int(c.get("value", 0xFFFFFFFF)) & 0xFFFFFFFF
    except Exception:
        pass

    sprite = get_sprite(int(gfx_id))
    if sprite is None:
        misses[int(gfx_id)] = misses.get(int(gfx_id), 0) + 1
        return
    img, pivot_px, pivot_py = sprite

    w_abs = abs(sx); h_abs = abs(sy)
    fw = max(1, int(round(img.width * w_abs)))
    fh = max(1, int(round(img.height * h_abs)))
    if fw != img.width or fh != img.height:
        img_s = img.resize((fw, fh), Image.LANCZOS)
    else:
        img_s = img

    piv_x = pivot_px * w_abs
    piv_y = pivot_py * h_abs
    if sx < 0:
        img_s = img_s.transpose(Image.FLIP_LEFT_RIGHT)
        piv_x = fw - piv_x
    if sy < 0:
        img_s = img_s.transpose(Image.FLIP_TOP_BOTTOM)
        piv_y = fh - piv_y

    # Fragment-shader output: tex × _Color (straight per-channel multiply,
    # matching Custom/SpriteCustom's non-grayscale path). Alpha channel
    # multiplied too — it carries the sprite's coverage into the blend.
    if col_val != 0xFFFFFFFF:
        a = (col_val >> 24) & 0xFF
        r = (col_val >> 16) & 0xFF
        g = (col_val >>  8) & 0xFF
        b =  col_val        & 0xFF
        tint = Image.new("RGBA", img_s.size, (r, g, b, a))
        img_s = ImageChops.multiply(img_s, tint)

    paste_x = int(round(cx + tx - piv_x))
    paste_y = int(round(cy - ty - (fh - piv_y)))

    H, W = canvas_np.shape[:2]
    # Continuous-region renderer passes a clip_rect (cx-MAP_W/2 .. cx+MAP_W/2,
    # cy-MAP_H/2 .. cy+MAP_H/2 in canvas-px) so each map's elements paint only
    # into its own slot. Without this, neighbours' BG ground tiles painted
    # later would overwrite this map's content via their north/south bleed
    # — that's the (3,-19) Astrub-overwritten-by-(3,-18) bug.
    if clip_rect is not None:
        cx0, cy0, cx1, cy1 = clip_rect
        cx0 = max(0, int(cx0)); cy0 = max(0, int(cy0))
        cx1 = min(W, int(cx1)); cy1 = min(H, int(cy1))
    else:
        cx0, cy0, cx1, cy1 = 0, 0, W, H
    if paste_x + fw <= cx0 or paste_y + fh <= cy0:
        return
    if paste_x >= cx1 or paste_y >= cy1:
        return
    x0 = max(paste_x, cx0); y0 = max(paste_y, cy0)
    x1 = min(paste_x + fw, cx1); y1 = min(paste_y + fh, cy1)
    if x0 >= x1 or y0 >= y1:
        return
    sx0 = x0 - paste_x; sy0 = y0 - paste_y
    sub = img_s.crop((sx0, sy0, sx0 + (x1 - x0), sy0 + (y1 - y0)))
    src_np = np.asarray(sub, dtype=np.float32) / 255.0
    dst_region = canvas_np[y0:y1, x0:x1]
    blended = unity_blend(dst_region, src_np, *blend_spec)
    # Sprites carry their coverage via alpha; outside the alpha mask the
    # fragment would have been discarded in-engine so skip writes where
    # sprite alpha is zero. (Unity blend with e.g. srcAlpha factor would
    # already give zero contribution there, but this also keeps the dst
    # untouched for blend modes like One/One that don't gate on alpha.)
    paint_mask = src_np[:, :, 3:4] > 0.001
    np.copyto(dst_region, blended, where=paint_mask)
    # track_alpha=True: also update dst alpha via classic alpha-over
    # (dst_a = src_a + dst_a*(1 - src_a)). Used by the region renderer's
    # per-map buffer (init transparent) so the buffer's alpha channel
    # records this map's painted footprint — needed for the weighted-
    # average compositing pass that produces unbiased cross-fade between
    # neighbouring maps. Single-map render() leaves track_alpha=False so
    # its opaque-black canvas keeps alpha=1 (no behaviour change).
    if track_alpha:
        sa = src_np[:, :, 3]
        da = dst_region[:, :, 3]
        np.copyto(da, sa + da * (1.0 - sa), where=paint_mask[:, :, 0])


def build_blend_table(mat_data: dict, refs_by_rid: dict) -> list:
    """Walk a layer's shaderData RefIds and return a list of
    (srcFactor, destFactor, blendOp) tuples indexed by materialIndex.

    shaderData[i] points (via rid) into the map's SerializeReference
    table. Each shader record has an optional `shaderParameters` list
    whose entries are also RefIds — one of them (if present) carries
    `sourceFactor / destinationFactor / blendOperation` = the per-
    material blend state Dofus's engine sets before drawing that
    element. Wind/dissolve/noise params also live in shaderParameters
    but we ignore those offline. No blend-param entry ⇒ default alpha.
    """
    out = []
    for entry in mat_data.get("shaderData") or []:
        rid = entry.get("rid") if isinstance(entry, dict) else None
        data = (refs_by_rid.get(rid) or {}).get("data") if rid is not None else None
        # Default everywhere is alpha blend (Custom/SpriteCustom). When a
        # specialised shader explicitly stores sourceFactor/destFactor in
        # its shaderParameters we use that instead. Specialised shaders
        # without an explicit blend (mostly wind/dissolve/noise variants
        # of the default sprite shader on sortables) keep alpha — they're
        # standard sprites with extra vertex effects we don't simulate.
        # Return shader gfxId alongside so the caller can decide to skip
        # specialised FG (lighting/glow effects we can't reproduce).
        shader_gfx = int(data.get("gfxId", -1)) if isinstance(data, dict) else -1
        blend = DEFAULT_BLEND
        if isinstance(data, dict):
            for pref in data.get("shaderParameters") or []:
                pd = (refs_by_rid.get(pref.get("rid")) or {}).get("data") if isinstance(pref, dict) else None
                if isinstance(pd, dict) and "sourceFactor" in pd and "destinationFactor" in pd:
                    blend = (int(pd.get("sourceFactor", 5)),
                             int(pd.get("destinationFactor", 10)),
                             int(pd.get("blendOperation", 0)))
                    break
        out.append((blend, shader_gfx))
    return out


def find_viewport_bbox(fg_elements: list, cx: int, cy: int):
    """Find the FG element that marks the player's visible viewport —
    typically one big sprite at scale 1, centered near origin, with a
    grayscale opaque tint (the "ambient overlay" we multiply). Return
    its bbox on canvas so we can crop to what the player actually sees
    in-game instead of returning the full map + decorative surround.
    Returns None if no such element exists (then we don't crop)."""
    for el in fg_elements:
        tr = el.get("transform") or {}
        sx = abs(float(tr.get("m11", 1.0)))
        sy = abs(float(tr.get("m22", 1.0)))
        tx = float(tr.get("m31", 0.0))
        ty = float(tr.get("m32", 0.0))
        if sx < 0.9 or sy < 0.9:
            continue
        if abs(tx) > 150 or abs(ty) > 150:
            continue
        sprite = get_sprite(int(el.get("gfxId", 0)))
        if sprite is None:
            continue
        img, _, _ = sprite
        w = int(round(img.width * sx))
        h = int(round(img.height * sy))
        # Pivot assumed (0.5, 0.5) — matches every Ankama viewport-overlay
        # sprite we've seen. If a map turns up where the overlay is
        # off-centre we'd need to read the sprite's real pivot.
        bx = cx + tx - w / 2
        by = cy - ty - h / 2
        return (int(round(bx)), int(round(by)), int(round(bx + w)), int(round(by + h)))
    return None


def find_map_data(map_id: int):
    idx = get_mapdata_index()
    bundle_name = idx.get(str(map_id))
    if not bundle_name:
        print(f"map {map_id} not in mapdata-bundle-index.json — rerun build-mapdata-bundle-index.py?", file=sys.stderr)
        return None
    env = load_bundle(MAPDATA_DIR, bundle_name)
    target = f"map_{map_id}"
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            t = obj.read_typetree()
        except Exception:
            continue
        if t.get("m_Name") == target:
            return t
    return None


def render(map_id: int, out_path: Path) -> dict:
    t0 = time.time()
    tree = find_map_data(map_id)
    if tree is None:
        return {"ok": False, "reason": f"map_{map_id} not found"}
    md = tree.get("mapData") or {}
    bg = md.get("backgroundElements") or []
    sortable = md.get("sortableElements") or []
    fg = md.get("foregroundElements") or []

    # Resolve per-material blend specs from each layer's shaderData. This
    # is the key shader-faithful bit: mapdata stores a Unity blend factor
    # triple per material (sourceFactor/destinationFactor/blendOperation
    # of the material's shader). Default = SrcAlpha/OneMinusSrcAlpha/Add
    # which matches the Custom/SpriteCustom shader used everywhere else.
    refs_by_rid = {}
    for r in (tree.get("references") or {}).get("RefIds") or []:
        if isinstance(r, dict) and r.get("rid") is not None:
            refs_by_rid[r["rid"]] = r
    bg_blends       = build_blend_table(md.get("backgroundMaterialData") or {}, refs_by_rid)
    sortable_blends = build_blend_table(md.get("sortableMaterialData") or {},   refs_by_rid)
    fg_blends       = build_blend_table(md.get("foregroundMaterialData") or {}, refs_by_rid)

    def blend_for(layer_blends, el):
        """Returns (blend_spec, shader_gfxId)."""
        mi = int(el.get("materialIndex", 0))
        if 0 <= mi < len(layer_blends):
            return layer_blends[mi]
        return (DEFAULT_BLEND, -1)

    # Float32 canvas — required for Unity blend math (SrcColor/One etc.
    # easily overshoot 1.0 mid-compute). Starts opaque black.
    canvas_np = np.zeros((CANVAS_H, CANVAS_W, 4), dtype=np.float32)
    canvas_np[..., 3] = 1.0
    cx, cy = CANVAS_W // 2, CANVAS_H // 2
    misses = {}

    def is_special_fx_tint(col_val: int) -> bool:
        """Highly-saturated colour tints (e.g. pure blue 0x0111FF for the
        Goultard-fountain water, lava reds, poison greens) on otherwise-
        default-shader sortables are Dofus's "water / liquid effect"
        pattern: a fully-translucent sprite tinted with one extreme
        channel, expecting an in-engine refraction/animated water shader
        we can't reproduce. Alpha-blending it offline produces a solid
        coloured oval that doesn't exist in-game. Skip when max-min RGB
        gap is huge (channel separation = "I'm a colour effect, not a
        natural prop tint")."""
        r = (col_val >> 16) & 0xFF
        g = (col_val >>  8) & 0xFF
        b =  col_val        & 0xFF
        return (max(r, g, b) - min(r, g, b)) > 180

    skipped_fx = 0
    for el in bg:
        bs, _ = blend_for(bg_blends, el)
        paste_element(canvas_np, el, cx, cy, misses, blend_spec=bs)
    # Dofus's in-engine render order for sortable elements is
    # (cellId asc, then innerCellRenderOrder asc). cellId 0 = top of
    # iso view (farthest) so it paints first (furthest back).
    for el in sorted(sortable, key=lambda e: (e.get("cellId", 0), e.get("innerCellRenderOrder", 0))):
        col = el.get("color") or {}
        try:
            cv = int(col.get("value", 0xFFFFFFFF)) & 0xFFFFFFFF
        except Exception:
            cv = 0xFFFFFFFF
        if is_special_fx_tint(cv):
            skipped_fx += 1; continue
        bs, shader_gfx = blend_for(sortable_blends, el)
        # Specialised-shader sortables with a non-default blend are FX
        # overlays: water shimmer (gfx 305396 SrcColor/One), additive
        # glows, etc. Wind-animated trees and props use specialised
        # shaders too but with no explicit blend (they fall back to
        # default alpha in build_blend_table) — those still render.
        if shader_gfx >= 0 and bs != DEFAULT_BLEND:
            skipped_fx += 1; continue
        paste_element(canvas_np, el, cx, cy, misses, blend_spec=bs)
    # FG layer is overwhelmingly atmospheric — sun rays, glow halos,
    # day/night tints, weather. We render only "default-shader" FG
    # (shader gfxId == -1, i.e. plain Custom/SpriteCustom alpha-blend
    # sprites — these are proper shadow overlays and decoration extras).
    # Anything pointing to a specialised shader (gfxId > 0) is a lighting
    # effect that needs Dofus's depth-aware composite to look right;
    # alpha or alpha-resolved-blend renders them as bright yellow/blue
    # circles offline. Trees and props live in the sortable layer, so
    # this filter is safe (verified Amakna: 416 sortables vs 1 FG).
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
            skipped_fx += 1; continue
        paste_element(canvas_np, el, cx, cy, misses, blend_spec=bs)

    # Back to 8-bit PIL for the post-process chain. The numpy canvas is
    # already the "correct" composite (per-material Unity blend), so the
    # post-process is much lighter-handed than before — just a touch of
    # saturation & contrast to finalise. Earlier aggressive brightness
    # boosts were compensating for our wrong blend; they're no longer
    # needed now that SrcColor/One sortables render at the right level.
    canvas = Image.fromarray(
        np.clip(canvas_np * 255.0, 0, 255).astype(np.uint8), "RGBA"
    )
    canvas = ImageEnhance.Color(canvas).enhance(1.1)
    canvas = ImageEnhance.Contrast(canvas).enhance(1.05)

    # Crop to the EXACT map-tile extent (MAP_W × MAP_H centered on map origin).
    # Previously used find_viewport_bbox which returned the FG ambient sprite's
    # 2080×1107 size — too big by ~70% horizontally, ~28% vertically (camera
    # margin shows neighbour territory). Now we crop to the play-area extent
    # so adjacent maps' previews tile seamlessly at their atlas slot positions.
    x0 = max(0, cx - MAP_W_RENDER // 2)
    y0 = max(0, cy - MAP_H_RENDER // 2)
    x1 = min(canvas.width,  cx + MAP_W_RENDER // 2)
    y1 = min(canvas.height, cy + MAP_H_RENDER // 2)
    if x1 > x0 and y1 > y0:
        canvas = canvas.crop((x0, y0, x1, y1))
    crop_bbox = (x0, y0, x1, y1)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, "PNG", optimize=True)
    elapsed = time.time() - t0

    miss_total = sum(misses.values())
    miss_uniq = len(misses)
    drawn = len(bg) + len(sortable) + len(fg) - miss_total
    return {
        "ok": True,
        "mapId": map_id,
        "bg": len(bg),
        "sortable": len(sortable),
        "fg": len(fg),
        "drawn": drawn,
        "misses": miss_total,
        "miss_unique_gfxs": miss_uniq,
        "top_miss_gfxs": sorted(misses.items(), key=lambda x: -x[1])[:5],
        "out": str(out_path),
        "elapsed": round(elapsed, 2),
        "size": f"{canvas.width}x{canvas.height}",
        "cropped": crop_bbox is not None,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    map_id = int(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) >= 3 else (DEFAULT_OUT_DIR / f"{map_id}.png")
    result = render(map_id, out)
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
