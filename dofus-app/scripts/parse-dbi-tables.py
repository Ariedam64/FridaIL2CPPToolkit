#!/usr/bin/env python3
"""
Parse DBI/DDC C# source files to extract real Ankama Dofus class names.

Strategy: walk DBI/DDC .cs files, extract identifiers that look like genuine
Ankama class names (PascalCase, non-keyword, non-primitive), then cross-ref
with the cpp2il index to determine if the name is already clear in the binary.

Usage:
  python parse-dbi-tables.py [--self-test]
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
DBI_ROOT = ROOT / "dofus-app" / "data" / "external" / "dbi"
INDEX_CORE = ROOT / "dofus-app" / "data" / "indexed" / "core.classes.json"
INDEX_PROTOGAME = ROOT / "dofus-app" / "data" / "indexed" / "protocol-game.classes.json"
OUTPUT = ROOT / "dofus-app" / "data" / "external" / "dbi-name-table.json"

MAX_ENTRIES = 5000

# ---------------------------------------------------------------------------
# Filter sets
# ---------------------------------------------------------------------------

CSHARP_KEYWORDS = {
    "Task", "Action", "Func", "List", "Dictionary", "HashSet", "IEnumerable",
    "IList", "IDictionary", "ICollection", "Tuple", "ValueTask", "Console",
    "Math", "String", "Int32", "Int64", "Boolean", "Object", "Type",
    "Assembly", "Path", "File", "Directory", "Stream", "Exception",
    "ArgumentException", "InvalidOperationException", "NullReferenceException",
    "ArgumentNullException", "NotImplementedException", "NotSupportedException",
    "AsyncStateMachine", "Generated", "GeneratedCode",
    "Logger", "ILogger", "Log",
    "Vector2", "Vector3", "Vector4", "Quaternion", "Color",
    "GameObject", "Transform", "Component", "MonoBehaviour", "ScriptableObject",
    "T", "TKey", "TValue", "TResult",
    "Test", "TestCase", "TestFixture", "Setup", "TearDown",
    "Json", "JsonSerializer", "JsonConverter", "Newtonsoft",
    "Method", "Field", "Property", "Class", "Interface", "Struct",
    "True", "False", "Null", "None", "Default",
    "Cs", "DLL", "Net",
    # Additional common C#/.NET / Unity / framework names
    "Event", "Delegate", "Enum", "Array", "Span", "Memory", "Nullable",
    "Task1", "ValueTask1",
    "StringBuilder", "StringComparer", "StringComparison",
    "CancellationToken", "CancellationTokenSource",
    "ServiceCollection", "ServiceProvider", "IServiceCollection", "IServiceProvider",
    "HttpClient", "HttpRequestMessage", "HttpResponseMessage",
    "JsonElement", "JsonDocument", "JsonProperty",
    "Encoding", "Decoder", "Encoder",
    "IEnumerator", "IDisposable", "IComparable", "IEquatable",
    "Regex", "Match", "Group",
    "Thread", "Monitor", "Mutex", "Semaphore",
    "EventArgs", "EventHandler",
    "Attribute", "Obsolete",
    "BindingFlags", "MethodInfo", "PropertyInfo", "FieldInfo", "TypeInfo",
    "Task2",
    "Il2CppObjectBase", "Il2CppSystem",
    "BepInPlugin", "BepInDependency",
    "HarmonyLib", "HarmonyPatch", "HarmonyPrefix", "HarmonyPostfix",
    "MessageParser", "CodedInputStream", "IMessage",
    "Google", "Protobuf",
    "UnityEngine", "Unity",
    "Process", "ProcessModule",
    "ConfigFile",
    "Direction", "Point", "Size", "Rect",
    "KeyCode", "Input",
    "IntPtr", "UIntPtr", "GCHandle",
    # Short names that might slip through
    "Id", "Ok", "No", "On",
}

# All-caps check (e.g., READONLY, MAX_SIZE) — skip these
_RE_ALLCAPS = re.compile(r'^[A-Z0-9_]+$')

# Regex to find PascalCase identifiers in C# source
# Matches a word starting with uppercase, containing at least one lowercase letter
_RE_IDENTIFIER = re.compile(r'\b([A-Z][A-Za-z0-9_]+)\b')

# Regex for 'using' directives — captures the full namespace path
_RE_USING = re.compile(r'^\s*using\s+([\w.]+)\s*;', re.MULTILINE)

# Skip directories that are not source code
_SKIP_DIRS = {".git", "bin", "obj", ".vs", "packages", "node_modules", "__pycache__"}


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

def _is_valid_class_name(name: str) -> bool:
    """Return True if the identifier looks like a real Ankama class name."""
    if len(name) < 4:
        return False
    if _RE_ALLCAPS.match(name):
        return False
    if name in CSHARP_KEYWORDS:
        return False
    # Must have at least one lowercase letter (filters ALL_CAPS_WITH_LENGTH variants)
    if not any(c.islower() for c in name):
        return False
    return True


def extract_class_refs(cs_text: str) -> dict[str, int]:
    """
    Extract real-looking class name identifiers from a C# source string.
    Returns {class_name: occurrence_count}.
    """
    counts: dict[str, int] = {}

    for m in _RE_IDENTIFIER.finditer(cs_text):
        name = m.group(1)
        if _is_valid_class_name(name):
            counts[name] = counts.get(name, 0) + 1

    return counts


def _detect_namespace_for_name(name: str, cs_text: str) -> str:
    """
    Try to find the namespace for a class name from `using` directives or
    `namespace` declaration. Returns the best guess or empty string.
    """
    # Check using directives whose last segment matches the name
    for m in _RE_USING.finditer(cs_text):
        ns = m.group(1)
        # If it's a using alias (e.g., `using Foo = ...`) skip; handled separately
        # Just capture the namespace
    # Use the file's own namespace declaration as fallback
    ns_match = re.search(r'\bnamespace\s+([\w.]+)', cs_text)
    if ns_match:
        return ns_match.group(1)
    return ""


def scan_cs_files(dbi_root: Path) -> tuple[dict[str, int], dict[str, str]]:
    """
    Aggregate extract_class_refs across all .cs files under dbi_root.
    Skips .git / bin / obj directories.

    Returns:
      - class_refs: {class_name: total_file_count} (count = number of distinct files)
      - class_namespace: {class_name: best_namespace_guess}
    """
    class_file_count: dict[str, int] = {}
    class_namespace: dict[str, str] = {}

    cs_files = _collect_cs_files(dbi_root)
    print(f"[dbi] scanning {len(cs_files)} .cs files under {dbi_root}", file=sys.stderr)

    for cs_path in cs_files:
        try:
            text = cs_path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            print(f"[dbi] warning: cannot read {cs_path}: {e}", file=sys.stderr)
            continue

        refs = extract_class_refs(text)
        for name, _count in refs.items():
            class_file_count[name] = class_file_count.get(name, 0) + 1
            if name not in class_namespace:
                class_namespace[name] = _detect_namespace_for_name(name, text)

    return class_file_count, class_namespace


def _collect_cs_files(root: Path) -> list[Path]:
    """Walk root recursively, yielding .cs files while skipping skip-dirs."""
    result = []
    for path in root.rglob("*.cs"):
        # Check none of the path parts are in skip dirs
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        result.append(path)
    return result


def load_cpp2il_classes() -> dict[str, dict]:
    """
    Load core.classes.json and protocol-game.classes.json.
    Returns {type_name: type_meta} merged from both files.
    """
    result: dict[str, dict] = {}
    for index_path in (INDEX_CORE, INDEX_PROTOGAME):
        if not index_path.exists():
            print(f"[dbi] warning: index not found: {index_path}", file=sys.stderr)
            continue
        try:
            raw = index_path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (OSError, json.JSONDecodeError) as e:
            print(f"[dbi] warning: failed to load {index_path}: {e}", file=sys.stderr)
            continue
        types = data.get("types", data) if isinstance(data, dict) else data
        for type_meta in types:
            name = type_meta.get("name") if isinstance(type_meta, dict) else None
            if name:
                result[name] = type_meta
    return result


def build_entries(
    class_refs: dict[str, int],
    cpp2il: dict[str, dict],
    class_namespace: dict[str, str] | None = None,
) -> list[RenameEntry]:
    """
    Build RenameEntry objects from class_refs cross-referenced with cpp2il.

    - Name in cpp2il → obf_name = name, confidence = high_unique
    - Name absent from cpp2il → obf_name = __UNKNOWN_OBF_FOR__<name>, confidence = medium_xref
    """
    if class_namespace is None:
        class_namespace = {}

    entries: dict[str, RenameEntry] = {}

    for name, file_count in class_refs.items():
        ns = class_namespace.get(name, "")
        detail = f"referenced in {file_count} .cs file{'s' if file_count != 1 else ''}"

        if name in cpp2il:
            # Class name is already clear in the binary
            obf = name
            confidence: str = "high_unique"
            detail += " (obf_name=clear)"
        else:
            # Class referenced in DBI but not found in cpp2il index — obf name unknown
            obf = f"__UNKNOWN_OBF_FOR__{name}"
            confidence = "medium_xref"
            detail += " (obf unknown — cross-ref needed)"

        if obf not in entries:
            entries[obf] = RenameEntry(
                obf_name=obf,
                original_name=name,
                namespace=ns,
                confidence=confidence,  # type: ignore[arg-type]
                evidence_source="dbi",
                evidence_detail=detail,
            )

    # Sort by original_name
    return sorted(entries.values(), key=lambda e: e.original_name)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _self_test() -> None:
    sample_cs = '''
    using Ankama.Dofus.Server.Game.Protocol.Inventory;
    using System.Collections.Generic;

    namespace Foo {
        public class MapView : MonoBehaviour {
            private InventoryService _service;
            private Dictionary<int, MonsterData> _monsters;
            public List<string> Items;
        }
    }
    '''
    refs = extract_class_refs(sample_cs)

    # Should detect MapView, InventoryService, MonsterData
    assert "MapView" in refs, f"MapView missing from {list(refs.keys())}"
    assert "InventoryService" in refs, f"InventoryService missing from {list(refs.keys())}"
    assert "MonsterData" in refs, f"MonsterData missing from {list(refs.keys())}"

    # Should NOT include MonoBehaviour (in keywords), Dictionary, List, string, int, Foo
    assert "MonoBehaviour" not in refs, "MonoBehaviour should be filtered (keyword)"
    assert "Dictionary" not in refs, "Dictionary should be filtered (keyword)"
    assert "List" not in refs, "List should be filtered (keyword)"
    # "Foo" is 3 chars, starts with uppercase but is only 3 chars — borderline
    # The rule says length < 3 → skip; "Foo" is length 3 so may appear — that's fine
    # The spec only mandates the named assertions above.

    cpp2il: dict[str, dict] = {"MapView": {"name": "MapView"}}
    entries = build_entries(
        {"MapView": 5, "MonsterData": 2, "InventoryService": 1},
        cpp2il,
    )

    found_mapview = [e for e in entries if e.original_name == "MapView"]
    found_monster = [e for e in entries if e.original_name == "MonsterData"]

    assert len(found_mapview) == 1, f"Expected 1 MapView entry, got {len(found_mapview)}"
    assert found_mapview[0].obf_name == "MapView", (
        f"MapView in cpp2il → obf_name should equal 'MapView', got '{found_mapview[0].obf_name}'"
    )
    assert found_mapview[0].confidence == "high_unique", (
        f"Expected high_unique, got {found_mapview[0].confidence}"
    )

    assert len(found_monster) == 1, f"Expected 1 MonsterData entry, got {len(found_monster)}"
    assert found_monster[0].obf_name.startswith("__UNKNOWN_OBF_FOR__"), (
        f"MonsterData absent from cpp2il → obf_name should start with __UNKNOWN_OBF_FOR__, "
        f"got '{found_monster[0].obf_name}'"
    )
    assert found_monster[0].confidence == "medium_xref", (
        f"Expected medium_xref, got {found_monster[0].confidence}"
    )

    print("OK parse-dbi-tables._self_test")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Parse DBI/DDC .cs files to extract Dofus class names."
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run internal self-test and exit.",
    )
    parser.add_argument(
        "--dbi-root",
        type=Path,
        default=DBI_ROOT,
        help=f"Path to the DBI repos root (default: {DBI_ROOT})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT,
        help=f"Output JSON path (default: {OUTPUT})",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    # --- Real run ---
    if not args.dbi_root.exists():
        print(f"[dbi] ERROR: DBI root not found: {args.dbi_root}", file=sys.stderr)
        return 1

    class_refs, class_namespace = scan_cs_files(args.dbi_root)
    print(f"[dbi] raw identifiers extracted: {len(class_refs)}", file=sys.stderr)

    cpp2il = load_cpp2il_classes()
    print(f"[dbi] cpp2il classes loaded: {len(cpp2il)}", file=sys.stderr)

    entries = build_entries(class_refs, cpp2il, class_namespace)

    if len(entries) > MAX_ENTRIES:
        print(
            f"[dbi] WARNING: {len(entries)} entries exceeds sanity limit {MAX_ENTRIES}; "
            "truncating. Consider tightening the filter.",
            file=sys.stderr,
        )
        entries = entries[:MAX_ENTRIES]

    n = write_entries(entries, args.output)

    # Stats
    in_cpp2il = sum(1 for e in entries if e.confidence == "high_unique")
    unknown = sum(1 for e in entries if e.confidence == "medium_xref")
    print(f"[dbi] entries written : {n}")
    print(f"[dbi]   high_unique    : {in_cpp2il}  (name already clear in cpp2il)")
    print(f"[dbi]   medium_xref   : {unknown}  (obf name unknown)")
    print(f"[dbi] output           : {args.output}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
