#!/usr/bin/env python3
"""
Task 13 — Clear-DLL cross-reference leak source.

Extracts type-reference leaks from clear-named DLL .cs files decompiled by AssetRipper:
  - Ankama.AudioManagement, Ankama.Animator2D, Ankama.Dofus.Core.Characters/DataCenter/World,
    Ankama.Dofus.Protocol.Connection, Ankama.LauncherConnection, Ankama.ScreenManager,
    Ankama.SpinConnection, Ankama.Utilities, Ankama.Zendesk, Com.Ankama.Haapi*, Com.Ankama.Shopi,
    AleCore, Core.Localization, Logger, and any non-obfuscated sibling directory.

Also leverages the cpp2il Core/Protocol.Game indexes directly:
  - Obf types that appear as PARENT classes of PascalCase clear-named types
    (in-assembly inheritance hierarchy leaks)
  - Obf types that appear as FIELD TYPES inside PascalCase clear-named types
    (clear field names often reveal the obf type's semantic role)

Emits RenameEntry rows with evidence_source="clear_dll_xref".

Outputs:
  dofus-app/data/external/clear-dll-xrefs.json    (raw xref evidence)
  dofus-app/data/external/clear-dll-rename.json   (RenameEntry rows)

CLI:
    python extract-clear-dll-xrefs.py [--self-test] [--verbose]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import NamedTuple

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "dofus-app" / "data" / "external" / "assetripper-export" / "Scripts"
DATA_INDEXED = ROOT / "dofus-app" / "data" / "indexed"
OUTPUT_XREFS = ROOT / "dofus-app" / "data" / "external" / "clear-dll-xrefs.json"
OUTPUT_RENAME = ROOT / "dofus-app" / "data" / "external" / "clear-dll-rename.json"

INDEX_FILES = [
    DATA_INDEXED / "core.classes.json",
    DATA_INDEXED / "protocol-game.classes.json",
]

# ---------------------------------------------------------------------------
# Import shared schema
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _rename_schema import RenameEntry, write_entries  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Directories to SKIP (obfuscated assemblies or private implementation details)
SKIP_DIR_NAMES: frozenset[str] = frozenset([
    "Core",
    "Ankama.Dofus.Protocol.Game",
])
SKIP_DIR_PREFIX = "-PrivateImplementationDetails-"

# C# keywords and very common short words that collide with obf names
CSHARP_KEYWORDS: frozenset[str] = frozenset([
    "int", "bool", "byte", "void", "null", "true", "false", "new", "for", "if",
    "out", "ref", "var", "get", "set", "this", "base", "class", "struct", "enum",
    "using", "return", "static", "public", "private", "protected", "internal",
    "abstract", "sealed", "readonly", "override", "virtual", "partial", "try",
    "catch", "finally", "throw", "while", "do", "in", "is", "as", "not", "and",
    "or", "case", "break", "continue", "switch", "goto", "event", "delegate",
    "string", "long", "float", "double", "char", "object", "uint", "short",
    "ushort", "ulong", "sbyte", "decimal", "params", "where", "from", "let",
    "into", "on", "by", "join", "select", "group", "orderby", "ascending",
    "descending", "yield", "async", "await", "add", "remove", "value", "when",
    "init", "with", "record", "managed", "unmanaged", "notnull", "nint", "nuint",
    # Common English 2-3 letter words that appear in obf_set by coincidence
    "an", "us", "we", "no", "so", "go", "be", "at", "to",
    "it", "he", "she", "did", "but",
    # Common abbreviations that appear as obf names accidentally
    "id", "ip", "os", "vm", "rx", "tx", "ok", "io", "ui", "ai", "ml",
    "mm", "cm", "km", "pm", "am", "en", "fr", "de", "co", "tv", "hz",
    "ms", "ns", "dx", "gl", "dpi", "url", "uri", "api", "sdk", "cdn",
    "dll", "bin", "lib", "src", "obj", "cfg", "ini", "log", "tmp",
    "com", "net", "org", "www", "lan", "wan", "vpn", "dns",
    "iv", "dd", "hh", "ii", "jj", "kk", "ll", "nn", "pp", "rr",
    "ss", "tt", "uu", "vv", "ww", "xx", "yy", "zz",
    "min", "max", "num", "pos", "rot", "vec", "mat", "col", "row",
    "idx", "len", "cnt", "ret", "val", "ptr", "str", "fmt", "buf",
    "cap", "end", "key", "map", "set", "put", "pop", "top", "bot",
    "lhs", "rhs", "fps", "cpu", "gpu", "ram", "rom", "eof", "eol",
    "nan", "inf", "err", "msg", "arg", "opt", "req", "res", "rsp",
    "auth", "hash", "load", "save", "open", "read", "sync", "kill",
    "stop", "wait", "lock", "free", "send", "recv", "bind", "link",
    "copy", "move", "size", "type", "mode", "flag", "mask", "tag",
    "raw", "hex", "dec", "oct", "abs", "sin", "cos", "tan", "exp",
    "pow", "dot", "add", "get", "put",
])

# ---------------------------------------------------------------------------
# Structural C# regex patterns
# ---------------------------------------------------------------------------

# Matches: class/struct/interface ClassName [<generics>] : BaseList
RE_CLASS_DECL = re.compile(
    r'\b(?:class|struct|interface)\s+(\w+)\s*(?:<[^>]*>)?\s*:\s*([^{;]+)',
    re.MULTILINE
)

# Matches field declarations: [modifiers] TypeName fieldName [;={]
RE_FIELD = re.compile(
    r'(?:^|\s)(?:(?:public|private|protected|internal|static|readonly|new|volatile)\s+)+'
    r'(\w{2,6})\s+(\w+)\s*(?:[;={]|=>)',
    re.MULTILINE
)

# Matches method parameters: [(,] TypeName paramName [,)]
RE_PARAM = re.compile(
    r'[,(]\s*(\w{2,6})\s+(\w+)(?=\s*[,)=])',
)

# Matches namespace declaration
RE_NAMESPACE = re.compile(r'\bnamespace\s+([\w.]+)')


def _is_clear_named(name: str) -> bool:
    """Return True if name looks like a clear/human-readable PascalCase identifier."""
    return len(name) > 5 and name[0].isupper()


def _is_obf_name(name: str) -> bool:
    """Return True if name looks like an obfuscated identifier (short, lowercase-only)."""
    return bool(re.match(r'^[a-z]{1,5}$', name))


def _strip_generic(type_str: str) -> str:
    """Strip generic type parameters: 'List<string>' -> 'List'."""
    return re.sub(r'<.*>', '', type_str).strip()


# ---------------------------------------------------------------------------
# Load obf class set
# ---------------------------------------------------------------------------

def load_obf_class_set() -> tuple[set[str], list[dict]]:
    """
    Load the cpp2il index files and return:
      - set of all obf class names (any length) that have obfuscated-looking names
      - full list of all type records (for in-index xref extraction)
    """
    all_types: list[dict] = []
    for idx_path in INDEX_FILES:
        if not idx_path.exists():
            print(f"[WARN] index file not found: {idx_path}", file=sys.stderr)
            continue
        data = json.loads(idx_path.read_text(encoding="utf-8"))
        all_types.extend(data.get("types", []))

    # Truly obf names: 1-5 char lowercase (alphabetic only) AND not a keyword/common word
    obf_set = {
        t["name"] for t in all_types
        if _is_obf_name(t["name"]) and t["name"] not in CSHARP_KEYWORDS
    }
    return obf_set, all_types


# ---------------------------------------------------------------------------
# Collect clear .cs files
# ---------------------------------------------------------------------------

def collect_clear_cs_files() -> list[Path]:
    """Return all .cs files from non-obfuscated script directories."""
    if not SCRIPTS_DIR.is_dir():
        print(f"[WARN] Scripts dir not found: {SCRIPTS_DIR}", file=sys.stderr)
        return []

    result: list[Path] = []
    for subdir in SCRIPTS_DIR.iterdir():
        if not subdir.is_dir():
            continue
        dname = subdir.name
        if dname in SKIP_DIR_NAMES:
            continue
        if dname.startswith(SKIP_DIR_PREFIX):
            continue
        result.extend(subdir.rglob("*.cs"))

    return result


# ---------------------------------------------------------------------------
# Parse a single .cs file for xrefs
# ---------------------------------------------------------------------------

def parse_cs_for_xrefs(cs_text: str, obf_set: set[str]) -> dict:
    """
    Parse a C# source file and extract structural references to obf types.

    Returns:
        {
          'class':  {'name': str, 'namespace': str, 'base': str | None},
          'fields': [(obf_type, field_name), ...],
          'method_params': [(obf_type, param_name), ...],
          'method_returns': [obf_type, ...],
        }
    """
    # Detect namespace
    ns_m = RE_NAMESPACE.search(cs_text)
    namespace = ns_m.group(1) if ns_m else ""

    # Detect primary class name and base
    class_name = ""
    base_class: str | None = None

    for m in RE_CLASS_DECL.finditer(cs_text):
        candidate_name = m.group(1)
        bases_str = m.group(2) or ""
        # Take the first clear-named class as primary
        if not class_name and candidate_name[0].isupper():
            class_name = candidate_name
            # Parse bases
            raw_bases = [_strip_generic(b.strip()) for b in re.split(r',(?![^<>]*>)', bases_str)]
            for base in raw_bases:
                base = base.strip()
                if base in obf_set:
                    base_class = base
                    break

    # Fields
    fields: list[tuple[str, str]] = []
    for m in RE_FIELD.finditer(cs_text):
        typ = m.group(1)
        fname = m.group(2)
        if typ in obf_set:
            fields.append((typ, fname))

    # Method params
    params: list[tuple[str, str]] = []
    for m in RE_PARAM.finditer(cs_text):
        typ = m.group(1)
        pname = m.group(2)
        if typ in obf_set:
            params.append((typ, pname))

    return {
        "class": {"name": class_name, "namespace": namespace, "base": base_class},
        "fields": fields,
        "method_params": params,
        "method_returns": [],
    }


# ---------------------------------------------------------------------------
# Extract in-index xrefs from cpp2il type records
# ---------------------------------------------------------------------------

def extract_index_xrefs(all_types: list[dict], obf_set: set[str]) -> dict:
    """
    From the cpp2il index records, extract two kinds of leaks:
    1. Obf types that appear as PARENT classes of PascalCase clear-named types.
    2. Obf types that appear as FIELD TYPES inside PascalCase clear-named types.

    Returns:
        {
          obf_name: {
            'used_as_base_by': [(clear_name, ''), ...],
            'used_as_field': [(clear_name, field_name), ...],
          }
        }
    """
    index_xrefs: dict[str, dict] = {}

    for t in all_types:
        clear_name = t["name"]
        if not _is_clear_named(clear_name):
            continue

        # 1. Inheritance: clear_name inherits from obf parent
        for parent_raw in t.get("parents", []):
            base = _strip_generic(parent_raw)
            if base in obf_set:
                rec = index_xrefs.setdefault(base, {"used_as_base_by": [], "used_as_field": []})
                rec["used_as_base_by"].append((clear_name, ""))

        # 2. Field types: clear_name has a field of obf type
        for field in t.get("fields", []):
            ftype = _strip_generic(field.get("type", ""))
            if ftype in obf_set:
                rec = index_xrefs.setdefault(ftype, {"used_as_base_by": [], "used_as_field": []})
                rec["used_as_field"].append((clear_name, field.get("name", "")))

    return index_xrefs


# ---------------------------------------------------------------------------
# Aggregate xrefs (clear .cs scan + index xrefs)
# ---------------------------------------------------------------------------

def aggregate_xrefs(
    per_file_xrefs: list[dict],
    index_xrefs: dict[str, dict],
) -> dict:
    """
    Merge per-file xrefs (from .cs scan) and index xrefs into a single structure:
        {
          obf_name: {
            'used_as_base_by': [(clear_name, ns), ...],
            'used_as_field':   [(clear_name, ns, field_name), ...],
            'used_as_param':   [(clear_name, ns, param_name), ...],
            'all_clear_refs':  [clear_name, ...],
          }
        }
    """
    agg: dict[str, dict] = {}

    # Seed from index xrefs (in-assembly hierarchy)
    for obf_name, data in index_xrefs.items():
        rec = agg.setdefault(obf_name, {
            "used_as_base_by": [], "used_as_field": [], "used_as_param": [], "all_clear_refs": [],
        })
        for (clear_name, ns) in data["used_as_base_by"]:
            rec["used_as_base_by"].append((clear_name, ns))
            if clear_name not in rec["all_clear_refs"]:
                rec["all_clear_refs"].append(clear_name)
        for (clear_name, field_name) in data["used_as_field"]:
            rec["used_as_field"].append((clear_name, "", field_name))
            if clear_name not in rec["all_clear_refs"]:
                rec["all_clear_refs"].append(clear_name)

    # Overlay per-file xrefs (from external .cs scan)
    for file_info in per_file_xrefs:
        cls = file_info.get("class", {})
        clear_name = cls.get("name", "")
        ns = cls.get("namespace", "")
        base = cls.get("base")

        if base:
            rec = agg.setdefault(base, {
                "used_as_base_by": [], "used_as_field": [], "used_as_param": [], "all_clear_refs": [],
            })
            rec["used_as_base_by"].append((clear_name, ns))
            if clear_name not in rec["all_clear_refs"]:
                rec["all_clear_refs"].append(clear_name)

        for (typ, fname) in file_info.get("fields", []):
            rec = agg.setdefault(typ, {
                "used_as_base_by": [], "used_as_field": [], "used_as_param": [], "all_clear_refs": [],
            })
            rec["used_as_field"].append((clear_name, ns, fname))
            if clear_name not in rec["all_clear_refs"]:
                rec["all_clear_refs"].append(clear_name)

        for (typ, pname) in file_info.get("method_params", []):
            rec = agg.setdefault(typ, {
                "used_as_base_by": [], "used_as_field": [], "used_as_param": [], "all_clear_refs": [],
            })
            rec["used_as_param"].append((clear_name, ns, pname))
            if clear_name not in rec["all_clear_refs"]:
                rec["all_clear_refs"].append(clear_name)

    return agg


# ---------------------------------------------------------------------------
# Label derivation heuristics
# ---------------------------------------------------------------------------

def _pascal_from_field(name: str) -> str:
    """
    Convert a field/param name to a PascalCase label.
    'm_playedCharacterService' -> 'PlayedCharacterService'
    '_audioBus' -> 'AudioBus'
    'shopiClient' -> 'ShopiClient'
    """
    # Strip leading underscores and m_ prefix
    s = re.sub(r'^m_|^_+', '', name)
    if not s:
        return name
    return s[0].upper() + s[1:]


def _label_from_children(children: list[str]) -> str:
    """
    Derive a label from the list of PascalCase child class names.
    Strategy: find the longest common suffix or infer the base concept.
    """
    if not children:
        return ""
    if len(children) == 1:
        return children[0]
    # Find common suffix words (e.g. "...Binding" from many XxxBinding children)
    # Split by camelCase boundaries
    def split_pascal(s: str) -> list[str]:
        return re.findall(r'[A-Z][a-z0-9]*', s)

    word_lists = [split_pascal(c) for c in children if c]
    if not word_lists:
        return children[0]

    # Check suffix overlap
    reversed_words = [list(reversed(wl)) for wl in word_lists]
    common_suffix = []
    for parts in zip(*reversed_words):
        if len(set(parts)) == 1:
            common_suffix.append(parts[0])
        else:
            break

    if common_suffix:
        suffix = "".join(reversed(common_suffix))
        # Return as "XxxBase" or just the suffix
        return suffix + "Base"

    # Fallback: return first child as a hint
    return children[0] + "Base"


def _label_from_fields(field_entries: list[tuple]) -> str:
    """
    Derive a label from field name entries like [(clear_cls, ns, field_name), ...].
    Uses the most common field name.
    """
    if not field_entries:
        return ""
    # Count field name frequency
    name_counts: dict[str, int] = defaultdict(int)
    for entry in field_entries:
        fname = entry[-1]  # last element is field_name
        label = _pascal_from_field(fname)
        if label and len(label) > 2:
            name_counts[label] += 1

    if not name_counts:
        return ""

    # Return most common
    return max(name_counts.items(), key=lambda x: x[1])[0]


# ---------------------------------------------------------------------------
# Build RenameEntry rows
# ---------------------------------------------------------------------------

def build_rename_entries(aggregated: dict) -> list[RenameEntry]:
    """Apply confidence heuristics and derive labels."""
    entries: list[RenameEntry] = []

    for obf_name, data in aggregated.items():
        bases = data.get("used_as_base_by", [])
        fields = data.get("used_as_field", [])
        params = data.get("used_as_param", [])
        all_refs = data.get("all_clear_refs", [])

        total_refs = len(all_refs)
        if total_refs == 0:
            continue

        # Determine confidence
        if bases and len(bases) == 1:
            # Single clear class inherits from this obf type -> strong signal
            confidence = "high_unique"
        elif bases and len(set(c for c, _ in bases)) <= 3:
            confidence = "medium_xref"
        elif fields and total_refs <= 3:
            confidence = "medium_xref"
        else:
            confidence = "low_struct_match"

        # Derive namespace hint: use the most common namespace from referencing classes
        ns_parts: list[str] = []
        for (cname, ns) in bases:
            if ns:
                ns_parts.append(ns)
        for (cname, ns, *_) in fields:
            if ns:
                ns_parts.append(ns)
        ns_hint = max(set(ns_parts), key=ns_parts.count) if ns_parts else ""

        # Derive label
        label = ""

        if bases:
            # Base class label: infer from children
            child_names = [c for c, _ in bases]
            label = _label_from_children(child_names)
        elif fields:
            label = _label_from_fields(fields)
        elif params:
            label = _label_from_fields(params)

        if not label or len(label) < 3:
            # Fallback: use most common clear class name
            label = all_refs[0] + "Base" if all_refs else obf_name

        # Build evidence detail
        if bases:
            example_child = bases[0][0]
            if len(bases) == 1:
                detail = f"base_of: {example_child}"
            else:
                detail = f"base_of {len(bases)} classes (e.g. {example_child})"
        elif fields:
            fname_example = fields[0][-1] if fields else ""
            cls_example = fields[0][0] if fields else ""
            n = len(set(f[0] for f in fields))
            detail = f"field {fname_example} in {n} clear class(es) (e.g. {cls_example})"
        else:
            pname_example = params[0][-1] if params else ""
            detail = f"param {pname_example} in {len(params)} usages"

        entries.append(RenameEntry(
            obf_name=obf_name,
            original_name=label,
            namespace=ns_hint,
            confidence=confidence,
            evidence_source="clear_dll_xref",
            evidence_detail=detail,
        ))

    return entries


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Extract clear-DLL xref leaks for deobfuscation")
    parser.add_argument("--self-test", action="store_true", help="Run self-test and exit")
    parser.add_argument("--verbose", action="store_true", help="Print extra debug info")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    # 1. Load obf set and index
    print("[1/6] Loading cpp2il indexes ...")
    obf_set, all_types = load_obf_class_set()
    print(f"      Obf class names loaded: {len(obf_set)}")

    # 2. Extract in-index xrefs (obf parents with clear children + field types)
    print("[2/6] Extracting in-index cross-references ...")
    index_xrefs = extract_index_xrefs(all_types, obf_set)
    n_base_xrefs = sum(len(v["used_as_base_by"]) for v in index_xrefs.values())
    n_field_xrefs = sum(len(v["used_as_field"]) for v in index_xrefs.values())
    print(f"      Obf types with in-index xrefs: {len(index_xrefs)}")
    print(f"        Parent (base class) links:   {n_base_xrefs}")
    print(f"        Field type links:             {n_field_xrefs}")

    # 3. Collect and scan clear .cs files
    print("[3/6] Collecting clear .cs files ...")
    cs_files = collect_clear_cs_files()
    print(f"      Found {len(cs_files)} .cs files in non-obfuscated directories")

    print("[4/6] Scanning clear .cs files for structural obf-type references ...")
    per_file_xrefs: list[dict] = []
    files_with_hits = 0
    for cs_file in cs_files:
        try:
            text = cs_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        info = parse_cs_for_xrefs(text, obf_set)
        has_data = (
            info["class"]["base"] is not None
            or info["fields"]
            or info["method_params"]
        )
        if has_data:
            info["_source_file"] = str(cs_file)
            info["_dir"] = cs_file.parts[-3] if len(cs_file.parts) >= 3 else cs_file.parent.name
            per_file_xrefs.append(info)
            files_with_hits += 1

    print(f"      Clear .cs files with obf-type refs: {files_with_hits} / {len(cs_files)}")

    # 4. Aggregate
    print("[5/6] Aggregating cross-references ...")
    aggregated = aggregate_xrefs(per_file_xrefs, index_xrefs)
    print(f"      Distinct obf types referenced: {len(aggregated)}")

    # 5. Build rename entries
    entries = build_rename_entries(aggregated)

    # Confidence breakdown
    conf_counts: dict[str, int] = defaultdict(int)
    for e in entries:
        conf_counts[e.confidence] += 1

    # Top 10 most-referenced
    by_ref_count = sorted(
        aggregated.items(),
        key=lambda x: len(x[1].get("all_clear_refs", [])),
        reverse=True,
    )

    # 6. Write outputs
    print("[6/6] Writing output files ...")
    OUTPUT_XREFS.parent.mkdir(parents=True, exist_ok=True)
    xref_json = {}
    for obf_name, data in aggregated.items():
        xref_json[obf_name] = {
            "bases": [{"clear_name": c, "ns": n} for c, n in data.get("used_as_base_by", [])],
            "fields": [{"clear_name": c, "ns": n, "field": f} for c, n, f in data.get("used_as_field", [])],
            "params": [{"clear_name": c, "ns": n, "param": p} for c, n, p in data.get("used_as_param", [])],
        }
    OUTPUT_XREFS.write_text(json.dumps(xref_json, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"      Written xrefs: {OUTPUT_XREFS}")

    n_written = write_entries(entries, OUTPUT_RENAME)
    print(f"      Written rename entries: {OUTPUT_RENAME}")

    # Summary
    print()
    print("=== SUMMARY ===")
    print(f"  Clear .cs files scanned:         {len(cs_files)}")
    print(f"  Clear files with obf-type refs:  {files_with_hits}")
    print(f"  Distinct obf types referenced:   {len(aggregated)}")
    print(f"  RenameEntry rows emitted:        {n_written}")
    print(f"  --- Confidence breakdown ---")
    for conf in ["high_unique", "medium_xref", "low_struct_match"]:
        print(f"    {conf:<22}: {conf_counts.get(conf, 0)}")
    print()
    print("  Top 10 most-referenced obf types (label / ref count):")
    for obf_name, data in by_ref_count[:10]:
        ref_count = len(data.get("all_clear_refs", []))
        # Find the label we assigned
        label = next((e.original_name for e in entries if e.obf_name == obf_name), "?")
        conf = next((e.confidence for e in entries if e.obf_name == obf_name), "?")
        print(f"    {obf_name:<8} -> {label:<40} (refs={ref_count}, {conf})")
    print("===============")


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _self_test() -> None:
    cs_text = """
    using Ankama.Utilities;
    namespace Ankama.AudioManagement {
        public class AudioManager : els {
            private dxd _audioBus;
            public void Init(emb shopiClient, fdy entityFactory) { }
        }
    }
    """
    obf_set = {"els", "dxd", "emb", "fdy"}
    info = parse_cs_for_xrefs(cs_text, obf_set)
    assert info["class"]["name"] == "AudioManager", f"expected AudioManager, got {info['class']['name']}"
    assert info["class"]["namespace"] == "Ankama.AudioManagement", f"got {info['class']['namespace']}"
    assert info["class"]["base"] == "els", f"expected els, got {info['class']['base']}"
    field_pairs = info["fields"]
    assert ("dxd", "_audioBus") in field_pairs, f"field pair missing, got {field_pairs}"
    param_pairs = info["method_params"]
    assert ("emb", "shopiClient") in param_pairs, f"param pair missing: {param_pairs}"
    assert ("fdy", "entityFactory") in param_pairs, f"param pair missing: {param_pairs}"

    # Test label derivation
    label = _label_from_children(["NpcDialogBinding", "CartographyToolBinding", "BugReporterBinding"])
    assert "Binding" in label, f"expected 'Binding' in label, got {label}"

    label_field = _label_from_fields([("GameCompositor", "", "m_bus"), ("CachedDataService", "", "m_bus")])
    assert label_field == "Bus", f"expected 'Bus', got {label_field}"

    print("OK extract-clear-dll-xrefs._self_test")


if __name__ == "__main__":
    main()
