"""Adds iconId to each entry of catalog JSONs by reading their DataRoot
bundles. Each <Foo>Data has both `id` (in-game id) and a separate texture
id used by its picto sprite — `iconId` for items, `gfxId` for monsters,
etc. The runtime extract*Catalog RPCs didn't capture this, so we patch
the existing JSONs offline.

Usage: python dofus-app/scripts/backfill-icon-ids.py
"""
import sys, json
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
import UnityPy, UnityPy.config
UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.0f1"

APP = Path(__file__).resolve().parent.parent
REPO = APP.parent
DATA_ROOT_DIR = Path(r"F:\Jeux\Dofus-dofus3\Dofus_Data\StreamingAssets\Content\Data")
CATALOG_DIR = REPO / "app" / "plugins" / "dofus" / "data" / "catalog"

# (catalog_slug, dataroot_bundle_filename, dataroot_m_Name, source_field)
# `source_field` is the field on each entry that holds the picto texture id.
TARGETS = [
    ("items",    "data_assets_itemsdataroot.asset.bundle",    "ItemsDataRoot",    "iconId"),
    ("monsters", "data_assets_monstersdataroot.asset.bundle", "MonstersDataRoot", "gfxId"),
]


def backfill(slug: str, bundle_name: str, root_name: str, src_field: str):
    cat_path = CATALOG_DIR / f"{slug}.json"
    if not cat_path.exists():
        print(f"[{slug}] missing {cat_path}, skip")
        return
    bundle_path = DATA_ROOT_DIR / bundle_name
    if not bundle_path.exists():
        print(f"[{slug}] missing bundle {bundle_path}, skip")
        return

    env = UnityPy.load(str(bundle_path))
    icon_by_id = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        t = obj.read_typetree()
        if t.get("m_Name") != root_name:
            continue
        for r in (t.get("references") or {}).get("RefIds") or []:
            d = r.get("data") if isinstance(r, dict) else None
            if not isinstance(d, dict):
                continue
            iid = d.get("id"); icon = d.get(src_field)
            if iid is not None and icon is not None:
                icon_by_id[int(iid)] = int(icon)
        break

    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    matched = 0
    for it in cat.get("items", []):
        i = icon_by_id.get(int(it.get("id", -1)))
        if i is not None:
            it["iconId"] = i
            matched += 1
    cat_path.write_text(json.dumps(cat), encoding="utf-8")
    print(f"[{slug}] patched {matched}/{len(cat['items'])} entries (source: {src_field})")


def main():
    for slug, bundle, root, src in TARGETS:
        backfill(slug, bundle, root, src)


if __name__ == "__main__":
    main()
