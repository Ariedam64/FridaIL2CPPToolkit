#!/usr/bin/env python3
"""
Task 10 — String-refs sweep on GameAssembly.dll.

Extracts strings from .rdata, finds RIP-relative XRefs from the il2cpp and .text
code sections via Capstone, resolves callsites to cpp2il obfuscated types, and
emits RenameEntry rows.

IL2CPP architecture notes
--------------------------
- Managed string literals live in global-metadata.dat, NOT in .rdata.
- .rdata contains: Unity engine binding signatures ("Ns.Class::Method(...)"),
  assembly names ("Ankama.Dofus.Core.dll"), Win32/FMOD/Unity native function
  names, and standard runtime error messages.
- The cpp2il method index covers RVA 0x5fc850..last_method+len (~50% of il2cpp).
- The Unity binding shims (which ref those UnityEngine.Xxx::Yyy strings) live in
  the UNINDEXED tail of il2cpp and must be excluded from resolution.
- Resolution uses nearest-preceding-method with next-method-start as upper bound,
  but only within the indexed range [first_method_start, last_method_end].

Outputs:
  dofus-app/data/indexed/string-refs-classlinks.json
  dofus-app/data/indexed/string-refs-rename.json
"""
from __future__ import annotations

import argparse
import bisect
import json
import re
import sys
import time
from pathlib import Path

import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
from capstone.x86_const import X86_OP_MEM, X86_REG_RIP

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DATA_DIR = REPO_ROOT / "dofus-app" / "data" / "indexed"
PATHS_JSON = SCRIPT_DIR / "dofus-paths.json"

INDEX_FILES = [
    DATA_DIR / "core.classes.json",
    DATA_DIR / "protocol-game.classes.json",
]

OUT_CLASSLINKS = DATA_DIR / "string-refs-classlinks.json"
OUT_RENAME = DATA_DIR / "string-refs-rename.json"

# ---------------------------------------------------------------------------
# Import shared schema
# ---------------------------------------------------------------------------
sys.path.insert(0, str(SCRIPT_DIR))
from _rename_schema import RenameEntry, write_entries  # noqa: E402

# ---------------------------------------------------------------------------
# String filtering
# ---------------------------------------------------------------------------
# Spec patterns
RE_DOTTED_CLASS = re.compile(
    r'^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]+){1,5}$'
)
RE_ASSET_PATH = re.compile(
    r'^(?:Assets|PackageCache|Library)/.*\.(?:cs|prefab|asset|unity)$'
)
LOG_PREFIXES = (
    "Loading ", "Failed to ", "Cannot ", "Initializing ",
    "Closing ", "Starting ", "Stopping ",
)
RE_EXCEPTION = re.compile(
    r'<[A-Z][A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*> not (?:found|registered|valid|loaded)',
    re.IGNORECASE,
)

# Extended patterns found empirically in GameAssembly.dll .rdata
# Unity internal binding method signatures: "Ns.Class::Method(Params...)"
RE_UNITY_BINDING = re.compile(
    r'^[A-Za-z][A-Za-z0-9_.]*::[A-Za-z_][A-Za-z0-9_]*\('
)
# Assembly DLL names: "Ankama.Dofus.Core.dll"
RE_ASSEMBLY_NAME = re.compile(
    r'^[A-Za-z][A-Za-z0-9_.]*\.dll$'
)
# Win32/Unity/FMOD native function names (PascalCase, 8-60 chars, no spaces)
RE_FUNCTION_NAME = re.compile(
    r'^[A-Z][A-Za-z0-9]{7,59}$'
)

MIN_LEN = 6
MAX_LEN = 300  # Unity bindings can be long


