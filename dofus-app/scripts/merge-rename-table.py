#!/usr/bin/env python3
"""
Task 5 — Merge orchestrator for the Dofus 3 multi-path deobfuscation sprint.

Consumes per-source RenameEntry JSONs and produces a unified frida-rename-table.json,
preserving all existing fields while adding/updating deobfuscation metadata.

CLI:
    python merge-rename-table.py --phase {1,2,final}   (default: final)
    python merge-rename-table.py --self-test
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
DATA_INDEXED = ROOT / "dofus-app" / "data" / "indexed"
DATA_EXTERNAL = ROOT / "dofus-app" / "data" / "external"
DATA_RUNTIME = ROOT / "dofus-app" / "data" / "runtime"

J1_SOURCES = [
    DATA_EXTERNAL / "assetripper-monobehaviours.json",
    DATA_EXTERNAL / "dbi-name-table.json",
    DATA_EXTERNAL / "protodec-rename.json",
]
J2_SOURCES = [DATA_RUNTIME / "filedescriptor-init-rename.json"]
J3_SOURCES = [DATA_INDEXED / "string-refs-rename.json"]

EXISTING_TABLE = DATA_INDEXED / "frida-rename-table.json"
CONFLICTS_MD   = DATA_INDEXED / "merge-conflicts.md"

# ---------------------------------------------------------------------------
# Import shared schema
# ---------------------------------------------------------------------------
sys.path.insert(0, str(ROOT / "dofus-app" / "scripts"))
from _rename_schema import RenameEntry, read_entries  # noqa: E402

# ---------------------------------------------------------------------------
# Confidence ranking
# ---------------------------------------------------------------------------
CONFIDENCE_RANK: dict[str, int] = {
    "low_struct_match": 0,
    "medium_xref": 1,
    "high_runtime": 2,
    "high_unique": 3,
}

_RANK_TO_CONF = {v: k for k, v in CONFIDENCE_RANK.items()}


def _rank(confidence: str) -> int:
    return CONFIDENCE_RANK.get(confidence, 0)


# ---------------------------------------------------------------------------
# load existing table
# ---------------------------------------------------------------------------

def load_existing_table() -> dict:
    if not EXISTING_TABLE.exists():
        print(f"[WARN] {EXISTING_TABLE} not found — starting from empty table", file=sys.stderr)
        return {"classes": {}, "methods": {}, "references": {}}
    raw = json.loads(EXISTING_TABLE.read_text(encoding="utf-8"))
    # Ensure top-level sections exist
    raw.setdefault("classes", {})
    raw.setdefault("methods", {})
    raw.setdefault("references", {})
    return raw


# ---------------------------------------------------------------------------
# collect entries for a given phase
# ---------------------------------------------------------------------------

def collect_entries(phase: str) -> list[RenameEntry]:
    if phase == "1":
        source_files = J1_SOURCES
    elif phase == "2":
        source_files = J1_SOURCES + J2_SOURCES
    elif phase == "final":
        source_files = J1_SOURCES + J2_SOURCES + J3_SOURCES
    else:
        raise ValueError(f"Unknown phase {phase!r}; expected '1', '2', or 'final'")

    all_entries: list[RenameEntry] = []
    for path in source_files:
        if not path.exists():
            print(f"[INFO] source file missing (skipped): {path}", file=sys.stderr)
            continue
        try:
            entries = read_entries(path)
            print(f"[INFO] loaded {len(entries):>5} entries from {path.name}", file=sys.stderr)
            all_entries.extend(entries)
        except (ValueError, OSError) as exc:
            print(f"[WARN] could not read {path}: {exc}", file=sys.stderr)

    return all_entries


# ---------------------------------------------------------------------------
# aggregate
# ---------------------------------------------------------------------------

def aggregate(entries: list[RenameEntry]) -> tuple[dict, list[dict]]:
    """
    Group entries by obf_name. Skip __UNKNOWN_OBF_FOR__ prefixed names.
    Returns:
        aggregated: {obf_name: {original_name, confidence, sources, name_candidates?}}
        conflicts: list of conflict records
    """
    # Skip unknown-obf entries
    valid = [e for e in entries if not e.obf_name.startswith("__UNKNOWN_OBF_FOR__")]

    # Group by obf_name
    groups: dict[str, list[RenameEntry]] = defaultdict(list)
    for e in valid:
        groups[e.obf_name].append(e)

    aggregated: dict[str, dict] = {}
    conflicts: list[dict] = []

    for obf_name, group in groups.items():
        # Collect distinct original_name values
        distinct_names = list(dict.fromkeys(e.original_name for e in group))  # preserves order

        sources_sorted = sorted({e.evidence_source for e in group})

        if len(distinct_names) == 1:
            # All agree
            agreed_name = distinct_names[0]
            # Best confidence from group
            best_rank = max(_rank(e.confidence) for e in group)
            # 2+ entries concordant → bump to high_unique
            if len(group) >= 2:
                best_rank = max(best_rank, _rank("high_unique"))
            final_conf = _RANK_TO_CONF[best_rank]

            aggregated[obf_name] = {
                "original_name": agreed_name,
                "confidence": final_conf,
                "sources": sources_sorted,
            }
        else:
            # Conflict: different names proposed
            candidates = [
                {
                    "original_name": e.original_name,
                    "confidence": e.confidence,
                    "source": e.evidence_source,
                    "detail": e.evidence_detail,
                }
                for e in group
            ]
            aggregated[obf_name] = {
                "original_name": None,
                "confidence": "low_struct_match",
                "sources": sources_sorted,
                "name_candidates": candidates,
            }
            conflict_rec = {
                "obf_name": obf_name,
                "candidates": candidates,
            }
            conflicts.append(conflict_rec)

    return aggregated, conflicts


# ---------------------------------------------------------------------------
# write conflicts markdown
# ---------------------------------------------------------------------------

def write_conflicts_md(conflicts: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Merge Conflicts",
        "",
        f"Total conflicts: {len(conflicts)}",
        "",
    ]
    for c in conflicts:
        obf = c["obf_name"]
        lines.append(f"## `{obf}`")
        lines.append("")
        lines.append("| source | original_name | confidence | detail |")
        lines.append("|--------|---------------|------------|--------|")
        for cand in c["candidates"]:
            detail = cand.get("detail", "").replace("|", "\\|")
            lines.append(
                f"| {cand['source']} | {cand['original_name']} "
                f"| {cand['confidence']} | {detail} |"
            )
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[INFO] wrote {len(conflicts)} conflicts → {path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# merge into table
# ---------------------------------------------------------------------------

def merge_into_table(aggregated: dict, table: dict) -> dict:
    """
    Merge aggregated deobf info into existing table['classes'].
    Preserves all existing fields; adds/updates deobfusc_* fields.
    Also updates 'label' to original_name when original_name is not None.
    """
    classes = table["classes"]

    # Stats counters
    stats = {"new": 0, "updated": 0, "high_unique": 0, "medium_xref": 0, "low_struct_match": 0, "high_runtime": 0}

    for obf_name, agg in aggregated.items():
        original_name = agg["original_name"]
        confidence = agg["confidence"]
        sources = agg["sources"]
        name_candidates = agg.get("name_candidates")

        if obf_name not in classes:
            # New entry — create minimal stub with default label = obf_name
            classes[obf_name] = {"label": obf_name}
            stats["new"] += 1
        else:
            stats["updated"] += 1

        entry = classes[obf_name]
        # Ensure label exists even on classes that pre-existed without one
        entry.setdefault("label", obf_name)

        # Update deobfusc fields
        entry["original_name"] = original_name
        entry["deobfusc_confidence"] = confidence
        entry["deobfusc_sources"] = sources

        if name_candidates is not None:
            entry["name_candidates"] = name_candidates
        else:
            # Remove stale candidates if any
            entry.pop("name_candidates", None)

        # Update label if we have a resolved name
        if original_name is not None:
            entry["label"] = original_name

        # Stats
        conf_key = confidence if confidence in stats else "low_struct_match"
        stats[conf_key] = stats.get(conf_key, 0) + 1

    table["classes"] = classes
    return table, stats


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Merge rename entries into frida-rename-table.json")
    parser.add_argument("--phase", choices=["1", "2", "final"], default="final",
                        help="Which phase sources to consume (default: final)")
    parser.add_argument("--self-test", action="store_true", help="Run self-test and exit")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    print(f"[INFO] Running phase={args.phase}", file=sys.stderr)

    # 1. Load existing table
    table = load_existing_table()
    original_class_count = len(table["classes"])
    print(f"[INFO] existing classes: {original_class_count}", file=sys.stderr)

    # 2. Collect entries
    entries = collect_entries(args.phase)
    print(f"[INFO] total RenameEntry rows read: {len(entries)}", file=sys.stderr)

    # 3. Aggregate
    aggregated, conflicts = aggregate(entries)
    print(f"[INFO] unique obf_names aggregated: {len(aggregated)}", file=sys.stderr)
    print(f"[INFO] conflicts: {len(conflicts)}", file=sys.stderr)

    # 4. Merge
    table, stats = merge_into_table(aggregated, table)

    # Verify existing classes not lost
    final_class_count = len(table["classes"])
    assert final_class_count >= original_class_count, (
        f"BUG: lost classes! before={original_class_count} after={final_class_count}"
    )

    # 5. Write atomically (write to temp, then replace)
    tmp = EXISTING_TABLE.with_suffix(".tmp")
    tmp.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(EXISTING_TABLE)
    print(f"[INFO] wrote {EXISTING_TABLE}", file=sys.stderr)

    # 6. Write conflicts markdown
    write_conflicts_md(conflicts, CONFLICTS_MD)

    # 7. Print summary
    conf_counts: dict[str, int] = defaultdict(int)
    for meta in table["classes"].values():
        c = meta.get("deobfusc_confidence")
        if c:
            conf_counts[c] += 1

    print("\n=== MERGE STATS ===")
    print(f"  Total RenameEntry rows read : {len(entries)}")
    print(f"  Unique obf_names aggregated : {len(aggregated)}")
    print(f"  Conflicts                   : {len(conflicts)}")
    print(f"  Classes in table (before)   : {original_class_count}")
    print(f"  Classes in table (after)    : {final_class_count}")
    print(f"  New stubs added             : {stats['new']}")
    print(f"  Existing entries updated    : {stats['updated']}")
    print("--- Confidence breakdown (over all classes with deobfusc_confidence) ---")
    for conf in ["high_unique", "high_runtime", "medium_xref", "low_struct_match"]:
        print(f"  {conf:<22}: {conf_counts.get(conf, 0)}")
    print("===================")


# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------

def _self_test() -> None:
    e1 = RenameEntry("egq", "HaapiClient", "", "high_unique", "dbi", "v0.11.30")
    e2 = RenameEntry("egq", "HaapiClient", "Ankama.Haapi", "medium_xref", "assetripper", "guid=abc")
    e3 = RenameEntry("eat", "CartographyView", "", "medium_xref", "dbi", "")
    e4 = RenameEntry("eat", "MapView", "", "medium_xref", "assetripper", "")
    e5 = RenameEntry("__UNKNOWN_OBF_FOR__Foo", "Foo", "", "medium_xref", "dbi", "")

    agg, conflicts = aggregate([e1, e2, e3, e4, e5])

    assert "egq" in agg, "egq should be in agg"
    assert agg["egq"]["original_name"] == "HaapiClient", f"expected HaapiClient, got {agg['egq']['original_name']}"
    assert agg["egq"]["confidence"] == "high_unique", f"expected high_unique, got {agg['egq']['confidence']}"
    assert "eat" in agg, "eat should be in agg"
    assert agg["eat"]["original_name"] is None, f"eat should have None original_name (conflict)"
    assert len(agg["eat"]["name_candidates"]) == 2, f"eat should have 2 candidates"
    assert "__UNKNOWN_OBF_FOR__Foo" not in agg, "__UNKNOWN_OBF_FOR__Foo must be skipped"
    assert len(conflicts) == 1, f"expected 1 conflict, got {len(conflicts)}"

    # Also test merge_into_table preserves existing fields
    fake_table = {
        "classes": {
            "egq": {"label": "old_label", "score": 56, "token": "0x2001A5E", "parents": ["eqa", "fqr"]},
        },
        "methods": {},
        "references": {},
    }
    merged_table, _ = merge_into_table({"egq": agg["egq"]}, fake_table)
    cls = merged_table["classes"]["egq"]
    assert cls["score"] == 56, "score must be preserved"
    assert cls["token"] == "0x2001A5E", "token must be preserved"
    assert cls["parents"] == ["eqa", "fqr"], "parents must be preserved"
    assert cls["label"] == "HaapiClient", "label should be updated to original_name"
    assert cls["original_name"] == "HaapiClient", "original_name should be set"
    assert cls["deobfusc_confidence"] == "high_unique", "deobfusc_confidence should be set"

    print("OK merge-rename-table._self_test")


if __name__ == "__main__":
    main()
