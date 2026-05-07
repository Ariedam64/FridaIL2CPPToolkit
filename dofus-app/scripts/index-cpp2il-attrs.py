#!/usr/bin/env python3
"""
Index Cpp2IL-decompiled .cs files (with attributeanalyzer/attributeinjector
processors) and extract per-class:

- Token (IL2CPP metadata token, stable across builds with same metadata)
- Whether the class is protoc-generated (has [GeneratedCode("protoc"] anywhere)
- Inherits / implements
- Per-method:  name, RVA (in GameAssembly.dll), Offset, Length, Token
- Per-field:   name, FieldOffset, Token, type, modifiers (static/const)

The RVAs are the real native-code addresses inside GameAssembly.dll (the
attribute injector reads them from Cpp2IL's analysis). They let Frida hook
methods atomically: `Module.findBaseAddress("GameAssembly.dll").add(rva)`.

Output:
  dofus-app/data/indexed/<assembly>.classes.json
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# ---------------- Regexes ----------------

# Captures Token attribute "[Token(Token = "0x06000049")]"
RE_TOKEN = re.compile(r'\[Token\(Token\s*=\s*"(0x[0-9A-Fa-f]+)"\)\]')

# Captures Address attribute "[Address(RVA = "0x...", Offset = "0x...", Length = "0x...")]"
RE_ADDRESS = re.compile(
    r'\[Address\(RVA\s*=\s*"(0x[0-9A-Fa-f]+)"'
    r'(?:,\s*Offset\s*=\s*"(0x[0-9A-Fa-f]+)")?'
    r'(?:,\s*Length\s*=\s*"(0x[0-9A-Fa-f]+)")?\)\]'
)

# Captures FieldOffset attribute
RE_FIELD_OFFSET = re.compile(r'\[FieldOffset\(Offset\s*=\s*"(0x[0-9A-Fa-f]+)"\)\]')

# Captures GeneratedCode attribute, returns the tool name
RE_GENERATED_CODE = re.compile(r'\[GeneratedCode\("([^"]+)",')

# AsyncStateMachine attribute leak: `[AsyncStateMachine(typeof(_003CMethodName_003Ed__N))]`
# Reveals the ORIGINAL method name before OPS obfuscation.
RE_ASYNC_STATE_MACHINE = re.compile(r'\[AsyncStateMachine\(typeof\(_003C([A-Za-z_][A-Za-z0-9_]*)_003E[bd]__\d+\)\)\]')

# Iterator state machine: same idea with IteratorStateMachine
RE_ITERATOR_STATE_MACHINE = re.compile(r'\[IteratorStateMachine\(typeof\(_003C([A-Za-z_][A-Za-z0-9_]*)_003E[bd]__\d+\)\)\]')

# Captures class/struct/enum/interface header line, e.g.:
# public sealed class gui : IMessage<gui>, IMessage, IEquatable<gui>, ...
RE_TYPE_HEADER = re.compile(
    r'^(?P<modifiers>(?:public|internal|private|protected|sealed|abstract|static|partial|readonly|unsafe|\s)+)'
    r'(?P<kind>class|struct|enum|interface)\s+'
    r'(?P<name>[A-Za-z_][A-Za-z0-9_]*(?:`\d+)?)'
    r'(?P<rest>.*)$'
)

# Captures method declaration. Loose: any line ending with parens and not a property accessor.
# Skipped because parsing C# methods is too complex; we rely on attribute-anchored extraction.

# A method's identifier line: `<modifiers> <retType> <name>(...)` followed by body block
# Best heuristic: look for `(...)` followed by `{` on the next non-empty line.
RE_METHOD_LIKE = re.compile(
    r'^(?P<line>(?P<modifiers>(?:public|internal|private|protected|static|virtual|override|abstract|sealed|extern|partial|async|unsafe|new|readonly|\s)+)?'
    r'(?P<retty>[\w<>,\[\]\.\?]+(?:\s+))'
    r'(?P<name>[A-Za-z_][A-Za-z0-9_]*)'
    r'\s*(?:<[^>]*>)?'
    r'\s*\((?P<params>[^)]*)\)\s*)$'
)

# A field declaration: `<modifiers> <type> <name>;` or `... = ...;`
RE_FIELD_LIKE = re.compile(
    r'^(?P<modifiers>(?:public|internal|private|protected|static|readonly|const|volatile|new|\s)+)?'
    r'(?P<ty>[\w<>,\[\]\.\?\s]+?)\s+'
    r'(?P<name>[A-Za-z_][A-Za-z0-9_]*)'
    r'\s*(?:=\s*[^;]+)?\s*;\s*$'
)

# Property accessor get/set
RE_ACCESSOR = re.compile(r'^\s*(get|set|add|remove)\s*$')


def parse_cs_file(path: Path) -> dict:
    """Parse a single .cs file and return a class dict.

    Each .cs from ilspycmd contains exactly one top-level class (by the
    `-p` mode used). Nested types appear inside.
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")

    # We do a single pass, accumulating attribute buffer. When a non-attribute
    # token appears we try to attach the buffer to it.
    classes: list[dict] = []  # stack of currently-open type contexts
    output_classes: list[dict] = []
    pending_attrs: list[str] = []
    brace_depth = 0
    type_stack: list[dict] = []  # nested type context

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Track braces (rough — comments/strings ignored, but C# decompiled
        # output is syntactically clean enough)
        opens = stripped.count("{")
        closes = stripped.count("}")

        # Closing of current type
        if type_stack and brace_depth + opens - closes < type_stack[-1]["_open_at_depth"]:
            type_stack.pop()
            brace_depth += opens - closes
            i += 1
            continue

        if stripped.startswith("[") and stripped.endswith("]"):
            pending_attrs.append(stripped)
            i += 1
            continue

        # Multi-line attributes
        if stripped.startswith("[") and not stripped.endswith("]"):
            buf = stripped
            i += 1
            while i < len(lines) and "]" not in lines[i]:
                buf += " " + lines[i].strip()
                i += 1
            if i < len(lines):
                buf += " " + lines[i].strip()
                i += 1
            pending_attrs.append(buf)
            continue

        # Type header detection
        m_type = RE_TYPE_HEADER.match(stripped)
        if m_type and "(" not in m_type.group("name"):
            kind = m_type.group("kind")
            name = m_type.group("name")
            rest = m_type.group("rest").rstrip(" {")
            parents = []
            if ":" in rest:
                _, parent_str = rest.split(":", 1)
                parents = [p.strip() for p in parent_str.split(",") if p.strip()]
            attrs = list(pending_attrs)
            pending_attrs = []
            type_obj = {
                "name": name,
                "kind": kind,
                "modifiers": [m for m in m_type.group("modifiers").split() if m],
                "parents": parents,
                "token": None,
                "is_protoc_generated": False,
                "fields": [],
                "methods": [],
                "nested_types": [],
                "_attrs_raw": attrs,
                "_open_at_depth": brace_depth + 1,  # we'll pop when depth drops below this
            }
            # Decode attrs
            for a in attrs:
                m_tok = RE_TOKEN.search(a)
                if m_tok:
                    type_obj["token"] = m_tok.group(1)
                m_gc = RE_GENERATED_CODE.search(a)
                if m_gc and m_gc.group(1) == "protoc":
                    type_obj["is_protoc_generated"] = True
            type_obj["_attrs_raw"] = []  # don't keep raw

            if type_stack:
                type_stack[-1]["nested_types"].append(type_obj)
            else:
                output_classes.append(type_obj)
            type_stack.append(type_obj)
            brace_depth += opens - closes
            i += 1
            continue

        # Try field
        m_field = RE_FIELD_LIKE.match(stripped) if pending_attrs else None
        # Try method
        m_method = RE_METHOD_LIKE.match(stripped) if pending_attrs else None

        # Heuristic: prefer method if line contains parens and following non-empty
        # line is "{" or accessor list
        if pending_attrs and m_method and "(" in stripped:
            # parse method
            tok = None
            rva = off = length = None
            is_protoc = False
            original_name = None
            for a in pending_attrs:
                m_tok = RE_TOKEN.search(a)
                if m_tok and tok is None:
                    tok = m_tok.group(1)
                m_addr = RE_ADDRESS.search(a)
                if m_addr:
                    rva, off, length = m_addr.group(1), m_addr.group(2), m_addr.group(3)
                m_gc = RE_GENERATED_CODE.search(a)
                if m_gc and m_gc.group(1) == "protoc":
                    is_protoc = True
                m_async = RE_ASYNC_STATE_MACHINE.search(a)
                if m_async:
                    original_name = m_async.group(1)
                m_iter = RE_ITERATOR_STATE_MACHINE.search(a)
                if m_iter and original_name is None:
                    original_name = m_iter.group(1)
            if type_stack:
                type_stack[-1]["methods"].append({
                    "name": m_method.group("name"),
                    "original_name": original_name,
                    "return_type": m_method.group("retty").strip(),
                    "params_raw": m_method.group("params").strip(),
                    "modifiers": [m for m in (m_method.group("modifiers") or "").split() if m],
                    "token": tok,
                    "rva": rva,
                    "offset": off,
                    "length": length,
                    "is_protoc_generated": is_protoc,
                })
                if is_protoc:
                    type_stack[-1]["is_protoc_generated"] = True
            pending_attrs = []
            brace_depth += opens - closes
            i += 1
            continue

        if pending_attrs and m_field and "(" not in stripped:
            tok = field_off = None
            for a in pending_attrs:
                m_tok = RE_TOKEN.search(a)
                if m_tok and tok is None:
                    tok = m_tok.group(1)
                m_fo = RE_FIELD_OFFSET.search(a)
                if m_fo:
                    field_off = m_fo.group(1)
            if type_stack:
                type_stack[-1]["fields"].append({
                    "name": m_field.group("name"),
                    "type": m_field.group("ty").strip(),
                    "modifiers": [m for m in (m_field.group("modifiers") or "").split() if m],
                    "token": tok,
                    "field_offset": field_off,
                })
            pending_attrs = []
            brace_depth += opens - closes
            i += 1
            continue

        # Property accessors share Token+Address with their property declarator.
        # Skipping for now — they appear inside the property body block.

        # Drop pending attrs if we hit something else (closing brace, etc.)
        if not (stripped.startswith("[") or stripped == ""):
            pending_attrs = []
        brace_depth += opens - closes
        i += 1

    return {"file": path.name, "types": output_classes}


def main(decomp_dir: Path, output_path: Path, asm_label: str) -> int:
    cs_files = sorted(decomp_dir.rglob("*.cs"))
    print(f"[*] Parsing {len(cs_files)} .cs files from {decomp_dir}")

    all_types: list[dict] = []
    n_protoc = 0
    n_total = 0
    for cs in cs_files:
        try:
            parsed = parse_cs_file(cs)
        except Exception as e:
            print(f"  ! parse failed for {cs.name}: {e}", file=sys.stderr)
            continue
        for t in parsed["types"]:
            t["source_file"] = cs.name
            t["namespace"] = str(cs.parent.relative_to(decomp_dir)).replace("\\", ".") if cs.parent != decomp_dir else ""
            if t["namespace"] == ".":
                t["namespace"] = ""
            all_types.append(t)
            n_total += 1
            if t.get("is_protoc_generated"):
                n_protoc += 1

    print(f"[*] {n_total} top-level types, {n_protoc} protoc-generated")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(
            {"assembly": asm_label, "types": all_types},
            ensure_ascii=False,
            indent=1,  # compact
        ),
        encoding="utf-8",
    )
    print(f"[*] Wrote {output_path} ({output_path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 4:
        decomp = Path(sys.argv[1])
        out = Path(sys.argv[2])
        label = sys.argv[3]
    else:
        decomp = Path(r"C:/Users/Romann/AppData/Local/Temp/cpp2il_attrs_decomp")
        out = Path("f:/FridaIL2CPPToolkit/dofus-app/data/indexed/protocol-game.classes.json")
        label = "Ankama.Dofus.Protocol.Game"
    sys.exit(main(decomp, out, label))
