#!/usr/bin/env python3
"""
Build a compact rename table consumable by a Frida hook layer.

For each obfuscated identifier, store (when known) the friendly label/name,
and the native RVA + token. This is the data file that the future
rename-layer Frida script will consume to display real names everywhere.

Output:
  dofus-app/data/indexed/frida-rename-table.json
"""
from __future__ import annotations

import json
from pathlib import Path


INDEXED_DIR = Path("dofus-app/data/indexed")
DEOB_PATH = Path("dofus-app/docs/deobfuscation-map.json")
PROTO_LABELS_PATH = Path("dofus-app/docs/protocol-message-labels.json")
OUT_PATH = INDEXED_DIR / "frida-rename-table.json"


def main() -> int:
    deob = json.loads(DEOB_PATH.read_text(encoding="utf-8"))
    enriched = json.loads((INDEXED_DIR / "deobmap-enriched.json").read_text(encoding="utf-8"))
    proto_idx = json.loads((INDEXED_DIR / "protocol-game.classes.json").read_text(encoding="utf-8"))
    core_idx = json.loads((INDEXED_DIR / "core.classes.json").read_text(encoding="utf-8"))

    proto_labels = {}
    if PROTO_LABELS_PATH.exists():
        proto_labels = json.loads(PROTO_LABELS_PATH.read_text(encoding="utf-8"))

    rename_table = {
        "classes": {},   # obf_name → { label, asm, token, parents, namespace, kind }
        "methods": {},   # f"{obf_class}.{obf_method}" → { original_name, rva, token, length }
    }

    # 1. Classes from deob map (label + score)
    for entry in enriched["entries"]:
        obf = entry["obf"]
        rename_table["classes"][obf] = {
            "label": entry["label"],
            "asm": entry["asm"],
            "score": entry["score"],
            "token": entry["frida"].get("token"),
            "namespace": entry["frida"].get("namespace"),
            "is_protoc_generated": entry["frida"].get("is_protoc_generated", False),
            "parents": entry["frida"].get("parents", []),
        }
        # Methods with recovered names
        for m in entry["frida"].get("methods_with_original_name", []):
            key = f"{obf}.{m['obfuscated_name']}"
            rename_table["methods"][key] = {
                "original_name": m["original_name"],
                "rva": m["rva"],
                "length": m["length"],
                "token": m["token"],
            }

    # 2. Add ALL recovered method names from Core (not just deobmap-listed
    #    classes) — this catches obfuscated methods on still-unlabelled classes.
    for t in core_idx["types"]:
        for m in t.get("methods", []):
            if not m.get("original_name"):
                continue
            key = f"{t['name']}.{m['name']}"
            if key in rename_table["methods"]:
                continue  # already from deobmap
            rename_table["methods"][key] = {
                "original_name": m["original_name"],
                "rva": m["rva"],
                "length": m["length"],
                "token": m["token"],
            }

    # 3. Same for Protocol.Game (low chance of compiler-gen leak there but cheap)
    for t in proto_idx["types"]:
        for m in t.get("methods", []):
            if not m.get("original_name"):
                continue
            key = f"{t['name']}.{m['name']}"
            if key in rename_table["methods"]:
                continue
            rename_table["methods"][key] = {
                "original_name": m["original_name"],
                "rva": m["rva"],
                "length": m["length"],
                "token": m["token"],
            }

    # 4. Protocol message labels (from protocol-handlers session)
    if isinstance(proto_labels, dict):
        for obf, label in proto_labels.items():
            existing = rename_table["classes"].get(obf, {})
            existing["label"] = label
            existing["asm"] = "Ankama.Dofus.Protocol.Game"
            rename_table["classes"][obf] = existing

    OUT_PATH.write_text(
        json.dumps(rename_table, indent=1, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"[*] Wrote {OUT_PATH}")
    print(f"    classes: {len(rename_table['classes'])}")
    print(f"    methods (with recovered original_name + RVA): {len(rename_table['methods'])}")
    return 0


if __name__ == "__main__":
    main()
