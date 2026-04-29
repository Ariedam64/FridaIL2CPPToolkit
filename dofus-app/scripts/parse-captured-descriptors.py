#!/usr/bin/env python3
"""
Task J2.3 — Parse byte[] FileDescriptorProto data captured at runtime.

Reads: dofus-app/data/runtime/protobuf-descriptors-captured.json
         (list of {class_obf_name, method_obf_name, rva, bytes_hex, captured_at_ms})
Cross-refs: dofus-app/data/proto-schema-decompiled.json
Emits: dofus-app/data/runtime/filedescriptor-init-rename.json  (list of RenameEntry)

Structure of proto-schema-decompiled.json (verified 2026-04-29):
  {
    "<obf_name>": {
      "namespace": ".",          -- always "." (no useful package)
      "fieldCount": <int>,
      "fields": [
        {
          "tag":          <int>,   -- protobuf field number
          "tagConst":     "<obf>", -- obf name of the tag constant field
          "type":         "<str>", -- decompiled C# type: "int", "long", "bool",
                                   --   "string", "Any", "object",
                                   --   "readonly RepeatedField<X>",
                                   --   "readonly MapField<K,V>",
                                   --   or an obf class name / "obf.obf"
          "backingField": "<obf>"
        }, ...
      ]
    }, ...
  }
  1 323 top-level keys.

Type-normalisation strategy:
  The existing schema uses C# type strings; FDP uses TYPE_* integers.
  We map FDP TYPE_* integers → a normalised bucket that can be compared
  against the existing schema's type strings:

      TYPE_INT32/SINT32/UINT32/SFIXED32/FIXED32  → "int-like"
      TYPE_INT64/SINT64/UINT64/SFIXED64/FIXED64  → "long-like"
      TYPE_BOOL                                  → "bool"
      TYPE_STRING                                → "string"
      TYPE_BYTES                                 → "bytes"
      TYPE_FLOAT                                 → "float"
      TYPE_DOUBLE                                → "double"
      TYPE_MESSAGE                               → "message"   (complex / Any / obf-class)
      TYPE_ENUM                                  → "enum"

  The existing schema similarly buckets:
      "int"                                      → "int-like"
      "long"                                     → "long-like"
      "bool"                                     → "bool"
      "string"                                   → "string"
      "bytes"                                    → "bytes"   (never observed but kept)
      "Any" | "object"                           → "message"
      "readonly RepeatedField<*>"                → "message"  (repeated → still message)
      "readonly MapField<*>"                     → "message"
      anything else (obf class name / dotted)    → "message"

  Signature = frozenset of (tag, bucket) pairs for all fields.
  A frozenset is used (not tuple-of-sorted) so field order doesn't matter.
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_INPUT = _REPO_ROOT / "data" / "runtime" / "protobuf-descriptors-captured.json"
_DEFAULT_OUTPUT = _REPO_ROOT / "data" / "runtime" / "filedescriptor-init-rename.json"
_SCHEMA_PATH = _REPO_ROOT / "data" / "proto-schema-decompiled.json"

# Make sure we can import sibling schema module
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _rename_schema import RenameEntry, write_entries  # noqa: E402


# ---------------------------------------------------------------------------
# Type normalisation
# ---------------------------------------------------------------------------
def _fdp_type_bucket(type_int: int) -> str:
    """Map a FieldDescriptorProto TYPE_* integer to a normalised bucket."""
    from google.protobuf.descriptor_pb2 import FieldDescriptorProto as FDP
    INT_LIKE = {FDP.TYPE_INT32, FDP.TYPE_SINT32, FDP.TYPE_UINT32,
                FDP.TYPE_SFIXED32, FDP.TYPE_FIXED32}
    LONG_LIKE = {FDP.TYPE_INT64, FDP.TYPE_SINT64, FDP.TYPE_UINT64,
                 FDP.TYPE_SFIXED64, FDP.TYPE_FIXED64}
    if type_int in INT_LIKE:
        return "int-like"
    if type_int in LONG_LIKE:
        return "long-like"
    if type_int == FDP.TYPE_BOOL:
        return "bool"
    if type_int == FDP.TYPE_STRING:
        return "string"
    if type_int == FDP.TYPE_BYTES:
        return "bytes"
    if type_int == FDP.TYPE_FLOAT:
        return "float"
    if type_int == FDP.TYPE_DOUBLE:
        return "double"
    if type_int == FDP.TYPE_MESSAGE:
        return "message"
    if type_int == FDP.TYPE_ENUM:
        return "enum"
    return f"unknown_{type_int}"


def _schema_type_bucket(type_str: str) -> str:
    """Map a decompiled C# type string to the same normalised bucket."""
    t = type_str.strip()
    if t == "int":
        return "int-like"
    if t == "long":
        return "long-like"
    if t == "bool":
        return "bool"
    if t == "string":
        return "string"
    if t in ("bytes", "ByteString"):
        return "bytes"
    if t == "float":
        return "float"
    if t == "double":
        return "double"
    # Everything else: Any, object, obf class name, RepeatedField<X>, MapField<K,V>
    return "message"


