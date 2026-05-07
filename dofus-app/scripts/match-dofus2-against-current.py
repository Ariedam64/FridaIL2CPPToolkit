#!/usr/bin/env python3
"""
v0 matcher: Dofus 2 (AS3) protocol classes ↔ Dofus 3 (Protobuf) obfuscated classes.

Strategy
--------
Both protocols describe the same domain. For each message, we compute a
canonical SIGNATURE = ordered sequence of WIRE-CLASS tokens, where each token
is the abstract wire shape of a field (int32 / int64 / string / bool /
double / float / repeated / message / map / bytes).

1) Dofus 2 AS3:
   - Walk the inheritance chain (parent → ... → root) and concatenate fields in
     declaration order. AS3 serialize methods call super() FIRST, so parent
     fields come BEFORE child fields. This matches Protobuf tag order.
   - Convert each AS3 type to a wire class (uint/int → "i32", Number → "f64",
     Boolean → "bool", Vector.<T> → "rep:" + class(T), String → "string", etc.)

2) Dofus 3 protobuf:
   - Each message has explicit fields with `tag` and `type`. Sort by tag
     (already insertion-ordered), keep `type` as the wire-class.

3) Match: a Dofus 3 obfClass MATCHES a Dofus 2 class when their signature
   sequences are EQUAL. Multiple candidates = ambiguous.

Output:  dofus-app/data/indexed/dofus2-match-v0.json
         { obf3 → { matches: [ {d2Class, d2ProtoId, confidence}, ... ] } }
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

D2_PATH  = Path("dofus-app/data/external/dofus2-protocol.json")
D3_PATH  = Path("dofus-app/data/proto-schema-decompiled.json")
OUT_PATH = Path("dofus-app/data/indexed/dofus2-match-v0.json")

# AS3 -> wire-class. Uses the same vocabulary as Dofus 3 proto schema.
# `repeated` and `message` are post-processed (we stamp them after lookup).
AS3_SCALAR_TO_WIRE = {
    "uint":   "i32",
    "int":    "i32",
    "Number": "f64",
    "Boolean": "bool",
    "String":  "string",
    "ByteArray": "bytes",
}

# Dofus 3 proto schema uses these scalar names — we normalize here so that
# both sides speak the same dialect.
D3_SCALAR_NORMALIZE = {
    "int":    "i32",
    "uint":   "i32",
    "long":   "i64",
    "ulong":  "i64",
    "float":  "f32",
    "double": "f64",
    "bool":   "bool",
    "string": "string",
    "bytes":  "bytes",
}

VECTOR_RE = re.compile(r"Vector\.<([\w.<>]+)>")


def as3_type_to_wire(t: str, type_set: set[str]) -> str:
    """Map AS3 type to a wire-class token. `type_set` is the set of D2 type
    classes (custom messages) — anything in that set is treated as a sub-msg."""
    m = VECTOR_RE.match(t)
    if m:
        inner = m.group(1)
        return "rep:" + as3_type_to_wire(inner, type_set)
    if t in AS3_SCALAR_TO_WIRE:
        return AS3_SCALAR_TO_WIRE[t]
    # Otherwise: a custom AS3 type → either a known D2 message/type, or unknown.
    # Custom AS3 types (known or unknown) — both treated as opaque sub-message.
    # In Dofus 3 protobuf, sub-messages are also indistinguishable by the
    # reflective proto-schema (they're all "msg"), so collapsing both sides
    # to "msg" is the right level of detail.
    return "msg"


def d3_type_to_wire(t: str) -> str:
    if t.startswith("repeated:"):
        inner = t[len("repeated:"):]
        return "rep:" + d3_type_to_wire(inner)
    if t.startswith("map:"):
        return "map"  # too rare in current schema to worry about subtype
    if t in D3_SCALAR_NORMALIZE:
        return D3_SCALAR_NORMALIZE[t]
    if t in ("Any", "Object"):
        return "any"
    return "msg"  # any non-scalar → submessage


def flatten_d2(klass: dict, by_name: dict[str, dict], visited: set[str] | None = None) -> list[str]:
    """Walk parent chain; concat parent fields BEFORE local (matches AS3 super()
    serialize convention). Returns ordered list of wire-class tokens."""
    visited = visited or set()
    if klass["class"] in visited:
        return []
    visited.add(klass["class"])
    seq: list[str] = []
    parent_name = klass.get("parent")
    if parent_name and parent_name in by_name:
        seq.extend(flatten_d2(by_name[parent_name], by_name, visited))
    type_set = {k for k in by_name.keys()}
    for f in klass["fields"]:
        seq.append(as3_type_to_wire(f["type"], type_set))
    return seq


def main() -> int:
    if not D2_PATH.exists():
        print(f"missing: {D2_PATH}", file=sys.stderr); return 1
    if not D3_PATH.exists():
        print(f"missing: {D3_PATH}", file=sys.stderr); return 1

    d2 = json.loads(D2_PATH.read_text(encoding="utf-8"))
    d3 = json.loads(D3_PATH.read_text(encoding="utf-8"))

    # Build flat by-name index for D2 (messages + types).
    by_name: dict[str, dict] = {}
    for k in d2["messages"] + d2["types"]:
        by_name[k["class"]] = k

    # 1) Compute D2 signatures.
    d2_sigs: dict[str, list[str]] = {}
    for k in d2["messages"] + d2["types"]:
        d2_sigs[k["class"]] = flatten_d2(k, by_name)

    # 2) Compute D3 signatures.
    d3_sigs: dict[str, list[str]] = {}
    for obf, msg in d3.items():
        seq = []
        for f in msg["fields"]:
            seq.append(d3_type_to_wire(f["type"]))
        d3_sigs[obf] = seq

    # 3) Bucket D2 classes by signature.
    d2_by_sig: dict[tuple[str, ...], list[str]] = defaultdict(list)
    for name, sig in d2_sigs.items():
        d2_by_sig[tuple(sig)].append(name)

    # 4) Match D3 against D2.
    matches: dict[str, dict] = {}
    perfect = 0
    ambiguous = 0
    no_match = 0
    for obf, sig in d3_sigs.items():
        candidates = d2_by_sig.get(tuple(sig), [])
        if not candidates:
            no_match += 1
            matches[obf] = {"sig": sig, "matches": []}
            continue
        if len(candidates) == 1:
            perfect += 1
        else:
            ambiguous += 1
        matches[obf] = {
            "sig": sig,
            "matches": [
                {
                    "d2Class": c,
                    "d2ProtoId": by_name[c].get("protocolId"),
                    "d2Parent": by_name[c].get("parent"),
                    "confidence": 1.0 / len(candidates),
                }
                for c in candidates
            ],
        }

    out = {
        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "d3_total": len(d3_sigs),
        "d2_total": len(d2_sigs),
        "stats": {
            "perfect_match":    perfect,    # exactly 1 D2 candidate
            "ambiguous":        ambiguous,  # 2+ D2 candidates with same sig
            "no_match":         no_match,
        },
        "matches": matches,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=0, ensure_ascii=False), encoding="utf-8")

    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size/1024:.1f} KB)")
    print(f"  D3 messages: {len(d3_sigs)} · D2 classes: {len(d2_sigs)}")
    print(f"  perfect:    {perfect:4d}  ({100*perfect/len(d3_sigs):.1f}%)")
    print(f"  ambiguous:  {ambiguous:4d}  ({100*ambiguous/len(d3_sigs):.1f}%)")
    print(f"  no match:   {no_match:4d}  ({100*no_match/len(d3_sigs):.1f}%)")

    # Show 8 perfect-match examples to spot-check.
    print("\n--- 8 perfect matches (sample) ---")
    samples = [(o, m) for o, m in matches.items() if len(m["matches"]) == 1][:8]
    for o, m in samples:
        c = m["matches"][0]
        print(f"  {o:>6}  ->  {c['d2Class']:<40}  (proto {c['d2ProtoId']})  sig: {','.join(m['sig'])[:60]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
