#!/usr/bin/env python3
"""
Integrate the proto-name-mapping-v2 results into the Frida rename table:
  - High-confidence matches → added as authoritative class labels
  - Ambiguous matches → added as 'candidates' alongside the obf class
  - Cross-reference with ModulX's own obf→name mapping (different version
    but useful for catalog browsing)
"""
from __future__ import annotations

import json
from pathlib import Path

MAPPING_PATH = Path("dofus-app/data/indexed/proto-name-mapping-v2.json")
RENAME_TABLE_PATH = Path("dofus-app/data/indexed/frida-rename-table.json")
MODULX_MAPPING_PATH = Path("dofus-app/data/external/dofus-unity-proto/game_mappings.json")
OUT_PATH = Path("dofus-app/data/indexed/frida-rename-table.json")  # merge in place
SUMMARY_PATH = Path("dofus-app/data/indexed/proto-mapping-summary.json")


def main() -> int:
    mapping = json.loads(MAPPING_PATH.read_text(encoding="utf-8"))
    rename = json.loads(RENAME_TABLE_PATH.read_text(encoding="utf-8"))
    modulx_v_old = json.loads(MODULX_MAPPING_PATH.read_text(encoding="utf-8"))

    # 1. Add high-confidence proto matches as class labels
    n_added_high = 0
    for entry in mapping["confirmed"]:
        obf = entry["obf"]
        existing = rename["classes"].get(obf, {})
        existing["label"] = entry["real_name"]
        existing["asm"] = "Ankama.Dofus.Protocol.Game"
        existing["proto_fqn"] = entry["real_fqn"]
        existing["proto_source_file"] = entry["source_file"]
        existing["confidence"] = entry["confidence"]
        existing["source"] = "modulx_signature_match"
        rename["classes"][obf] = existing
        n_added_high += 1

    # 2. Add ambiguous entries as candidate sets (no label change, just
    #    annotation for human review)
    n_amb_annotated = 0
    rename.setdefault("proto_candidates", {})
    for entry in mapping["ambiguous"]:
        obf = entry["obf"]
        rename["proto_candidates"][obf] = entry["candidates"][:10]  # cap to 10
        n_amb_annotated += 1

    # 3. Reference the ModulX game_mappings.json as a separate "version_v_old"
    #    catalog. Same obf names mean DIFFERENT messages between versions,
    #    but the right-hand-side names are the canonical Ankama Protobuf
    #    catalogue.
    rename.setdefault("references", {})
    rename["references"]["modulx_v_old_obf_to_name"] = {
        "description": "ModulX/dofus-unity-proto game_mappings.json — catalog of "
                       "Dofus Unity Protobuf names. obf→name from an older build, "
                       "not directly aligned with current build.",
        "size": len(modulx_v_old),
        "names_catalog": sorted(set(modulx_v_old.values())),
    }

    OUT_PATH.write_text(json.dumps(rename, indent=1, ensure_ascii=False), encoding="utf-8")

    summary = {
        "stats": {
            "high_confidence_proto_matches": n_added_high,
            "ambiguous_with_candidate_set": n_amb_annotated,
            "modulx_canonical_proto_names": len(set(modulx_v_old.values())),
        },
        "high_confidence_examples": [
            {"obf": e["obf"], "name": e["real_name"], "file": e["source_file"]}
            for e in mapping["confirmed"][:30]
        ],
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"[*] Updated {OUT_PATH}")
    print(f"    high-confidence proto labels added:   {n_added_high}")
    print(f"    ambiguous candidate sets recorded:    {n_amb_annotated}")
    print(f"    canonical ModulX names available:     {len(set(modulx_v_old.values()))}")
    print(f"[*] Wrote summary {SUMMARY_PATH}")
    return 0


if __name__ == "__main__":
    main()
