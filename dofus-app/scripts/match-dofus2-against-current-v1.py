#!/usr/bin/env python3
"""
v1 matcher: Dofus 2 (AS3) ↔ Dofus 3 (Protobuf) with sub-signature recursion.

Improvement over v0
-------------------
v0 represented every nested message as the same opaque "msg" token, so two
messages [int, msg, msg] and [int, msg, msg] from completely different domains
collapsed onto the same signature. v1 inlines ONE level of sub-signature so
that "msg" becomes "msg{<inner-flat-sig>}" — drastically reducing collisions.

Concretely, in v0:
  MonsterInGroupInformations: [msg, msg]
  GameRolePlayArenaUpdatePlayerInfosAllQueuesMessage: [msg, msg]
  → same bucket, undecidable.

In v1:
  MonsterInGroupInformations: [msg{i32,i32,i32}, msg{i32,msg{...},rep:msg{...}}]
  → different buckets.

We do NOT recurse beyond depth 1: that would explode signature size and yield
no further discrimination (most leaves are scalars). Cycles are detected.

Output: dofus-app/data/indexed/dofus2-match-v1.json
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
OUT_PATH = Path("dofus-app/data/indexed/dofus2-match-v1.json")

AS3_SCALAR_TO_WIRE = {
    "uint": "i32",
    "int": "i32",
    "Number": "f64",
    "Boolean": "bool",
    "String": "string",
    "ByteArray": "bytes",
}

D3_SCALAR_NORMALIZE = {
    "int": "i32",
    "uint": "i32",
    "long": "i64",
    "ulong": "i64",
    "float": "f32",
    "double": "f64",
    "bool": "bool",
    "string": "string",
    "bytes": "bytes",
    "Any": "any",
}

VECTOR_RE = re.compile(r"Vector\.<([\w.<>]+)>")


# -------- side: Dofus 2 (AS3) --------------------------------------------

def as3_field_to_wire(t: str) -> tuple[str, str | None]:
    """Returns (wire_class, sub_class_name_to_resolve).
       sub_class_name is None for scalars."""
    m = VECTOR_RE.match(t)
    if m:
        inner = m.group(1)
        if inner in AS3_SCALAR_TO_WIRE:
            return ("rep:" + AS3_SCALAR_TO_WIRE[inner], None)
        return ("rep:msg", inner)  # Vector of custom type → repeated message
    if t in AS3_SCALAR_TO_WIRE:
        return (AS3_SCALAR_TO_WIRE[t], None)
    return ("msg", t)  # custom type → sub-message


def flatten_d2_top_level(klass: dict, by_name: dict[str, dict], visited: set[str] | None = None) -> list[tuple[str, str | None]]:
    """Walk parent chain and concat; returns [(wire_class, sub_name), ...] in
       AS3 serialize order (parent fields first)."""
    visited = visited or set()
    if klass["class"] in visited:
        return []
    visited.add(klass["class"])
    seq: list[tuple[str, str | None]] = []
    parent_name = klass.get("parent")
    if parent_name and parent_name in by_name:
        seq.extend(flatten_d2_top_level(by_name[parent_name], by_name, visited))
    for f in klass["fields"]:
        seq.append(as3_field_to_wire(f["type"]))
    return seq


def d2_subsig(klass_name: str, by_name: dict[str, dict]) -> str:
    """One-level signature of a D2 class as a comma-joined wire-class string.
       Scalars only — sub-messages collapsed back to plain 'msg' to avoid
       infinite recursion."""
    if klass_name not in by_name:
        return ""
    flat = flatten_d2_top_level(by_name[klass_name], by_name)
    return ",".join(w for w, _ in flat)


def d2_sig_with_inline(klass: dict, by_name: dict[str, dict]) -> list[str]:
    """v1 signature: each 'msg' token gets inlined with its sub-signature."""
    flat = flatten_d2_top_level(klass, by_name)
    out: list[str] = []
    for wire, sub_name in flat:
        if wire == "msg" and sub_name:
            out.append(f"msg{{{d2_subsig(sub_name, by_name)}}}")
        elif wire == "rep:msg" and sub_name:
            out.append(f"rep:msg{{{d2_subsig(sub_name, by_name)}}}")
        else:
            out.append(wire)
    return out


# -------- side: Dofus 3 (proto-schema-decompiled) -------------------------

D3_REPEATED_RE = re.compile(r"(?:readonly\s+)?RepeatedField<([\w.<>]+)>")
D3_MAPFIELD_RE = re.compile(r"(?:readonly\s+)?MapField<([\w.,\s]+)>")
# Some D3 fields surface as "Foo.Bar" when nested; we strip to last segment.
D3_NESTED_RE   = re.compile(r"^[\w]+\.([\w]+)$")


def d3_field_to_wire(t: str) -> tuple[str, str | None]:
    """Returns (wire_class, sub_obf_class_to_resolve)."""
    t = t.strip()
    # repeated:foo (canonical) OR readonly RepeatedField<foo> (raw decompiled)
    if t.startswith("repeated:"):
        inner = t[len("repeated:"):]
        if inner in D3_SCALAR_NORMALIZE:
            return ("rep:" + D3_SCALAR_NORMALIZE[inner], None)
        return ("rep:msg", inner)
    m = D3_REPEATED_RE.match(t)
    if m:
        inner = m.group(1).strip()
        if inner in D3_SCALAR_NORMALIZE:
            return ("rep:" + D3_SCALAR_NORMALIZE[inner], None)
        # Strip nested-class qualifier (Foo.Bar → Bar) — schema indexes by the
        # innermost name in this build.
        nm = D3_NESTED_RE.match(inner)
        if nm:
            inner = nm.group(1)
        return ("rep:msg", inner)
    if t.startswith("map:") or D3_MAPFIELD_RE.match(t):
        return ("map", None)
    if t in D3_SCALAR_NORMALIZE:
        return (D3_SCALAR_NORMALIZE[t], None)
    # Custom sub-message — unwrap nested qualifier (e.g. "kex.kew" → "kew").
    nm = D3_NESTED_RE.match(t)
    if nm:
        return ("msg", nm.group(1))
    return ("msg", t)


def d3_subsig(obf_class: str, schema: dict) -> str:
    """One-level signature of a D3 message — scalars only, sub-messages flat."""
    msg = schema.get(obf_class)
    if not msg:
        return ""
    parts: list[str] = []
    for f in msg["fields"]:
        wire, _ = d3_field_to_wire(f["type"])
        parts.append(wire)
    return ",".join(parts)


def d3_sig_with_inline(obf_class: str, schema: dict) -> list[str]:
    msg = schema.get(obf_class)
    if not msg:
        return []
    out: list[str] = []
    for f in msg["fields"]:
        wire, sub = d3_field_to_wire(f["type"])
        if wire == "msg" and sub:
            out.append(f"msg{{{d3_subsig(sub, schema)}}}")
        elif wire == "rep:msg" and sub:
            out.append(f"rep:msg{{{d3_subsig(sub, schema)}}}")
        else:
            out.append(wire)
    return out


# -------- main ------------------------------------------------------------

def main() -> int:
    if not D2_PATH.exists() or not D3_PATH.exists():
        print(f"missing input: D2={D2_PATH.exists()} D3={D3_PATH.exists()}", file=sys.stderr)
        return 1

    d2 = json.loads(D2_PATH.read_text(encoding="utf-8"))
    d3 = json.loads(D3_PATH.read_text(encoding="utf-8"))

    by_name: dict[str, dict] = {}
    for k in d2["messages"] + d2["types"]:
        by_name[k["class"]] = k

    # v1 signatures
    d2_sigs = {name: d2_sig_with_inline(by_name[name], by_name) for name in by_name}
    d3_sigs = {obf: d3_sig_with_inline(obf, d3) for obf in d3}

    # bucket by signature
    d2_by_sig: dict[tuple[str, ...], list[str]] = defaultdict(list)
    for name, sig in d2_sigs.items():
        d2_by_sig[tuple(sig)].append(name)

    matches: dict[str, dict] = {}
    perfect = ambiguous = no_match = 0
    for obf, sig in d3_sigs.items():
        candidates = d2_by_sig.get(tuple(sig), [])
        if not candidates:
            no_match += 1
        elif len(candidates) == 1:
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
                    "confidence": 1.0 / len(candidates) if candidates else 0,
                }
                for c in candidates
            ],
        }

    # Distribution of multi-candidate buckets — useful to see how flat the
    # ambiguity tail is (many ×2 vs few ×100).
    bucket_dist: dict[int, int] = defaultdict(int)
    for sig, members in d2_by_sig.items():
        bucket_dist[len(members)] += 1

    out = {
        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "version": "v1-subsig-depth1",
        "d3_total": len(d3_sigs),
        "d2_total": len(d2_sigs),
        "stats": {
            "perfect_match": perfect,
            "ambiguous": ambiguous,
            "no_match": no_match,
        },
        "d2_bucket_distribution": dict(sorted(bucket_dist.items())),
        "matches": matches,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=0, ensure_ascii=False), encoding="utf-8")

    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size/1024:.1f} KB)")
    print(f"  D3: {len(d3_sigs)}  D2: {len(d2_sigs)}")
    print(f"  perfect:    {perfect:4d}  ({100*perfect/len(d3_sigs):.1f}%)")
    print(f"  ambiguous:  {ambiguous:4d}  ({100*ambiguous/len(d3_sigs):.1f}%)")
    print(f"  no match:   {no_match:4d}  ({100*no_match/len(d3_sigs):.1f}%)")

    print("\n--- D2 bucket size distribution ---")
    for size, count in sorted(bucket_dist.items())[:12]:
        print(f"  {size:3d} D2 classes share a sig: {count:4d} buckets")

    print("\n--- 10 perfect matches (sample) ---")
    samples = [(o, m) for o, m in matches.items() if len(m["matches"]) == 1][:10]
    for o, m in samples:
        c = m["matches"][0]
        sig_preview = ",".join(m["sig"])[:80]
        print(f"  {o:>6} -> {c['d2Class']:<48} (proto {c['d2ProtoId']})")
        print(f"         sig: {sig_preview}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