# ---------------------------------------------------------------------------
# Parse one descriptor
# ---------------------------------------------------------------------------
def parse_one_descriptor(
    bytes_hex: str,
) -> tuple[str, str, list[tuple[str, list[tuple[str, int, int]]]]]:
    """
    Parse a hex-encoded FileDescriptorProto.

    Returns:
        (fdp_name, fdp_package, messages)
        where messages = [(msg_name, [(field_name, tag, type_int), ...]), ...]
    """
    from google.protobuf.descriptor_pb2 import FileDescriptorProto

    raw = bytes.fromhex(bytes_hex)
    fdp = FileDescriptorProto()
    fdp.ParseFromString(raw)

    messages = []
    for msg in fdp.message_type:
        fields = [(f.name, f.number, f.type) for f in msg.field]
        messages.append((msg.name, fields))

    return fdp.name, fdp.package, messages


# ---------------------------------------------------------------------------
# Build signature index from existing schema
# ---------------------------------------------------------------------------
def _build_sig_index(
    schema: dict,
) -> tuple[dict[frozenset, str], dict[frozenset, list[str]]]:
    """
    Build two dicts:
      unique_sig_to_obf : sig → obf_name   (only sigs that map to exactly one class)
      ambiguous_sigs    : sig → [obf_name, ...]  (sig matches 2+ classes — excluded)

    Sig = frozenset of (tag, bucket) for all fields.
    """
    sig_to_obf: dict[frozenset, list[str]] = {}
    for obf_name, entry in schema.items():
        fields = entry.get("fields", [])
        sig = frozenset(
            (f["tag"], _schema_type_bucket(f.get("type", "")))
            for f in fields
        )
        sig_to_obf.setdefault(sig, []).append(obf_name)

    unique: dict[frozenset, str] = {}
    ambiguous: dict[frozenset, list[str]] = {}
    for sig, names in sig_to_obf.items():
        if len(names) == 1:
            unique[sig] = names[0]
        else:
            ambiguous[sig] = names

    return unique, ambiguous


