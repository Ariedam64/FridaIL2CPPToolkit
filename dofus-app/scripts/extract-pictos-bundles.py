"""Extract Texture2D sprites from Picto/* bundles into
dofus-app/data/icons/<category>/<id>.png.

Each Texture2D's m_Name is the data id (item id, monster gfxId, spell id…),
matching the container path `Assets/BuiltAssets/<category>/1x/<id>.png`.
Spell textures are prefixed `sort_` in the bundle (Ankama uses the French
"sort" internally) — we strip that prefix so the filename stays numeric.

Usage: python dofus-app/scripts/extract-pictos-bundles.py <category>
       python dofus-app/scripts/extract-pictos-bundles.py items
       python dofus-app/scripts/extract-pictos-bundles.py monsters
       python dofus-app/scripts/extract-pictos-bundles.py spells
       python dofus-app/scripts/extract-pictos-bundles.py all
"""
import re, sys, time, json
from pathlib import Path
import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
PICTO_ROOT = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Picto")
OUT_ROOT = APP / "data" / "icons"

# category → (subdir name, bundle filename, optional regex to strip non-numeric prefix)
CATEGORIES = {
    "items":    ("Items",    "item_assets_1x.bundle",    None),
    "monsters": ("Monsters", "monster_assets_1x.bundle", None),
    "spells":   ("Spells",   "spell_assets_1x.bundle",   re.compile(r"^sort_(\d+)$")),
}


def extract_one(category: str):
    if category not in CATEGORIES:
        print(f"unknown category '{category}'. valid: {', '.join(CATEGORIES)}")
        return
    subdir, bundle_name, name_strip = CATEGORIES[category]
    bundle = PICTO_ROOT / subdir / bundle_name
    if not bundle.exists():
        print(f"bundle missing: {bundle}")
        return
    out_dir = OUT_ROOT / category
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[{category}] loading {bundle.name} ({bundle.stat().st_size // 1024} KB)")

    t0 = time.time()
    env = UnityPy.load(str(bundle))
    print(f"[{category}] loaded in {time.time() - t0:.1f}s, walking objects…")

    manifest = {}
    saved = 0
    t1 = time.time()
    for obj in env.objects:
        if obj.type.name != "Texture2D":
            continue
        try:
            data = obj.read()
            if data.image is None:
                continue
            name = str(data.m_Name)
            if name_strip is not None:
                m = name_strip.match(name)
                if not m: continue
                name = m.group(1)
            elif not name.isdigit():
                continue
            data.image.save(out_dir / f"{name}.png", "PNG")
            manifest[name] = {"w": int(data.m_Width), "h": int(data.m_Height)}
            saved += 1
            if saved % 1000 == 0:
                print(f"[{category}]   {saved} sprites in {time.time() - t1:.1f}s")
        except Exception:
            pass
    (OUT_ROOT / f"{category}-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    print(f"[{category}] done: {saved} sprites in {time.time() - t1:.1f}s ({out_dir})")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    target = sys.argv[1]
    if target == "all":
        for c in CATEGORIES:
            extract_one(c)
    else:
        extract_one(target)


if __name__ == "__main__":
    main()
