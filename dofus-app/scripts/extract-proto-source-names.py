#!/usr/bin/env python3
"""
Extract the list of .cs source files from the Unity package
'com.ankama.dofus.protocol.game' embedded in IL2CPP global-metadata.dat.

These filenames map 1:1 to the original .proto files of the Dofus 3 protocol:
the protoc-csharp generator emits 'foo_bar.proto' -> 'FooBar.cs'.

Output:
- dofus-app/data/protocol/proto-source-files.json
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


METADATA_PATH = Path(r"F:/Jeux/Dofus-dofus3/Dofus_Data/il2cpp_data/Metadata/global-metadata.dat")
PACKAGE_NEEDLE = b"com.ankama.dofus.protocol.game"
OUT_PATH = Path("f:/FridaIL2CPPToolkit/dofus-app/data/protocol/proto-source-files.json")


def cs_to_proto(cs: str) -> str:
    """PascalCase Foo.cs → snake_case foo.proto"""
    base = cs.removesuffix(".cs")
    # Insert underscore before each uppercase that follows a lowercase or digit
    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", base).lower()
    return snake + ".proto"


def main() -> int:
    data = METADATA_PATH.read_bytes()
    files = set()
    package_version = None
    pos = 0
    while True:
        idx = data.find(PACKAGE_NEEDLE, pos)
        if idx < 0:
            break
        end = data.find(b".cs", idx)
        if end < 0:
            pos = idx + 1
            continue
        end += 3
        chunk = data[idx:end]
        if all(0x20 <= b < 0x7F for b in chunk):
            full = chunk.decode("ascii")
            # Try to capture the version after @
            if package_version is None:
                m = re.search(r"@([0-9a-f]{6,})", full)
                if m:
                    package_version = m.group(1)
            filename = full.rsplit("\\", 1)[-1]
            files.add(filename)
        pos = end

    files_sorted = sorted(files)
    proto_pairs = [(f, cs_to_proto(f)) for f in files_sorted]

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(
            {
                "package": "com.ankama.dofus.protocol.game",
                "package_version": package_version,
                "source_count": len(files_sorted),
                "files": [
                    {"cs": cs, "proto_inferred": proto}
                    for cs, proto in proto_pairs
                ],
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"[*] Wrote {OUT_PATH}")
    print(f"    {len(files_sorted)} source files, package version {package_version}")
    print(f"    Examples: {files_sorted[:5]} ... {files_sorted[-5:]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