# ---------------------------------------------------------------------------
# Core cross-ref
# ---------------------------------------------------------------------------
def cross_ref_to_obf(
    captures: list[dict],
    schema: dict,
) -> list[RenameEntry]:
    """
    For each captured descriptor, parse it and cross-ref against the schema.
    Returns a de-duped list of RenameEntry, sorted by obf_name.
    """
    unique_sig, ambiguous_sig = _build_sig_index(schema)
    entries: dict[str, RenameEntry] = {}  # obf_name → RenameEntry (first wins)

    for cap in captures:
        caller_class = cap.get("class_obf_name", "?")
        bytes_hex = cap.get("bytes_hex", "")
        if not bytes_hex:
            warnings.warn(f"[parse-captured-descriptors] Empty bytes_hex for {caller_class}, skipping")
            continue

        try:
            fdp_name, fdp_pkg, messages = parse_one_descriptor(bytes_hex)
        except Exception as exc:
            warnings.warn(
                f"[parse-captured-descriptors] Failed to parse descriptor from "
                f"{caller_class}: {exc}"
            )
            continue

        namespace = fdp_pkg if fdp_pkg else ""

        for msg_name, fields in messages:
            fdp_sig = frozenset(
                (tag, _fdp_type_bucket(type_int))
                for (_, tag, type_int) in fields
            )

            # Special case: if the caller class is in the schema, prefer it
            # when this message's sig also matches it.
            preferred_obf: str | None = None
            if caller_class in schema:
                caller_entry = schema[caller_class]
                caller_fields = caller_entry.get("fields", [])
                caller_sig = frozenset(
                    (f["tag"], _schema_type_bucket(f.get("type", "")))
                    for f in caller_fields
                )
                if caller_sig == fdp_sig:
                    preferred_obf = caller_class

            matched_obf: str | None = preferred_obf
            if matched_obf is None:
                if fdp_sig in ambiguous_sig:
                    print(
                        f"[parse-captured-descriptors] AMBIGUOUS sig for "
                        f"{msg_name} (file={fdp_name}, caller={caller_class}) — skipping",
                        file=sys.stderr,
                    )
                    continue
                matched_obf = unique_sig.get(fdp_sig)

            if matched_obf is None:
                print(
                    f"[parse-captured-descriptors] No sig match for "
                    f"{msg_name} (file={fdp_name}, caller={caller_class})",
                    file=sys.stderr,
                )
                continue

            if matched_obf in entries:
                continue  # first occurrence wins (already highest-confidence)

            entries[matched_obf] = RenameEntry(
                obf_name=matched_obf,
                original_name=msg_name,
                namespace=namespace,
                confidence="high_runtime",
                evidence_source="filedescriptor_hook",
                evidence_detail=(
                    f"file={fdp_name}, captured via {caller_class}"
                ),
            )

    return sorted(entries.values(), key=lambda e: e.obf_name)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