def is_interesting_string(s: str) -> tuple[bool, str]:
    """Return (keep, category) for a string."""
    n = len(s)
    if n < MIN_LEN or n > MAX_LEN:
        return False, ""
    if RE_DOTTED_CLASS.match(s):
        return True, "dotted_class"
    if RE_ASSET_PATH.match(s):
        return True, "asset_path"
    for p in LOG_PREFIXES:
        if s.startswith(p):
            return True, "log_pattern"
    if RE_EXCEPTION.search(s):
        return True, "exception_msg"
    if "::" in s and RE_UNITY_BINDING.match(s):
        return True, "unity_binding"
    if RE_ASSEMBLY_NAME.match(s) and "." in s[:-4]:
        return True, "assembly_ref"
    if ' ' not in s and RE_FUNCTION_NAME.match(s):
        return True, "function_name"
    return False, ""


# ---------------------------------------------------------------------------
# Extract strings from .rdata
# ---------------------------------------------------------------------------

def extract_strings_from_pe(pe_path: Path) -> tuple[list, pefile.PE]:
    """
    Returns ([(rva, string, category), ...], open_pe).
    Caller must pe.close() when done.
    """
    t0 = time.time()
    print("[Stage 1] Extracting strings from .rdata ...")
    pe = pefile.PE(str(pe_path), fast_load=True)

    rdata = None
    for sec in pe.sections:
        if sec.Name.startswith(b'.rdata'):
            rdata = sec
            break
    if rdata is None:
        raise RuntimeError(".rdata section not found")

    sec_va = rdata.VirtualAddress
    data = rdata.get_data()
    total = len(data)
    print(f"  .rdata size: {total / 1024 / 1024:.1f} MiB, VA=0x{sec_va:x}")

    results = []
    i = 0
    while i < total:
        b = data[i]
        if 0x20 <= b <= 0x7E:
            j = i
            while j < total and 0x20 <= data[j] <= 0x7E:
                j += 1
            run = data[i:j]
            if len(run) >= MIN_LEN:
                try:
                    s = run.decode('ascii')
                    keep, cat = is_interesting_string(s)
                    if keep:
                        results.append((sec_va + i, s, cat))
                except UnicodeDecodeError:
                    pass
            i = j
        else:
            i += 1

    elapsed = time.time() - t0
    cat_counts: dict[str, int] = {}
    for _, _, cat in results:
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
    print(f"  Found {len(results)} interesting strings in {elapsed:.1f}s: {cat_counts}")
    return results, pe


# ---------------------------------------------------------------------------
# Load cpp2il method index and compute indexed range
# ---------------------------------------------------------------------------

def load_cpp2il_method_index() -> tuple[dict[int, tuple[str, str, int]], int, int]:
    """
    Returns ({rva_int: (class_obf, method_obf, length_int)},
              first_method_rva, last_method_end_rva).
    """
    print("[Stage 2] Loading cpp2il method index ...")
    index: dict[int, tuple[str, str, int]] = {}
    for idx_path in INDEX_FILES:
        if not idx_path.exists():
            print(f"  WARNING: {idx_path} not found, skipping")
            continue
        data = json.loads(idx_path.read_text(encoding="utf-8"))
        for t in data.get("types", []):
            class_name = t["name"]
            for m in t.get("methods", []):
                rva_raw = m.get("rva")
                length_raw = m.get("length")
                if not rva_raw or not length_raw:
                    continue
                try:
                    rva_int = int(rva_raw, 16) if isinstance(rva_raw, str) else int(rva_raw)
                    length_int = int(length_raw, 16) if isinstance(length_raw, str) else int(length_raw)
                except (ValueError, TypeError):
                    continue
                if rva_int == 0:
                    continue
                if rva_int not in index:
                    index[rva_int] = (class_name, m["name"], length_int)

    if not index:
        raise RuntimeError("No methods loaded from cpp2il index")

    sorted_starts = sorted(index.keys())
    first_rva = sorted_starts[0]
    last_start = sorted_starts[-1]
    last_len = index[last_start][2]
    last_end = last_start + last_len

    print(f"  Loaded {len(index)} methods")
    print(f"  Indexed range: 0x{first_rva:x} – 0x{last_end:x}")
    return index, first_rva, last_end


