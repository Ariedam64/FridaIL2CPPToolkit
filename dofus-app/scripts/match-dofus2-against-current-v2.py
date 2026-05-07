#!/usr/bin/env python3
"""
v2 matcher — same shape as v1 but with relaxed type collapsing.

The big issue with v1: AS3 has no native int64 (uint/int are 32-bit, Number is
a 64-bit double). Dofus 3 protobuf, in contrast, distinguishes int32 / int64.
v2 collapses both to "i" and both float types to "f", which is the largest
loss of fidelity worth taking — beyond that we'd start collapsing string with
bytes and lose all signal.

Also drops empty sub-sigs (`msg{}`) to plain `msg` — when the sub-message has
no parseable fields, the empty inner gives no extra discrimination and just
breaks otherwise-good matches.

Output: dofus-app/data/indexed/dofus2-match-v2.json
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
OUT_PATH = Path("dofus-app/data/indexed/dofus2-match-v2.json")

# Aggressively collapse: all ints → "i", all floats → "f". The collapsing is
# applied uniformly to both sides so they speak the same vocabulary.
def normalize(token: str) -> str:
    if token in ("i32", "i64"):
        return "i"
    if token in ("f32", "f64"):
        return "f"
    if token.startswith("rep:i32") or token.startswith("rep:i64"):
        return "rep:i"
    if token.startswith("rep:f32") or token.startswith("rep:f64"):
        return "rep:f"
    return token


# ---- AS3 ----
AS3_SCALAR_TO_WIRE = {
    "uint": "i", "int": "i",
    "Number": "f",
    "Boolean": "bool",
    "String": "string",
    "ByteArray": "bytes",
}

VECTOR_RE = re.compile(r"Vector\.<([\w.<>]+)>")


def as3_field_to_wire(t: str) -> tuple[str, str | None]:
    m = VECTOR_RE.match(t)
    if m:
        inner = m.group(1)
        if inner in AS3_SCALAR_TO_WIRE:
            return ("rep:" + AS3_SCALAR_TO_WIRE[inner], None)
        return ("rep:msg", inner)
    if t in AS3_SCALAR_TO_WIRE:
        return (AS3_SCALAR_TO_WIRE[t], None)
    return ("msg", t)


def flatten_d2_top_level(klass: dict, by_name: dict[str, dict], visited: set[str] | None = None) -> list[tuple[str, str | None]]:
    visited = visited or set()
    if klass["class"] in visited:
        return []
    visited.add(klass["class"])
    seq: list[tuple[str, str | None]] = []
    p = klass.get("parent")
    if p and p in by_name:
        seq.extend(flatten_d2_top_level(by_name[p], by_name, visited))
    for f in klass["fields"]:
        seq.append(as3_field_to_wire(f["type"]))
    return seq


def d2_subsig(name: str, by_name: dict[str, dict]) -> str:
    if name not in by_name: return ""
    return ",".join(w for w, _ in flatten_d2_top_level(by_name[name], by_name))


def d2_sig(klass: dict, by_name: dict[str, dict]) -> list[str]:
    out = []
    for w, sub in flatten_d2_top_level(klass, by_name):
        if w == "msg" and sub:
            inner = d2_subsig(sub, by_name)
            out.append("msg" if not inner else f"msg{{{inner}}}")
        elif w == "rep:msg" and sub:
            inner = d2_subsig(sub, by_name)
            out.append("rep:msg" if not inner else f"rep:msg{{{inner}}}")
        else:
            out.append(w)
    return out


# ---- D3 ----
D3_SCALAR_NORMALIZE = {
    "int":"i","uint":"i","long":"i","ulong":"i",
    "float":"f","double":"f",
    "bool":"bool","string":"string","bytes":"bytes",
    "Any":"any","object":"any",
}

D3_REPEATED_RE = re.compile(r"(?:readonly\s+)?RepeatedField<([\w.<>]+)>")
D3_MAPFIELD_RE = re.compile(r"(?:readonly\s+)?MapField<")
D3_NESTED_RE   = re.compile(r"^[\w]+\.([\w]+)$")


def d3_field_to_wire(t: str) -> tuple[str, str | None]:
    t = t.strip()
    if t.startswith("repeated:"):
        inner = t[len("repeated:"):]
        if inner in D3_SCALAR_NORMALIZE: return ("rep:" + D3_SCALAR_NORMALIZE[inner], None)
        return ("rep:msg", inner)
    m = D3_REPEATED_RE.match(t)
    if m:
        inner = m.group(1).strip()
        if inner in D3_SCALAR_NORMALIZE: return ("rep:" + D3_SCALAR_NORMALIZE[inner], None)
        nm = D3_NESTED_RE.match(inner)
        if nm: inner = nm.group(1)
        return ("rep:msg", inner)
    if t.startswith("map:") or D3_MAPFIELD_RE.match(t): return ("map", None)
    if t in D3_SCALAR_NORMALIZE: return (D3_SCALAR_NORMALIZE[t], None)
    nm = D3_NESTED_RE.match(t)
    if nm: return ("msg", nm.group(1))
    return ("msg", t)


def d3_subsig(obf: str, schema: dict) -> str:
    msg = schema.get(obf)
    if not msg: return ""
    return ",".join(d3_field_to_wire(f["type"])[0] for f in msg["fields"])


def d3_sig(obf: str, schema: dict) -> list[str]:
    msg = schema.get(obf)
    if not msg: return []
    out = []
    for f in msg["fields"]:
        w, sub = d3_field_to_wire(f["type"])
        if w == "msg" and sub:
            inner = d3_subsig(sub, schema)
            out.append("msg" if not inner else f"msg{{{inner}}}")
        elif w == "rep:msg" and sub:
            inner = d3_subsig(sub, schema)
            out.append("rep:msg" if not inner else f"rep:msg{{{inner}}}")
        else:
            out.append(w)
    return out


def normalize_sig(sig: list[str]) -> list[str]:
    """Apply normalize() to every token and to every token inside `msg{...}`."""
    out = []
    for t in sig:
        if t.startswith(("msg{", "rep:msg{")):
            prefix = "rep:msg" if t.startswith("rep:msg{") else "msg"
            inner = t[t.index("{")+1:-1]
            inner_tokens = inner.split(",") if inner else []
            inner_norm = ",".join(normalize(it) for it in inner_tokens)
            out.append(prefix if not inner_norm else f"{prefix}{{{inner_norm}}}")
        else:
            out.append(normalize(t))
    return out


def main() -> int:
    d2 = json.loads(D2_PATH.read_text(encoding="utf-8"))
    d3 = json.loads(D3_PATH.read_text(encoding="utf-8"))

    by_name = {k["class"]: k for k in d2["messages"] + d2["types"]}

    d2_sigs = {n: normalize_sig(d2_sig(by_name[n], by_name)) for n in by_name}
    d3_sigs = {o: normalize_sig(d3_sig(o, d3)) for o in d3}

    d2_by_sig = defaultdict(list)
    for name, sig in d2_sigs.items():
        d2_by_sig[tuple(sig)].append(name)

    matches = {}
    perfect = ambiguous = no_match = 0
    for obf, sig in d3_sigs.items():
        cands = d2_by_sig.get(tuple(sig), [])
        if not cands: no_match += 1
        elif len(cands) == 1: perfect += 1
        else: ambiguous += 1
        matches[obf] = {
            "sig": sig,
            "matches": [{"d2Class": c, "d2ProtoId": by_name[c].get("protocolId"),
                          "confidence": 1.0/len(cands) if cands else 0} for c in cands],
        }

    out = {
        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "version": "v2-collapse-ints-floats",
        "d3_total": len(d3_sigs), "d2_total": len(d2_sigs),
        "stats": {"perfect_match": perfect, "ambiguous": ambiguous, "no_match": no_match},
        "matches": matches,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=0, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size/1024:.1f} KB)")
    print(f"  D3: {len(d3_sigs)}  D2: {len(d2_sigs)}")
    print(f"  perfect:    {perfect:4d}  ({100*perfect/len(d3_sigs):.1f}%)")
    print(f"  ambiguous:  {ambiguous:4d}  ({100*ambiguous/len(d3_sigs):.1f}%)")
    print(f"  no match:   {no_match:4d}  ({100*no_match/len(d3_sigs):.1f}%)")

    print("\n--- 12 perfect matches ---")
    for o, m in [(o, m) for o, m in matches.items() if len(m["matches"]) == 1][:12]:
        c = m["matches"][0]
        sig_p = ",".join(m["sig"])[:90]
        print(f"  {o:>6} -> {c['d2Class']:<48} (proto {c['d2ProtoId']})")
        print(f"          {sig_p}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
