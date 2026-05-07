#!/usr/bin/env python3
"""
Cross-reference deobfuscation-map.json with the indexed Cpp2IL classes
(core.classes.json + protocol-game.classes.json) to attach:

- Token (IL2CPP metadata token) to each obfuscated class
- RVA / Length / Token to each leaked method  (when found)
- FieldOffset / Token to each field

Output: dofus-app/data/indexed/deobmap-enriched.json

Why this matters: every entry in deobmap is now directly hookable in Frida
via `Module.findBaseAddress("GameAssembly.dll").add(method.rva)` without
having to resolve names through frida-il2cpp-bridge.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


DEOB_PATH = Path("dofus-app/docs/deobfuscation-map.json")
INDEXED_DIR = Path("dofus-app/data/indexed")
OUT_PATH = Path("dofus-app/data/indexed/deobmap-enriched.json")


def build_lookup(types_json: dict) -> dict[str, dict]:
    """name → type entry (only top-level by name; collisions merged with priority root namespace)."""
    out: dict[str, dict] = {}
    for t in types_json["types"]:
        name = t["name"]
        # Prefer root namespace types (where most obfuscated classes live)
        existing = out.get(name)
        if existing is None or (existing.get("namespace") and not t.get("namespace")):
            out[name] = t
    # Also walk nested types: register them under "Parent.Nested"
    def walk(t, qual_prefix=""):
        full = f"{qual_prefix}{t['name']}"
        if full not in out and qual_prefix:
            out[full] = t
        for n in t.get("nested_types", []):
            walk(n, full + ".")
    for t in types_json["types"]:
        walk(t)
    return out


def main() -> int:
    deob = json.loads(DEOB_PATH.read_text(encoding="utf-8"))
    core_idx = json.loads((INDEXED_DIR / "core.classes.json").read_text(encoding="utf-8"))
    proto_idx = json.loads((INDEXED_DIR / "protocol-game.classes.json").read_text(encoding="utf-8"))

    core_lookup = build_lookup(core_idx)
    proto_lookup = build_lookup(proto_idx)
    print(f"[*] Lookup tables built: Core={len(core_lookup)}, Protocol={len(proto_lookup)}")

    enriched_entries = []
    n_matched = n_methods_matched = 0

    for entry in deob["identifications"]:
        obf = entry["obf"]
        asm = entry["asm"]
        lookup = proto_lookup if asm.startswith("Ankama.Dofus.Protocol") else core_lookup

        type_entry = lookup.get(obf)
        new_entry = dict(entry)  # shallow copy
        new_entry.setdefault("frida", {})

        if type_entry is None:
            new_entry["frida"]["resolved"] = False
            enriched_entries.append(new_entry)
            continue

        n_matched += 1
        new_entry["frida"]["resolved"] = True
        new_entry["frida"]["token"] = type_entry.get("token")
        new_entry["frida"]["namespace"] = type_entry.get("namespace", "")
        new_entry["frida"]["is_protoc_generated"] = type_entry.get("is_protoc_generated", False)
        new_entry["frida"]["parents"] = type_entry.get("parents", [])

        # Match leaked methods to indexed methods. The deobmap "methods" list
        # holds ORIGINAL names recovered from compiler-gen state machine
        # leaks (e.g. "AddAreaShape"). In the indexed types, those map to
        # obfuscated method names (e.g. "vyp") whose `original_name` field
        # holds the recovered real name.
        original_to_meta = {}
        for m in type_entry.get("methods", []):
            if m.get("original_name"):
                original_to_meta.setdefault(m["original_name"], []).append(m)
        # Fallback: also match by current (obfuscated) name in case the
        # deobmap already has obfuscated names listed.
        name_to_meta = {}
        for m in type_entry.get("methods", []):
            name_to_meta.setdefault(m["name"], []).append(m)

        method_rvas = []
        for mname in entry.get("methods", []):
            matches = original_to_meta.get(mname) or name_to_meta.get(mname) or []
            for m in matches:
                method_rvas.append({
                    "original_name": mname,
                    "obfuscated_name": m["name"],
                    "rva": m["rva"],
                    "length": m["length"],
                    "token": m["token"],
                    "is_protoc_generated": m.get("is_protoc_generated", False),
                })
                n_methods_matched += 1
        new_entry["frida"]["leaked_methods_rva"] = method_rvas

        # Also expose ALL methods that have a recovered original_name
        # (compiler-gen leak). These are the most useful for hooking.
        recovered = []
        for m in type_entry.get("methods", []):
            if m.get("original_name"):
                recovered.append({
                    "obfuscated_name": m["name"],
                    "original_name": m["original_name"],
                    "rva": m["rva"],
                    "length": m["length"],
                    "token": m["token"],
                })
        new_entry["frida"]["methods_with_original_name"] = recovered

        # Field offsets
        new_entry["frida"]["fields"] = [
            {
                "name": f["name"],
                "type": f["type"],
                "field_offset": f.get("field_offset"),
                "token": f.get("token"),
                "modifiers": f.get("modifiers", []),
            }
            for f in type_entry.get("fields", [])
        ]

        enriched_entries.append(new_entry)

    out_doc = {
        "generated_from": {
            "deobfuscation_map": str(DEOB_PATH),
            "core_index": str(INDEXED_DIR / "core.classes.json"),
            "protocol_index": str(INDEXED_DIR / "protocol-game.classes.json"),
        },
        "stats": {
            "total_entries": len(enriched_entries),
            "matched_in_index": n_matched,
            "leaked_methods_resolved_to_rva": n_methods_matched,
        },
        "entries": enriched_entries,
    }

    OUT_PATH.write_text(json.dumps(out_doc, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"[*] Wrote {OUT_PATH}")
    print(f"    {n_matched}/{len(enriched_entries)} obfuscated classes matched in index")
    print(f"    {n_methods_matched} leaked methods resolved to native RVA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