# ---------------------------------------------------------------------------
# Find XRefs via Capstone disassembly
# ---------------------------------------------------------------------------
CHUNK_SIZE = 1 * 1024 * 1024  # 1 MiB
PROGRESS_INTERVAL = 10 * 1024 * 1024  # 10 MiB


def find_xrefs_in_section(
    sec_name: str,
    sec_va: int,
    sec_data: bytes,
    string_rva_set: set[int],
    image_base: int,
    method_range_start: int,
    method_range_end: int,
) -> dict[int, list[int]]:
    """
    Returns {string_rva: [callsite_rva, ...]} filtered to callsites within
    [method_range_start, method_range_end].
    """
    t0 = time.time()
    total = len(sec_data)
    print(f"  [{sec_name}] Disassembling {total / 1024 / 1024:.1f} MiB ...")

    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = True

    refs: dict[int, list[int]] = {}
    processed = 0
    next_report = PROGRESS_INTERVAL

    i = 0
    while i < total:
        chunk_end = min(i + CHUNK_SIZE, total)
        chunk = sec_data[i:chunk_end]
        chunk_va = image_base + sec_va + i

        for ins in md.disasm(chunk, chunk_va):
            mn = ins.mnemonic
            if mn not in ('lea', 'mov'):
                continue
            cs_rva = ins.address - image_base
            # Only accept callsites within the indexed method range
            if not (method_range_start <= cs_rva <= method_range_end):
                continue
            for op in ins.operands:
                if op.type != X86_OP_MEM:
                    continue
                if op.mem.base != X86_REG_RIP:
                    continue
                target_va = ins.address + ins.size + op.mem.disp
                target_rva = target_va - image_base
                if target_rva in string_rva_set:
                    refs.setdefault(target_rva, []).append(cs_rva)

        i = chunk_end
        processed += len(chunk)
        if processed >= next_report:
            elapsed = time.time() - t0
            pct = 100.0 * processed / total
            print(f"    {processed / 1024 / 1024:.0f}/{total / 1024 / 1024:.0f} MiB "
                  f"({pct:.1f}%) {elapsed:.0f}s ...")
            next_report += PROGRESS_INTERVAL

    elapsed = time.time() - t0
    total_refs = sum(len(v) for v in refs.values())
    print(f"  [{sec_name}] Done: {total_refs} XRefs to {len(refs)} strings in {elapsed:.1f}s")
    return refs


# ---------------------------------------------------------------------------
# Resolve callsites to (class, method)
# ---------------------------------------------------------------------------

def resolve_callsites_to_methods(
    refs: dict[int, list[int]],
    method_index: dict[int, tuple[str, str, int]],
) -> dict[int, dict[str, int]]:
    """
    {string_rva: {class_obf: count}}

    NOTE: cpp2il `length` fields report IL body size, not compiled native code
    size. In IL2CPP, compiled method bodies are typically 5–20× the IL size.
    We therefore attribute each callsite to the nearest preceding method, bounded
    by the next method's start RVA (not by the reported length). Callsites falling
    at or past the next method start are skipped (they belong to the next entry).
    """
    print("[Stage 4] Resolving callsites to methods ...")
    sorted_starts = sorted(method_index.keys())

    string_to_classes: dict[int, dict[str, int]] = {}

    for str_rva, callsites in refs.items():
        class_counts: dict[str, int] = {}
        for cs_rva in callsites:
            idx = bisect.bisect_right(sorted_starts, cs_rva) - 1
            if idx < 0:
                continue
            start = sorted_starts[idx]
            class_name, _, _ = method_index[start]

            # Skip if cs_rva falls at or past the next method start
            if idx + 1 < len(sorted_starts):
                if cs_rva >= sorted_starts[idx + 1]:
                    continue

            class_counts[class_name] = class_counts.get(class_name, 0) + 1
        if class_counts:
            string_to_classes[str_rva] = class_counts

    print(f"  Strings resolved to >=1 class: {len(string_to_classes)}")
    return string_to_classes


