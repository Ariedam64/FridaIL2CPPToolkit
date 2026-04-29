#!/usr/bin/env python3
"""
Schéma commun pour les rename entries du sprint multi-path.
Tous les parsers J1-J3 émettent des objets RenameEntry homogènes.
Le merger final consomme ces objets.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Literal

Confidence = Literal["high_unique", "high_runtime", "medium_xref", "low_struct_match"]
EvidenceSource = Literal[
    "assetripper", "dbi", "protodec", "filedescriptor_hook",
    "stringrefs", "existing_deobmap", "existing_proto_mapping",
    "clear_dll_xref"
]


@dataclass
class RenameEntry:
    obf_name: str
    original_name: str
    namespace: str = ""
    confidence: Confidence = "medium_xref"
    evidence_source: EvidenceSource = "stringrefs"
    evidence_detail: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def write_entries(entries: Iterable[RenameEntry], path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [e.to_dict() for e in entries]
    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    return len(rows)


def read_entries(path: Path) -> list[RenameEntry]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in {path}: {e}") from e
    if not isinstance(raw, list):
        raise ValueError(f"Expected JSON array in {path}, got {type(raw).__name__}")
    out = []
    for i, r in enumerate(raw):
        if not isinstance(r, dict):
            raise ValueError(f"{path}[{i}]: expected object, got {type(r).__name__}")
        if "obf_name" not in r or "original_name" not in r:
            raise ValueError(f"{path}[{i}]: missing required keys obf_name/original_name (got keys={list(r.keys())})")
        out.append(RenameEntry(
            obf_name=r["obf_name"],
            original_name=r["original_name"],
            namespace=r.get("namespace", ""),
            confidence=r.get("confidence", "medium_xref"),
            evidence_source=r.get("evidence_source", "stringrefs"),
            evidence_detail=r.get("evidence_detail", ""),
        ))
    return out


def _self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "test.json"
        e1 = RenameEntry("egq", "HaapiClient", "Ankama.Haapi", "high_unique", "dbi", "v0.11.30")
        n = write_entries([e1], p)
        assert n == 1
        loaded = read_entries(p)
        assert len(loaded) == 1
        assert loaded[0].obf_name == "egq"
        assert loaded[0].confidence == "high_unique"
        print("OK _rename_schema._self_test")


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        _self_test()
