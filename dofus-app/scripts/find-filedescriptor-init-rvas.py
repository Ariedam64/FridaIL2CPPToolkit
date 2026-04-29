#!/usr/bin/env python3
"""
Task 6 — Locate FileDescriptor init RVAs offline.

Scans the cpp2il indexed class JSONs for methods that are likely static
constructors / descriptor-init methods of Protobuf-generated classes.
These RVAs are the hook targets for Frida (Task 7+8).

Usage:
    python find-filedescriptor-init-rvas.py              # full run
    python find-filedescriptor-init-rvas.py --self-test  # unit test only
"""

import json
import os
import sys
import argparse

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
INDEXED_DIR = os.path.join(REPO_ROOT, "data", "indexed")
CORE_JSON = os.path.join(INDEXED_DIR, "core.classes.json")
PROTOCOL_JSON = os.path.join(INDEXED_DIR, "protocol-game.classes.json")
OUTPUT_DIR = os.path.join(REPO_ROOT, "data", "runtime")
OUTPUT_PATH = os.path.join(OUTPUT_DIR, "filedescriptor-init-candidates.json")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_static_modifier(modifiers) -> bool:
    """Return True when 'static' appears in the modifiers collection (list or str)."""
    if isinstance(modifiers, list):
        return "static" in modifiers
    if isinstance(modifiers, str):
        return "static" in modifiers.split()
    return False


def _has_byte_array(params_raw: str) -> bool:
    """Return True when the params_raw string mentions byte[]."""
    return "byte[]" in (params_raw or "")


def _is_real_static_cctor(method: dict) -> bool:
    """
    Detect a static constructor in the real cpp2il index.

    The indexer emits .cctor as a method whose:
      - return_type == 'static'
      - params_raw is empty
    (The method name is the class name, not '.cctor', in the real index.)
    """
    return method.get("return_type") == "static" and not (method.get("params_raw") or "").strip()


def _class_has_fd_field(type_meta: dict) -> bool:
    """Return True when the class has a private/static FileDescriptor field."""
    for f in (type_meta.get("fields") or []):
        if f.get("type") == "FileDescriptor" and "static" in (f.get("modifiers") or []):
            return True
    return False


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

_CAP = 2000  # sanity cap on output list length