def _self_test() -> None:
    import tempfile
    from google.protobuf.descriptor_pb2 import FileDescriptorProto, FieldDescriptorProto

    # --- build a synthetic FDP ---
    fdp = FileDescriptorProto()
    fdp.name = "test.proto"
    fdp.package = "Ankama.Test"
    msg = fdp.message_type.add()
    msg.name = "FooMessage"
    f1 = msg.field.add()
    f1.name = "id"; f1.number = 1; f1.type = FieldDescriptorProto.TYPE_INT32
    f2 = msg.field.add()
    f2.name = "label"; f2.number = 2; f2.type = FieldDescriptorProto.TYPE_STRING
    raw_hex = fdp.SerializeToString().hex()

    # --- verify parse_one_descriptor ---
    name, pkg, msgs = parse_one_descriptor(raw_hex)
    assert name == "test.proto", f"Expected test.proto, got {name!r}"
    assert pkg == "Ankama.Test", f"Expected Ankama.Test, got {pkg!r}"
    assert msgs[0][0] == "FooMessage", f"Expected FooMessage, got {msgs[0][0]!r}"
    assert msgs[0][1][0] == ("id", 1, FieldDescriptorProto.TYPE_INT32), \
        f"Unexpected first field: {msgs[0][1][0]}"

    # --- build synthetic existing schema ---
    # Structure matches proto-schema-decompiled.json:
    #   {obf_name: {namespace, fieldCount, fields: [{tag, type, ...}]}}
    # FooMessage has fields: tag=1 TYPE_INT32 ("int-like") and tag=2 TYPE_STRING ("string")
    synthetic_schema = {
        "abc": {
            "namespace": ".",
            "fieldCount": 2,
            "fields": [
                {"tag": 1, "tagConst": "x1", "type": "int", "backingField": "b1"},
                {"tag": 2, "tagConst": "x2", "type": "string", "backingField": "b2"},
            ],
        },
        # A second class with same sig → would make it ambiguous if we add it;
        # keep it distinct here so we get a unique match.
        "xyz": {
            "namespace": ".",
            "fieldCount": 1,
            "fields": [
                {"tag": 1, "tagConst": "y1", "type": "long", "backingField": "c1"},
            ],
        },
    }

    captured = [
        {
            "class_obf_name": "abc",
            "method_obf_name": "init",
            "rva": "0x123",
            "bytes_hex": raw_hex,
            "captured_at_ms": 1234567890,
        }
    ]

    results = cross_ref_to_obf(captured, synthetic_schema)
    # caller_class "abc" is in schema AND its sig matches FooMessage → preferred match
    assert len(results) == 1, f"Expected 1 entry, got {len(results)}: {results}"
    assert results[0].obf_name == "abc", f"Expected obf=abc, got {results[0].obf_name}"
    assert results[0].original_name == "FooMessage"
    assert results[0].confidence == "high_runtime"
    assert results[0].evidence_source == "filedescriptor_hook"
    assert "test.proto" in results[0].evidence_detail

    # --- test with temp file round-trip ---
    with tempfile.TemporaryDirectory() as td:
        out_path = Path(td) / "out.json"
        n = write_entries(results, out_path)
        assert n == 1
        loaded = json.loads(out_path.read_text(encoding="utf-8"))
        assert loaded[0]["obf_name"] == "abc"
        assert loaded[0]["original_name"] == "FooMessage"

    print("OK parse-captured-descriptors._self_test")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Parse captured FileDescriptorProto bytes and emit RenameEntry rows."
    )
    parser.add_argument("--self-test", action="store_true", help="Run internal self-test and exit")
    parser.add_argument("--input", default=str(_DEFAULT_INPUT),
                        help=f"Path to protobuf-descriptors-captured.json (default: {_DEFAULT_INPUT})")
    parser.add_argument("--output", default=str(_DEFAULT_OUTPUT),
                        help=f"Path to output rename JSON (default: {_DEFAULT_OUTPUT})")
    args = parser.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    input_path = Path(args.input)
    output_path = Path(args.output)

    # --- load captures ---
    if not input_path.exists():
        print(
            f"[parse-captured-descriptors] Input not found: {input_path} — "
            "no captures yet; writing empty output.",
            file=sys.stderr,
        )
        n = write_entries([], output_path)
        print(f"[parse-captured-descriptors] Wrote {n} entries to {output_path}")
        return 0

    raw = input_path.read_text(encoding="utf-8")
    try:
        captures = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"[parse-captured-descriptors] JSON parse error in {input_path}: {exc}", file=sys.stderr)
        return 1

    if not isinstance(captures, list) or len(captures) == 0:
        print(
            "[parse-captured-descriptors] Captures list is empty -- "
            "no captures yet; writing empty output.",
            file=sys.stderr,
        )
        n = write_entries([], output_path)
        print(f"[parse-captured-descriptors] Wrote {n} entries to {output_path}")
        return 0

    # --- load existing schema ---
    if not _SCHEMA_PATH.exists():
        print(f"[parse-captured-descriptors] Schema not found: {_SCHEMA_PATH}", file=sys.stderr)
        return 1

    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    if not isinstance(schema, dict):
        print(f"[parse-captured-descriptors] Unexpected schema type: {type(schema)}", file=sys.stderr)
        return 1

    print(f"[parse-captured-descriptors] Loaded {len(captures)} capture(s), "
          f"{len(schema)} schema entries")

    # --- cross-ref ---
    entries = cross_ref_to_obf(captures, schema)

    # --- write output ---
    n = write_entries(entries, output_path)
    print(f"[parse-captured-descriptors] Wrote {n} entries to {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
