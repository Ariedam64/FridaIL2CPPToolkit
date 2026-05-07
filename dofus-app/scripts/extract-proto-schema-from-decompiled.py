"""
Walk the decompiled Ankama.Dofus.Protocol.Game.dll C# files and extract
the .proto schema for every message:
  - Field number (tag) → from `public const int xxx = N;`
  - Field type → from the matching `private TYPE yyy;` declaration
  - Pairing logic: each Protobuf field generates a triplet of declarations:
      public const int <tagFieldName> = N;
      private <Type> <backingField>;
      public <Type> <Property> { get; set; }

Output:
  dofus-app/data/proto-schema-decompiled.json — { obfMsgClass: { fields: [(tag, type), ...] } }
  dofus-app/docs/proto-schema-decompiled.md — readable summary

This recovers the full wire schema for the Dofus protocol minus field names —
enough to match against community .proto docs.
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict, Counter

sys.stdout.reconfigure(encoding="utf-8")

DECOMPILED = Path(r"C:\Users\Romann\AppData\Local\Temp\decompiled_protocol")
DATA_OUT = Path(__file__).resolve().parents[1] / "data" / "proto-schema-decompiled.json"
DOC_OUT = Path(__file__).resolve().parents[1] / "docs" / "proto-schema-decompiled.md"

# IMessage<X> regex to detect Protobuf messages
IMESSAGE_RE = re.compile(r":\s*IMessage<(\w+)>\s*,")
# const int FIELDNAME = N;  →  capture (constName, tag)
CONST_INT_RE = re.compile(r"^\s*public\s+const\s+int\s+(\w+)\s*=\s*(\d+);\s*$", re.MULTILINE)
# private TYPE BACKINGNAME;  →  for fields backing properties
PRIVATE_FIELD_RE = re.compile(r"^\s*private\s+(?!struct|class|sealed|static|readonly\s+\w+\s*$)([\w\d.<>\[\]`,\s]+?)\s+(\w+);\s*$", re.MULTILINE)
# Pattern: triplet (const + private field + property). They are typically
# generated as 3 declarations in close proximity, in the order they're set
# by the Protobuf compiler. We'll align them by ORDER OF APPEARANCE.

# ----- Walk -----
messages = {}
file_count = 0
for f in DECOMPILED.rglob("*.cs"):
    file_count += 1
    try:
        text = f.read_text(encoding="utf-8")
    except Exception:
        continue
    cls_name = f.stem
    if not cls_name or cls_name.startswith("-"):
        continue
    # Detect IMessage<Self> only
    m = IMESSAGE_RE.search(text)
    if not m:
        continue
    if m.group(1) != cls_name:
        continue  # nested message structures; skip non-self IMessage
    # Extract const ints (tags) — preserve order
    consts = [(c.start(), c.group(1), int(c.group(2))) for c in CONST_INT_RE.finditer(text)]
    # Extract private fields (skip backing fields like UnknownFieldSet, MessageParser, oneofCase)
    fields = []
    for fm in PRIVATE_FIELD_RE.finditer(text):
        ftype = fm.group(1).strip()
        fname = fm.group(2)
        # Skip well-known internal fields
        if "UnknownFieldSet" in ftype or "MessageParser" in ftype:
            continue
        if "FieldCodec" in ftype:
            continue
        # Skip backing fields named like _003C..._003E (compiler-generated state machines, etc)
        if fname.startswith("_003C"):
            continue
        fields.append((fm.start(), ftype, fname))

    # Pair tags with adjacent fields by file position.
    # Pattern: `public const int X = N;` is followed by `private TYPE Y;`
    # — the next private field after each const is the field for that tag.
    paired = []
    field_idx = 0
    for cpos, cname, tag in consts:
        # find next field whose pos > cpos
        while field_idx < len(fields) and fields[field_idx][0] < cpos:
            field_idx += 1
        if field_idx < len(fields):
            fpos, ftype, fname = fields[field_idx]
            # Don't consume the same field twice — bump idx
            paired.append({
                "tag": tag,
                "tagConst": cname,
                "type": ftype,
                "backingField": fname,
            })
            field_idx += 1
    if not paired and not consts:
        continue
    messages[cls_name] = {
        "namespace": str(f.parent.relative_to(DECOMPILED)).replace("\\", "."),
        "fieldCount": len(paired),
        "fields": paired,
    }

print(f"Walked {file_count} files. Found {len(messages)} Protobuf message classes.")

# ----- Stats -----
total_fields = sum(m["fieldCount"] for m in messages.values())
print(f"Total fields recovered: {total_fields}")

# Type distribution
type_counts = Counter()
for m in messages.values():
    for f in m["fields"]:
        # Normalize generics
        t = re.sub(r"<.*?>", "", f["type"]).strip()
        type_counts[t] += 1
print(f"\nTop 20 field types in protocol:")
for t, n in type_counts.most_common(20):
    print(f"  {n:5} {t}")

# ----- Save -----
DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
DATA_OUT.write_text(json.dumps(messages, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"\nWrote {DATA_OUT}")

# ----- Build doc -----
md = ["# Dofus 3.0 — Protocol schema (recovered from decompiled IL)\n\n"]
md.append("Extracted by walking decompiled `Ankama.Dofus.Protocol.Game.dll` (Cpp2IL → ilspycmd).\n\n")
md.append("## Stats\n\n")
md.append(f"- **{len(messages)}** Protobuf message classes (top-level, implementing `IMessage<Self>`)\n")
md.append(f"- **{total_fields}** total fields recovered with their tag + type\n")
md.append(f"- Field NAMES are obfuscated; tags + types reveal the wire schema\n\n")

md.append("## Top field types\n\n| Type | Count |\n|---|---|\n")
for t, n in type_counts.most_common(15):
    md.append(f"| `{t}` | {n} |\n")

md.append("\n## Largest messages (potential envelopes / common types)\n\n")
md.append("Messages with many fields are typically aggregator types (entity info, fight state, etc).\n\n")
md.append("| Obf | Fields | Sample tag→type |\n|---|---|---|\n")
for cls, info in sorted(messages.items(), key=lambda x: -x[1]["fieldCount"])[:20]:
    sample = ", ".join(f"{f['tag']}=`{f['type'][:25]}`" for f in info["fields"][:6])
    md.append(f"| `{cls}` | {info['fieldCount']} | {sample}... |\n")

md.append("\n## The envelope (`gui` — observed 89× at runtime)\n\n")
if "gui" in messages:
    g = messages["gui"]
    md.append(f"`gui` has **{g['fieldCount']} fields**:\n\n")
    md.append("| Tag | Type | Backing field |\n|---|---|---|\n")
    for f in g["fields"]:
        md.append(f"| {f['tag']} | `{f['type']}` | `{f['backingField']}` |\n")

md.append("\n## Sample messages (first 30 by tag count)\n\n")
sample_msgs = sorted(messages.items(), key=lambda x: -x[1]["fieldCount"])[20:50]
for cls, info in sample_msgs:
    md.append(f"\n### `{cls}` ({info['fieldCount']} fields)\n\n")
    md.append("| Tag | Type |\n|---|---|\n")
    for f in info["fields"][:15]:
        md.append(f"| {f['tag']} | `{f['type']}` |\n")
    if info["fieldCount"] > 15:
        md.append(f"| ... | _({info['fieldCount']-15} more)_ |\n")

DOC_OUT.parent.mkdir(parents=True, exist_ok=True)
DOC_OUT.write_text("".join(md), encoding="utf-8")
print(f"Wrote {DOC_OUT}")
