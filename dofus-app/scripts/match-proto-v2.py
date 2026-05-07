#!/usr/bin/env python3
"""
Matcher v2: signature 1:1 + iterative propagation via sub-message references.

Improvements over v1:
  1. Two-sided 1:1 matching: a candidate is "confirmed" only when a single
     reference message has its signature AND a single one of OUR messages
     has the same signature. This eliminates the "OutfitEquipObjectBestSlotResponse
     matches everyone with 1 field" false positives.
  2. Iterative propagation: once N messages are confirmed, we re-walk the
     graph using sub-message references. If our `xyz` references our `abc`
     at field tag 3, and the reference says `Foo` references `Bar` at the
     same tag 3, and `Bar`↔`abc` is already confirmed, then `xyz`↔`Foo` becomes
     more likely (boost the score).
  3. Trivial signature filter: signatures with field_count ≤ 1 OR all-primitive
     are dropped from the unique-match candidate pool.

Output:
  dofus-app/data/indexed/proto-name-mapping-v2.json
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from google.protobuf import descriptor_pb2

REF_DESCRIPTOR_SET = Path("dofus-app/data/external/dofus-unity-proto/game.descriptorset.binpb")
OUR_SCHEMA = Path("dofus-app/data/proto-schema-decompiled.json")
OUT_PATH = Path("dofus-app/data/indexed/proto-name-mapping-v2.json")


# ----- helpers (reused from v1) -----

def normalize_csharp_type(csharp_type: str) -> str:
    t = csharp_type.replace("readonly ", "").strip()
    if t.startswith("RepeatedField<") or t.startswith("MapField<"):
        if t.startswith("MapField<"):
            return "MAP"
        inner = t[t.find("<") + 1 : t.rfind(">")]
        return f"REPEATED:{normalize_csharp_type(inner.strip())}"
    if "<" in t:
        t = t.split("<", 1)[0]
    primitives = {"int", "uint", "long", "ulong", "bool", "string", "float", "double",
                  "byte", "sbyte", "short", "ushort", "ByteString"}
    if t in primitives:
        return t.lower()
    if t == "object":
        return "OPAQUE"
    return "OPAQUE"


def normalize_pb_type(field) -> str:
    t = field.type
    is_repeated = field.label == field.LABEL_REPEATED
    type_map = {
        field.TYPE_DOUBLE: "double", field.TYPE_FLOAT: "float",
        field.TYPE_INT64: "long", field.TYPE_UINT64: "ulong",
        field.TYPE_INT32: "int", field.TYPE_FIXED64: "ulong",
        field.TYPE_FIXED32: "uint", field.TYPE_BOOL: "bool",
        field.TYPE_STRING: "string", field.TYPE_GROUP: "OPAQUE",
        field.TYPE_MESSAGE: "OPAQUE", field.TYPE_BYTES: "bytestring",
        field.TYPE_UINT32: "uint", field.TYPE_ENUM: "OPAQUE",
        field.TYPE_SFIXED32: "int", field.TYPE_SFIXED64: "long",
        field.TYPE_SINT32: "int", field.TYPE_SINT64: "long",
    }
    base = type_map.get(t, "UNKNOWN")
    if base == "OPAQUE" and is_repeated and field.type_name.endswith("Entry"):
        return "MAP"
    if is_repeated:
        return f"REPEATED:{base}"
    return base


def is_trivial_signature(sig: tuple) -> bool:
    """A signature too generic to give confidence on its own."""
    n, fields = sig
    if n <= 1:
        return True
    # All-primitive, all-int signatures: too common
    types = [t for _, t in fields]
    primitives = {"int", "long", "bool", "string", "uint", "ulong", "float", "double", "bytestring"}
    if all(t in primitives for t in types):
        # Allow if at least 4 fields (more entropy)
        if n < 4:
            return True
    return False


def signature_from_pb(msg) -> tuple:
    return (len(msg.field), tuple(sorted((f.number, normalize_pb_type(f)) for f in msg.field)))


def signature_from_ours(msg: dict) -> tuple:
    return (len(msg["fields"]), tuple(sorted((f["tag"], normalize_csharp_type(f["type"])) for f in msg["fields"])))


def walk_messages(file_proto):
    pkg = file_proto.package
    for msg in file_proto.message_type:
        yield from _walk_one(msg, pkg, file_proto.name)


def _walk_one(msg, parent_fqn, file_name):
    full = f"{parent_fqn}.{msg.name}" if parent_fqn else msg.name
    yield (full, msg.name, file_name, msg)
    for nested in msg.nested_type:
        yield from _walk_one(nested, full, file_name)


def main() -> int:
    # Load reference
    fds = descriptor_pb2.FileDescriptorSet()
    fds.ParseFromString(REF_DESCRIPTOR_SET.read_bytes())

    # Build reference index
    ref_msgs = []  # list of (fqn, simple, file, msg)
    for fp in fds.file:
        if fp.name.startswith("google/"):
            continue
        for entry in walk_messages(fp):
            ref_msgs.append(entry)
    print(f"[*] {len(ref_msgs)} reference messages")

    # ref signature buckets
    ref_sig_buckets = defaultdict(list)
    for entry in ref_msgs:
        fqn, simple, file, msg = entry
        sig = signature_from_pb(msg)
        ref_sig_buckets[sig].append(entry)

    # Load ours
    raw = json.loads(OUR_SCHEMA.read_text(encoding="utf-8"))
    our_msgs = [{"obf": k, "fields": v.get("fields", [])} for k, v in raw.items()]
    print(f"[*] {len(our_msgs)} our messages")

    # Our signature buckets
    our_sig_buckets = defaultdict(list)
    for m in our_msgs:
        sig = signature_from_ours(m)
        our_sig_buckets[sig].append(m["obf"])

    # ---- Pass 1: signature uniqueness on the ref side, non-trivial sig ----
    # If exactly one ref message has signature S, then any of OUR messages
    # with signature S is unambiguously identified to that ref name (modulo
    # versions: we may have new messages that also happen to share S — see
    # below).
    confirmed = {}
    for sig, ours_list in our_sig_buckets.items():
        ref_list = ref_sig_buckets.get(sig, [])
        if not ref_list:
            continue
        if is_trivial_signature(sig):
            continue
        if len(ref_list) == 1:
            fqn, simple, file, _ = ref_list[0]
            # If multiple of OUR messages share this sig and only one ref,
            # we can't tell which of ours IS the ref — they're collisions.
            # Still record them as "ambiguous on our side" so propagation
            # can disambiguate.
            if len(ours_list) == 1:
                confirmed[ours_list[0]] = {
                    "real_name": simple,
                    "real_fqn": fqn,
                    "source_file": file,
                    "confidence": "high_unique_sig",
                }
            else:
                # Collisions on our side: each is a candidate but only one
                # is the real match. Record as ambiguous.
                for obf in ours_list:
                    pass  # handled in candidates_map below

    print(f"[*] Pass 1 (unique ref sig, non-trivial): {len(confirmed)} confirmed")

    # ---- Pass 2: many-to-many disambiguation ----
    # For sigs where N≥2 on both sides, we can't disambiguate from signature
    # alone — collect them as "candidates_set".
    candidates_map = {}  # obf -> [candidate refs]
    for sig, ours_list in our_sig_buckets.items():
        ref_list = ref_sig_buckets.get(sig, [])
        if not ref_list:
            continue
        if all(o in confirmed for o in ours_list):
            continue
        for obf in ours_list:
            if obf in confirmed:
                continue
            candidates_map.setdefault(obf, []).extend(ref_list)

    # ---- Pass 3: propagation via sub-message references ----
    # Build adjacency: for each our_message, list of (tag → referenced_obf).
    # For each ref message, list of (tag → referenced_fqn).
    our_refs_by_tag = {}  # obf -> { tag: referenced_obf }
    for m in our_msgs:
        d = {}
        for f in m["fields"]:
            ty = normalize_csharp_type(f["type"])
            # Extract referenced obf if the C# type is itself an obfuscated class
            raw_t = f["type"].replace("readonly ", "").strip()
            if raw_t.startswith("RepeatedField<"):
                raw_t = raw_t[len("RepeatedField<"):-1].strip()
            elif raw_t.startswith("MapField<"):
                continue
            # Drop Generic<>
            if "<" in raw_t:
                raw_t = raw_t.split("<", 1)[0]
            # If it looks like an obf token (lowercase 1-3 chars)
            if raw_t and raw_t[0].islower() and 1 <= len(raw_t) <= 5:
                d[f["tag"]] = raw_t
        if d:
            our_refs_by_tag[m["obf"]] = d

    ref_refs_by_tag = {}  # fqn -> { tag: referenced_fqn (the ref's resolved type_name) }
    for fqn, simple, file, msg in ref_msgs:
        d = {}
        for f in msg.field:
            if f.type == f.TYPE_MESSAGE and f.type_name:
                # type_name comes as ".package.MessageName"; strip leading dot
                ref_fqn = f.type_name.lstrip(".")
                d[f.number] = ref_fqn
        if d:
            ref_refs_by_tag[fqn] = d

    # Build reverse map: fqn -> simple name (for ref)
    fqn_to_simple = {fqn: simple for fqn, simple, _, _ in ref_msgs}

    # Iterative propagation: for ambiguous candidates, count compatible
    # outgoing references against confirmed mappings.
    changed = True
    iter_count = 0
    while changed and iter_count < 5:
        changed = False
        iter_count += 1
        new_confirmed = {}
        for obf, candidates in list(candidates_map.items()):
            if obf in confirmed:
                continue
            our_refs = our_refs_by_tag.get(obf, {})
            if not our_refs:
                continue
            scores = {}  # candidate_fqn -> compatibility score
            for fqn, simple, file, msg in candidates:
                ref_refs = ref_refs_by_tag.get(fqn, {})
                if not ref_refs:
                    continue
                score = 0
                for tag, our_target_obf in our_refs.items():
                    if our_target_obf in confirmed:
                        # The confirmed ref name for our_target_obf
                        confirmed_ref_simple = confirmed[our_target_obf]["real_name"]
                        # The ref's outgoing target at the same tag
                        their_target_fqn = ref_refs.get(tag)
                        if their_target_fqn:
                            their_target_simple = fqn_to_simple.get(their_target_fqn, their_target_fqn.rsplit(".", 1)[-1])
                            if their_target_simple == confirmed_ref_simple:
                                score += 2
                            else:
                                score -= 1  # conflict
                    elif tag in ref_refs:
                        score += 0  # neutral; can't decide yet
                if score > 0:
                    scores[(fqn, simple, file)] = score
            if scores:
                # If a single candidate has highest score and uniquely
                top_score = max(scores.values())
                top = [k for k, v in scores.items() if v == top_score]
                if len(top) == 1 and top_score >= 2:
                    fqn, simple, file = top[0]
                    new_confirmed[obf] = {
                        "real_name": simple,
                        "real_fqn": fqn,
                        "source_file": file,
                        "confidence": f"propagation_iter{iter_count}_score{top_score}",
                    }
        if new_confirmed:
            confirmed.update(new_confirmed)
            changed = True
            print(f"[*] Iter {iter_count}: +{len(new_confirmed)} confirmed via propagation")

    # ---- Final report ----
    out = {
        "stats": {
            "our_messages": len(our_msgs),
            "reference_messages": len(ref_msgs),
            "confirmed_total": len(confirmed),
            "still_ambiguous": sum(1 for o in candidates_map if o not in confirmed),
            "unmatched": sum(1 for m in our_msgs if m["obf"] not in confirmed and m["obf"] not in candidates_map),
        },
        "confirmed": [
            {"obf": obf, **info}
            for obf, info in sorted(confirmed.items())
        ],
        "ambiguous": [
            {
                "obf": obf,
                "candidates": [{"name": c[1], "fqn": c[0], "file": c[2]} for c in candidates],
            }
            for obf, candidates in sorted(candidates_map.items())
            if obf not in confirmed
        ],
    }

    print(f"\n[*] Final results:")
    print(f"    confirmed:   {out['stats']['confirmed_total']}")
    print(f"    ambiguous:   {out['stats']['still_ambiguous']}")
    print(f"    unmatched:   {out['stats']['unmatched']}")
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"[*] Wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
