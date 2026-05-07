#!/usr/bin/env python3
"""
Match our 1323 obfuscated Dofus 3 messages (extracted from decompiled IL via
proto-schema-decompiled.json) against the ModulX/dofus-unity-proto reference
catalogue (an older but compatible Dofus Unity build with clear .proto names).

Strategy:
  Ankama preserves Protobuf wire format across builds (backward compat). So
  for any message that exists in both versions, the field tags + wire types
  are identical. We compute a canonical signature for each message and match
  by it.

  Signature = sorted tuple of (tag, normalized_wire_type, label). Field names
  are ignored (they're obfuscated on our side).

  Type normalization: collapse all message-type fields to "MESSAGE", all enums
  to "ENUM", primitives stay as-is. This way two messages match even if their
  sub-message types are themselves obfuscated.

Output:
  dofus-app/data/indexed/proto-name-mapping.json  — { obf_v3 → real_proto_name }
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from google.protobuf import descriptor_pb2

REF_DESCRIPTOR_SET = Path("dofus-app/data/external/dofus-unity-proto/game.descriptorset.binpb")
REF_MAPPING = Path("dofus-app/data/external/dofus-unity-proto/game_mappings.json")
OUR_SCHEMA = Path("dofus-app/data/proto-schema-decompiled.json")
OUT_PATH = Path("dofus-app/data/indexed/proto-name-mapping.json")


def normalize_csharp_type(csharp_type: str) -> str:
    """Normalize a C# type name from our extracted schema to a Protobuf-like wire-type token."""
    t = csharp_type.strip()
    # Strip 'readonly' qualifier and collection wrappers
    t = t.replace("readonly ", "")
    if t.startswith("RepeatedField<") or t.startswith("MapField<"):
        # Drop the collection wrapper, recurse on inner type for tag-comparison purposes
        inner = t[t.find("<") + 1 : t.rfind(">")]
        # MapField<K,V> on the wire is repeated message{key,value}
        if t.startswith("MapField<"):
            return "MAP"
        return f"REPEATED:{normalize_csharp_type(inner.strip())}"
    if "<" in t:
        # Generic — collapse
        t = t.split("<", 1)[0]
    # Primitives
    primitives = {"int", "uint", "long", "ulong", "bool", "string", "float",
                  "double", "byte", "sbyte", "short", "ushort", "ByteString"}
    if t in primitives:
        return t.lower()
    # object => oneof storage; treated as MESSAGE
    if t == "object":
        return "MESSAGE"
    # Anything else (single-token type name like 'kew', 'jyl', etc.) is either
    # a sub-message OR an enum — both are encoded with varint/length-delimited.
    # We can't distinguish here without more info, so collapse to ENUM_OR_MSG.
    return "ENUM_OR_MSG"


def normalize_pb_type(field: descriptor_pb2.FieldDescriptorProto) -> str:
    """Normalize a Protobuf FieldDescriptorProto type to a comparable token."""
    t = field.type
    is_repeated = field.label == field.LABEL_REPEATED
    type_map = {
        field.TYPE_DOUBLE:   "double",
        field.TYPE_FLOAT:    "float",
        field.TYPE_INT64:    "long",
        field.TYPE_UINT64:   "ulong",
        field.TYPE_INT32:    "int",
        field.TYPE_FIXED64:  "ulong",
        field.TYPE_FIXED32:  "uint",
        field.TYPE_BOOL:     "bool",
        field.TYPE_STRING:   "string",
        field.TYPE_GROUP:    "MESSAGE",
        field.TYPE_MESSAGE:  "MESSAGE",
        field.TYPE_BYTES:    "bytestring",
        field.TYPE_UINT32:   "uint",
        field.TYPE_ENUM:     "ENUM_OR_MSG",  # we can't tell apart on our side
        field.TYPE_SFIXED32: "int",
        field.TYPE_SFIXED64: "long",
        field.TYPE_SINT32:   "int",
        field.TYPE_SINT64:   "long",
    }
    base = type_map.get(t, "UNKNOWN")
    if base == "MESSAGE":
        # Could be a map (Protobuf maps are encoded as repeated message)
        # Detect via the type_name pattern: typically contains "Entry"
        if is_repeated and field.type_name.endswith("Entry"):
            return "MAP"
        base = "MESSAGE"
    if is_repeated:
        return f"REPEATED:{base}"
    return base


def signature_from_pb_message(msg: descriptor_pb2.DescriptorProto) -> tuple:
    """Canonical signature for a reference (clear) message."""
    fields = sorted(
        (f.number, normalize_pb_type(f))
        for f in msg.field
    )
    return (len(fields), tuple(fields))


def signature_from_our_message(msg: dict) -> tuple:
    """Canonical signature for one of our extracted messages.

    Our schema entries look like { "obf": "gui", "fields": [{"tag": 1, "type": "object", "backing": "..."}] }.
    """
    fields = sorted(
        (f["tag"], normalize_csharp_type(f["type"]))
        for f in msg["fields"]
    )
    return (len(fields), tuple(fields))


