"""
Poll the toolkit's getCollectedProtoData RPC and decode all collected
FileDescriptorProto blobs to recover the original .proto schema.

Output:
  - %TEMP%/proto-name-map.json — { obfClrName: protoFullName } from the ctor hook
  - dofus-app/data/proto-schemas/ — one .proto-like .json per FileDescriptor
  - dofus-app/docs/proto-schema-summary.md — overview

Usage:
  python collect-proto-names.py [poll_interval_seconds]

Prereq:
  - installProtoNameSniffer RPC has been called
  - Game is running (login to trigger descriptor init)
"""
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path
from collections import defaultdict
from google.protobuf.descriptor_pb2 import FileDescriptorProto

sys.stdout.reconfigure(encoding="utf-8")

API = "http://localhost:3000/api/call"
TEMP_OUT = Path.home() / "AppData/Local/Temp/proto-name-map.json"
SCHEMAS_DIR = Path(__file__).resolve().parents[1] / "data" / "proto-schemas"
DOC_OUT = Path(__file__).resolve().parents[1] / "docs" / "proto-schema-summary.md"

def call_rpc(method, args=None):
    body = json.dumps({"method": method, "args": args or []}).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))["result"]

def fetch():
    return call_rpc("getCollectedProtoData", [])

def decode_all(blobs):
    """Decode each FileDescriptorProto blob, extract message names + fields."""
    files = []
    for blob in blobs:
        try:
            raw = base64.b64decode(blob["b64"])
            fdp = FileDescriptorProto()
            fdp.ParseFromString(raw)
            files.append({
                "name": fdp.name,
                "package": fdp.package,
                "syntax": fdp.syntax,
                "dependencies": list(fdp.dependency),
                "messages": [
                    {
                        "name": m.name,
                        "fullName": f"{fdp.package}.{m.name}" if fdp.package else m.name,
                        "fieldCount": len(m.field),
                        "fields": [
                            {
                                "name": f.name,
                                "number": f.number,
                                "type": f.type,
                                "typeName": f.type_name or _type_name(f.type),
                                "label": f.label,
                            }
                            for f in m.field
                        ],
                        "nestedTypes": [n.name for n in m.nested_type],
                        "oneofs": [o.name for o in m.oneof_decl],
                    }
                    for m in fdp.message_type
                ],
                "enums": [
                    {"name": e.name, "values": [(v.name, v.number) for v in e.value]}
                    for e in fdp.enum_type
                ],
                "size": blob["size"],
            })
        except Exception as e:
            files.append({"name": "ERR", "error": str(e), "size": blob["size"]})
    return files

PROTO_TYPES = {
    1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32",
    6: "fixed64", 7: "fixed32", 8: "bool", 9: "string", 10: "group",
    11: "message", 12: "bytes", 13: "uint32", 14: "enum", 15: "sfixed32",
    16: "sfixed64", 17: "sint32", 18: "sint64",
}
def _type_name(t):
    return PROTO_TYPES.get(t, f"type_{t}")

def write_outputs(name_map, files):
    SCHEMAS_DIR.mkdir(parents=True, exist_ok=True)
    DOC_OUT.parent.mkdir(parents=True, exist_ok=True)

    # name map
    name_map_d = {row["clr"]: row["proto"] for row in name_map}
    TEMP_OUT.write_text(json.dumps(name_map_d, indent=2, ensure_ascii=False), encoding="utf-8")

    # one json per file descriptor (for downstream tooling)
    for f in files:
        if "error" in f: continue
        slug = f["name"].replace("/", "_").replace(".", "_") or "unknown"
        out = SCHEMAS_DIR / f"{slug}.json"
        out.write_text(json.dumps(f, indent=2, ensure_ascii=False), encoding="utf-8")

    # summary doc
    md = ["# Dofus 3.0 — Recovered Protobuf schema\n\n"]
    md.append(f"Collected by `installProtoNameSniffer` runtime hook + `collect-proto-names.py` decoder.\n\n")
    md.append("## Stats\n\n")
    md.append(f"- **{len(name_map_d)}** `clr_class → proto.FullName` mappings (from MessageDescriptor.ctor)\n")
    md.append(f"- **{len(files)}** FileDescriptorProto blobs captured (from FileDescriptor.FromGeneratedCode)\n")
    total_msgs = sum(len(f.get("messages", [])) for f in files)
    total_enums = sum(len(f.get("enums", [])) for f in files)
    md.append(f"- **{total_msgs}** total message types\n")
    md.append(f"- **{total_enums}** total enum types\n\n")

    # Group by package
    by_pkg = defaultdict(list)
    for f in files:
        by_pkg[f.get("package", "?")].append(f)

    md.append("## Recovered .proto files (grouped by package)\n\n")
    for pkg, fs in sorted(by_pkg.items()):
        md.append(f"### `{pkg}`\n\n")
        md.append("| File | Messages | Enums | Deps |\n|---|---|---|---|\n")
        for f in sorted(fs, key=lambda x: x.get("name", "")):
            md.append(f"| `{f.get('name','?')}` | {len(f.get('messages',[]))} | {len(f.get('enums',[]))} | {len(f.get('dependencies',[]))} |\n")
        md.append("\n")

    # Sample of obf→proto map
    md.append("## Sample mappings (first 30 obf → proto)\n\n")
    md.append("| Obf class | .proto FullName |\n|---|---|\n")
    for clr, proto in sorted(name_map_d.items())[:30]:
        md.append(f"| `{clr}` | `{proto}` |\n")
    md.append(f"\n_(see `proto-name-map.json` for the full list)_\n")

    DOC_OUT.write_text("".join(md), encoding="utf-8")
    print(f"\nWrote {DOC_OUT}")
    print(f"Wrote {TEMP_OUT}")
    print(f"Wrote {len([f for f in files if 'error' not in f])} schema files in {SCHEMAS_DIR}")

def main():
    interval = float(sys.argv[1]) if len(sys.argv) > 1 else 0
    if interval > 0:
        # Poll mode
        last_n = -1
        last_b = -1
        print(f"Polling every {interval}s. Ctrl+C to stop and emit final report.")
        try:
            while True:
                d = fetch()
                if not d.get("snifferInstalled"):
                    print("Sniffer not installed — call installProtoNameSniffer first")
                    return
                n = len(d["nameMap"]); b = len(d["fileDescriptorBlobs"])
                if n != last_n or b != last_b:
                    print(f"  collected: {n} name mappings, {b} file blobs")
                    last_n, last_b = n, b
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\nStopping. Decoding final state...")
    d = fetch()
    if not d.get("snifferInstalled"):
        print("Sniffer not installed — call installProtoNameSniffer first")
        return
    print(f"Got {len(d['nameMap'])} name mappings, {len(d['fileDescriptorBlobs'])} file blobs")
    files = decode_all(d["fileDescriptorBlobs"])
    write_outputs(d["nameMap"], files)

if __name__ == "__main__":
    main()
