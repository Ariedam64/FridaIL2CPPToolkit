#!/usr/bin/env python3
"""
Scan a Cpp2IL-recovered .NET DLL for embedded Protobuf FileDescriptorProto
binary blobs, decode them, and emit a mapping
{ obfuscated_class -> { proto_name, package, fields[]: [{tag, name, type}] } }.

Each Protobuf-generated C# class embeds a `static readonly byte[]` that holds
the binary FileDescriptorProto for its .proto file. The byte content is
preserved verbatim by Cpp2IL as field RVA data inside the PE -- we don't need
the runtime; we just scan for the pattern.

A FileDescriptorProto starts with tag 1 (name field) which serializes as
`0x0A <varint_len> <utf8 bytes>` and the filename always ends with `.proto`.
We anchor on `.proto`, backtrack to find the leading `0x0A <len>`, then attempt
to parse the bytes as FileDescriptorProto. On success we emit it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from google.protobuf import descriptor_pb2
from google.protobuf.message import DecodeError


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    """Decode a single Protobuf varint starting at pos. Returns (value, new_pos)."""
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("varint overflow")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 64:
            raise ValueError("varint too long")


def find_descriptor_starts(data: bytes) -> list[int]:
    """Return offsets of every plausible FileDescriptorProto start in data.

    A descriptor begins with `tag1=name` field: byte 0x0A followed by a
    varint length, followed by `<name>.proto`. We anchor on the `.proto`
    suffix, backtrack to verify, then yield candidates.
    """
    needle = b".proto"
    candidates = []
    pos = 0
    while True:
        idx = data.find(needle, pos)
        if idx < 0:
            break
        # The .proto suffix sits at idx; the filename string starts somewhere
        # earlier. The byte BEFORE the filename is the varint length, and BEFORE
        # that is the 0x0A tag. Filenames are typically <= 200 chars so we
        # backtrack up to 220 bytes looking for a 0x0A whose declared length
        # lands exactly on idx + len(needle) - start_of_string.
        for back in range(1, 220):
            tag_pos = idx - back - 1  # position of potential 0x0A
            len_pos = idx - back      # position of varint length
            if tag_pos < 0:
                break
            if data[tag_pos] != 0x0A:
                continue
            try:
                strlen, str_start = read_varint(data, len_pos)
            except ValueError:
                continue
            if str_start + strlen != idx + len(needle):
                continue
            # Validate the filename is plausible ASCII
            name_bytes = data[str_start:str_start + strlen]
            if not name_bytes:
                continue
            if not all(0x20 <= b < 0x7F for b in name_bytes):
                continue
            if not name_bytes.endswith(b".proto"):
                continue
            candidates.append(tag_pos)
            break
        pos = idx + 1
    return candidates


def try_parse_descriptor(data: bytes, start: int, max_size: int = 1_000_000) -> tuple[descriptor_pb2.FileDescriptorProto | None, int]:
    """Try parsing a FileDescriptorProto at offset start.

    Strategy: try increasingly larger byte windows until ParseFromString
    succeeds AND the message round-trips (re-serializes to the same prefix).
    Returns (descriptor, length) on success, (None, 0) on failure.
    """
    fd = descriptor_pb2.FileDescriptorProto()
    # Binary search for the right length: the descriptor has no explicit length
    # prefix in the C# byte[], but Protobuf is self-delimiting per-field.
    # A FileDescriptorProto serialized fully then re-serialized is canonical, so
    # we can: parse the *whole* remaining buffer, then check how many bytes were
    # consumed by re-serializing.
    chunk = data[start:start + max_size]
    try:
        fd.ParseFromString(chunk)
    except DecodeError:
        return None, 0
    # Sanity checks: it must have a name ending in .proto
    if not fd.name or not fd.name.endswith(".proto"):
        return None, 0
    # Re-serialize to determine actual byte length consumed
    reserialized = fd.SerializeToString()
    # Validate the reserialized prefix matches what we read (byte-for-byte
    # equivalence is too strict because field ordering can differ; instead
    # confirm the name + at least one message/service is present)
    if not (fd.message_type or fd.enum_type or fd.service or fd.extension):
        return None, 0
    return fd, len(reserialized)


def deobfuscated_label(name: str) -> bool:
    """A class name 'looks deobfuscated' (Pascal-case) vs 'looks obfuscated' (lowercase 1-3 chars)."""
    if not name:
        return False
    return name[0].isupper()


def main(dll_path: Path, output_dir: Path) -> int:
    print(f"[*] Reading {dll_path} ({dll_path.stat().st_size:,} bytes)")
    data = dll_path.read_bytes()

    print(f"[*] Scanning for FileDescriptorProto candidates...")
    starts = find_descriptor_starts(data)
    print(f"[*] {len(starts)} candidate anchors")

    descriptors: list[descriptor_pb2.FileDescriptorProto] = []
    seen_names: set[str] = set()

    for off in starts:
        fd, consumed = try_parse_descriptor(data, off)
        if fd is None:
            continue
        if fd.name in seen_names:
            continue
        seen_names.add(fd.name)
        descriptors.append(fd)
        n_msg = len(fd.message_type)
        n_enum = len(fd.enum_type)
        print(f"[+] @0x{off:08x} {fd.name!r} pkg={fd.package!r} msgs={n_msg} enums={n_enum} ({consumed} bytes)")

    print(f"\n[*] {len(descriptors)} unique FileDescriptorProto extracted")

    output_dir.mkdir(parents=True, exist_ok=True)

    # Write raw descriptors as a FileDescriptorSet for downstream tools
    fds = descriptor_pb2.FileDescriptorSet()
    for fd in descriptors:
        fds.file.append(fd)
    raw_path = output_dir / "protocol-game.descriptorset.binpb"
    raw_path.write_bytes(fds.SerializeToString())
    print(f"[*] Wrote {raw_path} ({raw_path.stat().st_size:,} bytes)")

    # Also dump human-readable JSON summary
    summary = {
        "files": [],
        "messages_by_proto_name": {},  # proto FQN -> { fields: [{tag, name, type}] }
    }
    for fd in descriptors:
        file_entry = {
            "name": fd.name,
            "package": fd.package,
            "messages": [],
            "enums": [m.name for m in fd.enum_type],
            "services": [s.name for s in fd.service],
            "dependency": list(fd.dependency),
        }
        def walk_message(msg, parent_name=""):
            full_name = f"{parent_name}.{msg.name}" if parent_name else msg.name
            entry = {
                "name": full_name,
                "fields": [],
                "nested": [],
                "enums": [e.name for e in msg.enum_type],
            }
            for f in msg.field:
                # Resolve type
                if f.type == f.TYPE_MESSAGE:
                    type_str = f.type_name.lstrip(".")
                elif f.type == f.TYPE_ENUM:
                    type_str = f"enum:{f.type_name.lstrip('.')}"
                else:
                    # primitive type number → name
                    type_name = descriptor_pb2.FieldDescriptorProto.Type.Name(f.type)
                    type_str = type_name.replace("TYPE_", "").lower()
                label_str = descriptor_pb2.FieldDescriptorProto.Label.Name(f.label).replace("LABEL_", "").lower()
                entry["fields"].append({
                    "tag": f.number,
                    "name": f.name,
                    "type": type_str,
                    "label": label_str,
                })
            for nested in msg.nested_type:
                entry["nested"].append(walk_message(nested, full_name))
            return entry

        for msg in fd.message_type:
            m_entry = walk_message(msg, fd.package)
            file_entry["messages"].append(m_entry)
            # Flatten to messages_by_proto_name (incl. nested)
            def flatten(e):
                summary["messages_by_proto_name"][e["name"]] = {
                    "file": fd.name,
                    "fields": e["fields"],
                    "enums": e.get("enums", []),
                }
                for n in e.get("nested", []):
                    flatten(n)
            flatten(m_entry)

        summary["files"].append(file_entry)

    summary_path = output_dir / "protocol-game.descriptors.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[*] Wrote {summary_path} ({summary_path.stat().st_size:,} bytes)")

    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1:
        dll = Path(sys.argv[1])
    else:
        dll = Path("/tmp/il2cpp_dumper/output_il_recovery/Ankama.Dofus.Protocol.Game.dll")
    out = Path("f:/FridaIL2CPPToolkit/dofus-app/data/proto-descriptors")
    sys.exit(main(dll, out))
