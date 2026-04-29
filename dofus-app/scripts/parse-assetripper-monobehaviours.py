#!/usr/bin/env python3
"""
Parse AssetRipper YAML export to extract MonoBehaviour script names.

Unity sérialise les MonoBehaviour avec m_Script référençant un MonoScript
qui contient m_ClassName + m_Namespace en clair, indépendamment de
l'obfusc IL2CPP côté code.

Cross-ref avec l'index Cpp2IL pour détecter les class names déjà
existants en clair (DoNotRename) vs réellement obfusqués.

Usage: python parse-assetripper-monobehaviours.py [--self-test]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _rename_schema import RenameEntry, write_entries

ROOT = Path(__file__).resolve().parents[2]
EXPORT_DIR = ROOT / "dofus-app" / "data" / "external" / "assetripper-export"
INDEX_CORE = ROOT / "dofus-app" / "data" / "indexed" / "core.classes.json"
INDEX_PROTOGAME = ROOT / "dofus-app" / "data" / "indexed" / "protocol-game.classes.json"
OUTPUT = ROOT / "dofus-app" / "data" / "external" / "assetripper-monobehaviours.json"

RE_MONOSCRIPT = re.compile(
    r"m_Script:\s*\{fileID:\s*(?P<fileid>-?\d+),\s*guid:\s*(?P<guid>[0-9a-fA-F]+)"
)
RE_MS_CLASSNAME = re.compile(r"m_ClassName:\s*(?P<name>\S+)")
RE_MS_NAMESPACE = re.compile(r"m_Namespace:\s*(?P<ns>\S*)")
RE_MS_ASSEMBLY = re.compile(r"m_AssemblyName:\s*(?P<asm>\S+)")

# A "real" class name must have at least one uppercase letter OR digit, and be >= 4 chars long.
RE_REAL_NAME = re.compile(r"^(?=.*[A-Z0-9]).{4,}$")


def _looks_real(name: str) -> bool:
    """Return True if name looks like a genuine class name (not obfuscated noise)."""
    return bool(RE_REAL_NAME.match(name))


def collect_monoscripts(export_dir: Path) -> dict[str, dict]:
    """
    Walk export_dir for .asset files containing MonoScript blocks.
    Returns {guid: {class_name, namespace, assembly}}.
    The guid is taken from the .asset file's meta sidecar (.asset.meta)
    when present, or from an embedded guid comment at the top of the file.
    """
    monoscripts: dict[str, dict] = {}

    # AssetRipper writes MonoScript assets as individual .asset files.
    # Their guid lives in the accompanying .meta sidecar.
    for asset_path in export_dir.rglob("*.asset"):
        try:
            text = asset_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        if "MonoScript" not in text:
            continue

        m_class = RE_MS_CLASSNAME.search(text)
        if not m_class:
            continue
        class_name = m_class.group("name")

        m_ns = RE_MS_NAMESPACE.search(text)
        namespace = m_ns.group("ns") if m_ns else ""

        m_asm = RE_MS_ASSEMBLY.search(text)
        assembly = m_asm.group("asm") if m_asm else ""

        # Try to get guid from sidecar .meta file
        meta_path = asset_path.with_suffix(".asset.meta")
        guid: str | None = None
        if meta_path.exists():
            try:
                meta_text = meta_path.read_text(encoding="utf-8", errors="replace")
                m_guid = re.search(r"guid:\s*([0-9a-fA-F]+)", meta_text)
                if m_guid:
                    guid = m_guid.group(1)
            except OSError:
                pass

        if guid is None:
            # Fall back: use filename stem as a synthetic guid
            guid = asset_path.stem

        monoscripts[guid] = {
            "class_name": class_name,
            "namespace": namespace,
            "assembly": assembly,
        }

    return monoscripts


def collect_monobehaviour_refs(export_dir: Path) -> set[str]:
    """
    Walk export_dir for .prefab / .unity / .asset files containing m_Script references.
    Returns the set of guids that are actually referenced by at least one MonoBehaviour.
    """
    refs: set[str] = set()
    patterns = ["*.prefab", "*.unity", "*.asset"]

    seen: set[Path] = set()
    for pat in patterns:
        for path in export_dir.rglob(pat):
            if path in seen:
                continue
            seen.add(path)
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for m in RE_MONOSCRIPT.finditer(text):
                refs.add(m.group("guid"))

    return refs


def load_cpp2il_classes() -> dict[str, dict]:
    """
    Load core.classes.json and protocol-game.classes.json.
    Structure: {assembly: "...", types: [{name, kind, ...}, ...]}
    Returns {type_name: type_meta} merged from both files.
    """
    result: dict[str, dict] = {}
    for index_path in (INDEX_CORE, INDEX_PROTOGAME):
        if not index_path.exists():
            continue
        try:
            data = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for type_meta in data.get("types", []):
            name = type_meta.get("name")
            if name:
                result[name] = type_meta
    return result


def build_entries(
    monoscripts: dict[str, dict],
    refs: set[str],
    cpp2il: dict[str, dict],
) -> list[RenameEntry]:
    """
    For each MonoScript:
    - If class name does not look real  → skip
    - If class name exists in cpp2il (clear class) → emit as-is:
        obf_name = name, original_name = name
        confidence = high_unique if guid in refs else medium_xref
    - If class name absent from cpp2il (obfuscated) → emit placeholder:
        obf_name = "__UNKNOWN_OBF_FOR__<name>", original_name = name
        confidence = high_unique if guid in refs else medium_xref
    """
    entries: list[RenameEntry] = []
    for guid, meta in monoscripts.items():
        name = meta["class_name"]
        namespace = meta.get("namespace", "")
        assembly = meta.get("assembly", "")

        referenced = guid in refs
        confidence = "high_unique" if referenced else "medium_xref"

        if name in cpp2il:
            # Class is already in clear in the cpp2il index — DoNotRename scenario.
            # Emit regardless of whether name looks real (obf names in cpp2il are valid).
            obf_name = name
        elif not _looks_real(name):
            # Short/obf-shaped name not in cpp2il — skip; we can't map it.
            continue
        else:
            # Unity sees it in clear but IL2CPP obfuscated it
            obf_name = f"__UNKNOWN_OBF_FOR__{name}"

        entry = RenameEntry(
            obf_name=obf_name,
            original_name=name,
            namespace=namespace,
            confidence=confidence,
            evidence_source="assetripper",
            evidence_detail=f"assembly={assembly} guid={guid}",
        )
        entries.append(entry)

    return entries


def _self_test() -> None:
    monoscripts = {
        "abc123": {"class_name": "MapView", "namespace": "Core.UI", "assembly": "Core.dll"},
        "def456": {"class_name": "egq", "namespace": "", "assembly": "Core.dll"},
    }
    refs = {"abc123"}
    cpp2il = {"egq": {"label": "HAAPI client"}}
    entries = build_entries(monoscripts, refs, cpp2il)

    found_mapview = [e for e in entries if e.original_name == "MapView"]
    found_egq = [e for e in entries if e.original_name == "egq"]

    assert len(found_mapview) == 1, f"expected 1 MapView entry, got {len(found_mapview)}"
    assert found_mapview[0].obf_name.startswith("__UNKNOWN_OBF_FOR__"), (
        f"expected __UNKNOWN_OBF_FOR__ prefix, got {found_mapview[0].obf_name!r}"
    )
    assert found_mapview[0].confidence == "high_unique", (
        f"expected high_unique, got {found_mapview[0].confidence!r}"
    )

    assert len(found_egq) == 1, f"expected 1 egq entry, got {len(found_egq)}"
    assert found_egq[0].obf_name == "egq", (
        f"expected obf_name='egq', got {found_egq[0].obf_name!r}"
    )

    print("OK parse-assetripper-monobehaviours._self_test")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Run built-in self-test and exit")
    parser.add_argument("--export-dir", type=Path, default=EXPORT_DIR,
                        help="Path to AssetRipper export directory")
    parser.add_argument("--output", type=Path, default=OUTPUT,
                        help="Output JSON path")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        sys.exit(0)

    export_dir: Path = args.export_dir
    if not export_dir.exists():
        print(f"ERROR: export dir not found: {export_dir}", file=sys.stderr)
        print("Run AssetRipper manually first, then re-run without --self-test.", file=sys.stderr)
        sys.exit(1)

    print(f"Scanning {export_dir} …")
    monoscripts = collect_monoscripts(export_dir)
    print(f"  MonoScript entries found: {len(monoscripts)}")

    refs = collect_monobehaviour_refs(export_dir)
    print(f"  MonoBehaviour m_Script refs: {len(refs)}")

    cpp2il = load_cpp2il_classes()
    print(f"  Cpp2IL types loaded: {len(cpp2il)}")

    entries = build_entries(monoscripts, refs, cpp2il)
    print(f"  RenameEntry rows emitted: {len(entries)}")

    n = write_entries(entries, args.output)
    print(f"  Written {n} rows → {args.output}")


if __name__ == "__main__":
    main()
