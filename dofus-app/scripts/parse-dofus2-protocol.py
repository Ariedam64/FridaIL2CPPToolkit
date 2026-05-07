#!/usr/bin/env python3
"""
Parse Dofus 2 (AS3) protocol sources and emit a structured JSON describing
every message and type. Used as input by the Dofus 2 ↔ Dofus 3 matcher.

Inputs:
  dofus-app/data/external/dofus2-invoker-hades/com/ankamagames/dofus/network/{messages,types}/**/*.as

Output:
  dofus-app/data/external/dofus2-protocol.json

Schema:
  {
    "source": "...",
    "extracted_at": "...",
    "messages": [ { class, fullName, parent, protocolId, fields, path }, ... ],
    "types":    [ ... same shape ... ]
  }

Notes
-----
The AS3 schema represents fields with `public var <name>:<Type>;`. Order of
declaration in the source matches the order in serializeAs_X() in 99% of cases
(spot-checked on ~50 files). For now we use declaration order; if needed we
can refine by parsing serializeAs_X explicitly.

We DO NOT yet flatten the inheritance chain (parent fields are not merged into
the child). That's the matcher's responsibility — it walks `parent` recursively.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("dofus-app/data/external/dofus2-invoker-hades/com/ankamagames/dofus/network")
OUT  = Path("dofus-app/data/external/dofus2-protocol.json")

PACKAGE_RE = re.compile(r"^\s*package\s+([\w.]+)", re.MULTILINE)
# `public class Foo extends Bar implements ...` — `extends` is optional
CLASS_RE   = re.compile(r"^\s*public\s+(?:final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?", re.MULTILINE)
PROTO_ID_RE = re.compile(r"public\s+static\s+const\s+protocolId\s*:\s*uint\s*=\s*(\d+)\s*;")
# `public var name:Type;`  — Type may include `.` (qualified) or generics `Vector.<X>`.
# Accepts optional default value (`= 0`, `= -1`, `= "foo"`, `= new Foo()`, etc.)
# and optional whitespace anywhere. Captures stop at `=` or `;`, whichever comes first.
FIELD_RE   = re.compile(r"^\s*public\s+var\s+(\w+)\s*:\s*([\w.<>]+)\s*(?:=[^;]*)?;", re.MULTILINE)
# Skip private vars and trees (`_xxxtree`)
PRIVATE_VAR_RE = re.compile(r"^\s*private\s+var\s+", re.MULTILINE)


def parse_file(path: Path) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return None
    pkg = PACKAGE_RE.search(text)
    cls = CLASS_RE.search(text)
    if not pkg or not cls:
        return None
    package = pkg.group(1)
    class_name = cls.group(1)
    parent = cls.group(2)  # may be None
    proto_id_match = PROTO_ID_RE.search(text)
    proto_id = int(proto_id_match.group(1)) if proto_id_match else None

    # Fields: pull every `public var name:Type;` from the class body. The class
    # body starts after `class X { ... } }`. AS3 has class-level fields only
    # (no inner methods declaring fields), so a flat regex pass is fine.
    fields = []
    for m in FIELD_RE.finditer(text):
        name = m.group(1)
        type_name = m.group(2)
        fields.append({"name": name, "type": type_name})

    return {
        "class": class_name,
        "fullName": f"{package}.{class_name}",
        "package": package,
        "parent": parent,
        "protocolId": proto_id,
        "fields": fields,
        "path": str(path.relative_to(ROOT.parent.parent.parent)),  # relative to dofus-app/
    }


def main() -> int:
    if not ROOT.exists():
        print(f"ERROR: source dir not found: {ROOT}", file=sys.stderr)
        return 1

    messages: list[dict] = []
    types: list[dict] = []
    skipped = 0
    for p in ROOT.rglob("*.as"):
        rel = p.relative_to(ROOT)
        parsed = parse_file(p)
        if parsed is None:
            skipped += 1
            continue
        bucket = messages if rel.parts[0] == "messages" else types if rel.parts[0] == "types" else None
        if bucket is None:
            continue  # enums handled separately
        bucket.append(parsed)

    out = {
        "source": "dofus2-invoker-hades",
        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stats": {
            "messages_parsed": len(messages),
            "types_parsed": len(types),
            "skipped": skipped,
        },
        "messages": messages,
        "types": types,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=0, ensure_ascii=False), encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"wrote {OUT} ({size_kb:.1f} KB)")
    print(f"  messages: {len(messages)}")
    print(f"  types:    {len(types)}")
    print(f"  skipped:  {skipped}")

    # Sanity: report distribution of field counts and presence of protocolId.
    with_proto_id = sum(1 for m in messages if m["protocolId"] is not None)
    print(f"  messages with protocolId: {with_proto_id}/{len(messages)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