def signatures_compatible(ours: tuple, theirs: tuple) -> bool:
    """Compatibility check that allows our 'ENUM_OR_MSG' to match either MESSAGE or ENUM_OR_MSG."""
    n_ours, fields_ours = ours
    n_theirs, fields_theirs = theirs
    if n_ours != n_theirs:
        return False
    for (t1, ty1), (t2, ty2) in zip(fields_ours, fields_theirs):
        if t1 != t2:
            return False
        # Exact match
        if ty1 == ty2:
            continue
        # Treat MESSAGE / ENUM_OR_MSG as interchangeable
        msg_like = {"MESSAGE", "ENUM_OR_MSG"}
        if ty1 in msg_like and ty2 in msg_like:
            continue
        # Repeated variants
        if ty1.startswith("REPEATED:") and ty2.startswith("REPEATED:"):
            inner1 = ty1.split(":", 1)[1]
            inner2 = ty2.split(":", 1)[1]
            if inner1 == inner2:
                continue
            if inner1 in msg_like and inner2 in msg_like:
                continue
        return False
    return True


def walk_messages(file_proto, fq_prefix: str = ""):
    """Yield every message (top-level and nested) with its FQN."""
    for msg in file_proto.message_type:
        yield from _walk_one(msg, fq_prefix or file_proto.package)


def _walk_one(msg, parent_fqn: str):
    full = f"{parent_fqn}.{msg.name}" if parent_fqn else msg.name
    yield (full, msg)
    for nested in msg.nested_type:
        yield from _walk_one(nested, full)


def main() -> int:
    # Load reference descriptor set (ModulX clear .proto)
    fds = descriptor_pb2.FileDescriptorSet()
    fds.ParseFromString(REF_DESCRIPTOR_SET.read_bytes())
    print(f"[*] Loaded reference: {len(fds.file)} .proto files")

    # Build ref signature → list of (fqn, simple_name)
    ref_sig_to_msgs: dict[tuple, list[tuple[str, str, str]]] = defaultdict(list)
    n_ref_msgs = 0
    for fp in fds.file:
        if not fp.name.endswith(".proto"):
            continue
        # Skip google/protobuf well-known types
        if fp.name.startswith("google/"):
            continue
        for fqn, msg in walk_messages(fp):
            sig = signature_from_pb_message(msg)
            ref_sig_to_msgs[sig].append((fqn, msg.name, fp.name))
            n_ref_msgs += 1
    print(f"[*] Indexed {n_ref_msgs} reference messages → {len(ref_sig_to_msgs)} unique signatures")

    # Load OUR Dofus 3 messages — flat dict { obf_name: { fields: [...] } }
    raw = json.loads(OUR_SCHEMA.read_text(encoding="utf-8"))
    our_msgs = []
    for obf, meta in raw.items():
        our_msgs.append({"obf": obf, "fields": meta.get("fields", []), "namespace": meta.get("namespace", "")})
    print(f"[*] Loaded {len(our_msgs)} obfuscated Dofus 3 messages")

    # Match
    matches = []
    n_unique = n_ambiguous = n_unmatched = 0
    for m in our_msgs:
        obf = m.get("obf") or m.get("name")
        sig = signature_from_our_message(m)
        # Exact match first
        candidates = ref_sig_to_msgs.get(sig, [])
        if not candidates:
            # Try compatibility match (looser on MESSAGE/ENUM_OR_MSG)
            for ref_sig, ref_list in ref_sig_to_msgs.items():
                if signatures_compatible(sig, ref_sig):
                    candidates = candidates + ref_list
        if not candidates:
            n_unmatched += 1
            matches.append({"obf": obf, "field_count": sig[0], "matched": False})
            continue
        if len(candidates) == 1:
            n_unique += 1
            fqn, simple, file = candidates[0]
            matches.append({
                "obf": obf,
                "field_count": sig[0],
                "matched": True,
                "ambiguous": False,
                "real_name": simple,
                "real_fqn": fqn,
                "source_file": file,
            })
        else:
            n_ambiguous += 1
            matches.append({
                "obf": obf,
                "field_count": sig[0],
                "matched": True,
                "ambiguous": True,
                "candidates": [
                    {"name": c[1], "fqn": c[0], "file": c[2]}
                    for c in candidates
                ],
            })

    print(f"\n[*] Match results:")
    print(f"    unique:     {n_unique}  ({n_unique * 100 // len(our_msgs)}%)")
    print(f"    ambiguous:  {n_ambiguous} ({n_ambiguous * 100 // len(our_msgs)}%)")
    print(f"    unmatched:  {n_unmatched} ({n_unmatched * 100 // len(our_msgs)}%)")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(
            {
                "stats": {
                    "our_messages": len(our_msgs),
                    "reference_messages": n_ref_msgs,
                    "unique_matches": n_unique,
                    "ambiguous_matches": n_ambiguous,
                    "unmatched": n_unmatched,
                },
                "matches": matches,
            },
            indent=1, ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"[*] Wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