def find_candidates(classes_by_name: dict) -> list:
    """
    Strategy A — iterate every method of every protoc-relevant class.

    A class is considered protoc-relevant when EITHER:
      - is_protoc_generated == True  (message classes)
      - it has a static FileDescriptor field  (Reflection partner classes; in the
        real cpp2il index these are NOT flagged is_protoc_generated even though they
        are 100% generated code).

    Emit a candidate when ALL of:
      1. The class passes the protoc-relevant test above
      2. The method is static (modifiers contains 'static' OR return_type == 'static')
      3. params_raw contains byte[] OR params_raw is empty/None
      4. rva is non-zero / non-null

    Scoring:
      +3  params_raw contains byte[]
      +2  name == '.cctor'  OR  the method is detected as the real static ctor
      +1  class name ends with 'Reflection' OR class has a static FileDescriptor field
      +1  params_raw is empty (no args)

    Returns list of candidates sorted by score descending, capped at _CAP.
    """
    candidates = []

    for class_name, type_meta in classes_by_name.items():
        is_reflection_class = (
            class_name.endswith("Reflection")
            or _class_has_fd_field(type_meta)
        )
        is_protoc = type_meta.get("is_protoc_generated")

        # Include if protoc-generated OR is a Reflection partner (has FileDescriptor field)
        if not is_protoc and not is_reflection_class:
            continue

        for method in (type_meta.get("methods") or []):
            rva = method.get("rva")
            if not rva or rva in (0, "0x0", "0", None):
                continue

            params_raw = method.get("params_raw") or ""
            modifiers = method.get("modifiers") or []
            name = method.get("name") or ""

            # --- static check ---
            is_static_via_modifier = _is_static_modifier(modifiers)
            is_static_via_return = _is_real_static_cctor(method)
            is_static = is_static_via_modifier or is_static_via_return

            if not is_static:
                continue

            # --- param filter: byte[] present OR no args ---
            has_byte = _has_byte_array(params_raw)
            has_no_args = not params_raw.strip()
            if not has_byte and not has_no_args:
                continue

            # --- scoring ---
            score = 0
            evidence = []

            if has_byte:
                score += 3
                evidence.append("byte[] in params_raw")

            is_cctor = (name == ".cctor") or is_static_via_return
            if is_cctor:
                score += 2
                evidence.append(".cctor / static init method")

            if is_reflection_class:
                score += 1
                evidence.append("Reflection class (name or FileDescriptor field)")

            if has_no_args:
                score += 1
                evidence.append("no-arg method")

            candidates.append({
                "class_obf_name": class_name,
                "method_obf_name": name,
                "rva": rva,
                "score": score,
                "evidence": evidence,
                "param_signature": params_raw,
                "modifiers": modifiers if isinstance(modifiers, list) else modifiers.split(),
            })

    # Primary sort: score descending.
    # Tiebreaker: prefer methods that have byte[] in params (more specific hook target).
    candidates.sort(
        key=lambda c: (c["score"], 1 if "byte[] in params_raw" in c["evidence"] else 0),
        reverse=True,
    )
    return candidates[:_CAP]


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_indexed_classes() -> dict:
    """
    Load core + protocol-game indexed class JSONs.
    Returns {type_name: type_meta}.
    Later entries with the same name overwrite earlier ones.
    """
    classes_by_name: dict = {}
    for path in (CORE_JSON, PROTOCOL_JSON):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for t in data.get("types", []):
            name = t.get("name")
            if name:
                classes_by_name[name] = t
    return classes_by_name


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _self_test():
    classes_by_name = {
        "Foo": {
            "name": "Foo",
            "is_protoc_generated": True,
            "methods": [
                {
                    "name": "init_descriptor",
                    "params_raw": "byte[] data",
                    "modifiers": "public static",
                    "rva": "0x12345",
                    "is_protoc_generated": True,
                },
                {
                    "name": "Bar",
                    "params_raw": "int a",
                    "modifiers": "public",
                    "rva": "0x67890",
                    "is_protoc_generated": True,
                },
            ],
        },
        "FooReflection": {
            "name": "FooReflection",
            "is_protoc_generated": True,
            "methods": [
                {
                    "name": ".cctor",
                    "params_raw": "",
                    "modifiers": "static",
                    "rva": "0xAAAA",
                    "is_protoc_generated": True,
                },
                {
                    "name": "InitDesc",
                    "params_raw": "byte[] descriptor",
                    "modifiers": "public static",
                    "rva": "0xBBBB",
                    "is_protoc_generated": True,
                },
            ],
        },
        "Baz": {
            "name": "Baz",
            "is_protoc_generated": False,  # not protoc → skipped
            "methods": [
                {
                    "name": "x",
                    "params_raw": "byte[] d",
                    "modifiers": "static",
                    "rva": "0xCCCC",
                    "is_protoc_generated": False,
                },
            ],
        },
    }

    candidates = find_candidates(classes_by_name)

    rva_set = {c["rva"] for c in candidates}
    assert "0x12345" in rva_set, f"0x12345 not found: {rva_set}"
    assert "0xAAAA" in rva_set, f"0xAAAA not found: {rva_set}"
    assert "0xBBBB" in rva_set, f"0xBBBB not found: {rva_set}"
    assert "0xCCCC" not in rva_set, f"0xCCCC should be absent: {rva_set}"

    # Highest score should be InitDesc (byte[] in Reflection class)
    top = candidates[0]
    assert top["rva"] == "0xBBBB", f"Expected 0xBBBB as top, got {top['rva']}"
    assert top["class_obf_name"] == "FooReflection", f"Expected FooReflection, got {top['class_obf_name']}"
    assert top["method_obf_name"] == "InitDesc", f"Expected InitDesc, got {top['method_obf_name']}"

    print("OK find-filedescriptor-init-rvas._self_test")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Run self-test and exit")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    print(f"Loading indexed classes from {INDEXED_DIR} ...")
    classes_by_name = load_indexed_classes()
    print(f"  Total types loaded: {len(classes_by_name)}")

    protoc_count = sum(1 for t in classes_by_name.values() if t.get("is_protoc_generated"))
    print(f"  Protoc-generated types: {protoc_count}")

    print("Finding FileDescriptor init candidates ...")
    candidates = find_candidates(classes_by_name)

    total = len(candidates)
    high_score = sum(1 for c in candidates if c["score"] >= 4)
    print(f"  Total candidates (cap {_CAP}): {total}")
    print(f"  Candidates with score >= 4: {high_score}")

    print("\nTop 10 candidates:")
    for i, c in enumerate(candidates[:10]):
        print(
            f"  [{i+1:2d}] score={c['score']}  {c['class_obf_name']}.{c['method_obf_name']}"
            f"  rva={c['rva']}  evidence={c['evidence']}"
        )

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(candidates, fh, indent=2)
    print(f"\nWrote {total} candidates to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