# ---------------------------------------------------------------------------
# Build RenameEntry rows
# ---------------------------------------------------------------------------

def _extract_original_name(s: str, category: str) -> tuple[str, str]:
    """Return (original_name, namespace) from a string."""
    if category == "dotted_class":
        parts = s.rsplit(".", 1)
        ns = parts[0] if len(parts) == 2 else ""
        return parts[-1], ns
    if category == "asset_path":
        return Path(s).stem, ""
    if category == "unity_binding":
        before = s.split("::")[0]
        parts = before.rsplit(".", 1)
        if len(parts) == 2:
            return parts[1], parts[0]
        return before, ""
    if category == "assembly_ref":
        stem = s[:-4]  # strip .dll
        parts = stem.rsplit(".", 1)
        if len(parts) == 2:
            return parts[1], parts[0]
        return stem, ""
    if category == "function_name":
        return s, ""
    return s, ""


def build_rename_entries(
    strings_by_rva: dict[int, tuple[str, str]],
    string_to_classes: dict[int, dict[str, int]],
) -> list[RenameEntry]:
    """Build RenameEntry rows from resolved class links."""
    print("[Stage 5] Building rename entries ...")
    entries: list[RenameEntry] = []
    eligible_cats = {"dotted_class", "asset_path", "unity_binding", "assembly_ref",
                     "function_name"}

    for str_rva, class_counts in string_to_classes.items():
        if str_rva not in strings_by_rva:
            continue
        string, category = strings_by_rva[str_rva]
        total_refs = sum(class_counts.values())

        if total_refs >= 50:
            continue  # generic / high-freq string

        n_classes = len(class_counts)
        if category not in eligible_cats:
            continue

        original_name, ns = _extract_original_name(string, category)

        if n_classes == 1:
            obf_class = next(iter(class_counts))
            entries.append(RenameEntry(
                obf_name=obf_class,
                original_name=original_name,
                namespace=ns,
                confidence="high_unique",
                evidence_source="stringrefs",
                evidence_detail=f"only ref to '{string[:80]}' (cat={category})",
            ))
        elif 2 <= n_classes <= 5:
            for obf_class in class_counts:
                entries.append(RenameEntry(
                    obf_name=obf_class,
                    original_name=original_name,
                    namespace=ns,
                    confidence="low_struct_match",
                    evidence_source="stringrefs",
                    evidence_detail=f"{n_classes}-way ref to '{string[:80]}' (cat={category})",
                ))

    print(f"  RenameEntry rows: {len(entries)}")
    return entries


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="String-refs sweep on GameAssembly.dll")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--dll", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    # Resolve DLL path
    dll_path = args.dll
    if dll_path is None:
        if PATHS_JSON.exists():
            cfg = json.loads(PATHS_JSON.read_text(encoding="utf-8"))
            dll_path = Path(cfg.get("game_assembly_dll", ""))
        if not dll_path or not dll_path.exists():
            print("ERROR: GameAssembly.dll not found. Use --dll <path>.", file=sys.stderr)
            sys.exit(1)

    out_classlinks = args.output or OUT_CLASSLINKS
    out_rename = (
        args.output.parent / "string-refs-rename.json"
        if args.output else OUT_RENAME
    )

    t_total = time.time()

    # ---- Stage 1: strings ----
    string_list, pe = extract_strings_from_pe(dll_path)
    strings_by_rva: dict[int, tuple[str, str]] = {
        rva: (s, cat) for rva, s, cat in string_list
    }
    string_rva_set: set[int] = set(strings_by_rva.keys())
    image_base = pe.OPTIONAL_HEADER.ImageBase

    # ---- Stage 2: method index ----
    method_index, method_range_start, method_range_end = load_cpp2il_method_index()

    # ---- Stage 3: XRefs (filter callsites to indexed range) ----
    print("[Stage 3] Scanning code sections for XRefs ...")
    refs: dict[int, list[int]] = {}
    for sec in pe.sections:
        sec_name = sec.Name.rstrip(b'\x00').decode('ascii', errors='replace')
        if sec_name in ('.text', 'il2cpp'):
            sec_refs = find_xrefs_in_section(
                sec_name, sec.VirtualAddress, sec.get_data(),
                string_rva_set, image_base,
                method_range_start, method_range_end,
            )
            for k, v in sec_refs.items():
                refs.setdefault(k, []).extend(v)

    pe.close()

    total_xrefs = sum(len(v) for v in refs.values())
    print(f"  Total XRefs (within indexed range): {total_xrefs} to {len(refs)} strings")

    # ---- Stage 4: Resolve ----
    string_to_classes = resolve_callsites_to_methods(refs, method_index)

    # ---- Stage 5: Rename entries ----
    entries = build_rename_entries(strings_by_rva, string_to_classes)

    # ---- Stage 6: Write output ----
    print("[Stage 6] Writing output files ...")
    classlinks: dict[str, dict] = {}
    for str_rva, class_counts in string_to_classes.items():
        if str_rva not in strings_by_rva:
            continue
        s, cat = strings_by_rva[str_rva]
        classlinks[str(str_rva)] = {
            "string": s,
            "category": cat,
            "classes": class_counts,
        }

    out_classlinks.parent.mkdir(parents=True, exist_ok=True)
    out_classlinks.write_text(
        json.dumps(classlinks, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"  Written: {out_classlinks} ({len(classlinks)} entries)")

    n_written = write_entries(entries, out_rename)
    print(f"  Written: {out_rename} ({n_written} entries)")

    elapsed_total = time.time() - t_total
    print()
    print("=== Summary ===")
    print(f"  Strings retained:          {len(string_list)}")
    print(f"  XRefs total:               {total_xrefs}")
    print(f"  Strings resolved to class: {len(string_to_classes)}")
    print(f"  RenameEntry rows:          {n_written}")
    print(f"  Total runtime:             {elapsed_total:.1f}s ({elapsed_total / 60:.1f} min)")


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _self_test():
    keep, cat = is_interesting_string("Core.UI.Cartography.MapView")
    assert keep and cat == "dotted_class", f"got keep={keep} cat={cat}"

    keep, cat = is_interesting_string("Loading scene")
    assert keep and cat == "log_pattern", f"got keep={keep} cat={cat}"

    keep, cat = is_interesting_string("a")  # too short
    assert not keep, f"expected not keep, got {keep}"

    keep, cat = is_interesting_string("Assets/Scripts/Foo.cs")
    assert keep and cat == "asset_path", f"got keep={keep} cat={cat}"

    # Edge cases
    keep, cat = is_interesting_string("x" * 301)  # too long
    assert not keep

    keep, cat = is_interesting_string("Failed to load asset")
    assert keep and cat == "log_pattern"

    keep, cat = is_interesting_string("<MyClass> not found")
    assert keep and cat == "exception_msg"

    # Unity binding pattern (dominant type in GameAssembly.dll .rdata)
    keep, cat = is_interesting_string(
        "UnityEngine.Animator::CrossFade_Injected(System.IntPtr,System.Int32)"
    )
    assert keep and cat == "unity_binding", f"got keep={keep} cat={cat}"

    # Assembly reference
    keep, cat = is_interesting_string("Ankama.Dofus.Core.dll")
    assert keep and cat == "assembly_ref", f"got keep={keep} cat={cat}"

    # Function name (Win32/Unity native API)
    keep, cat = is_interesting_string("GetWindowPosition")
    assert keep and cat == "function_name", f"got keep={keep} cat={cat}"

    print("OK extract-stringrefs-classlinks._self_test")


if __name__ == "__main__":
    main()
