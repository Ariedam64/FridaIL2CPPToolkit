"""
Walk all decompiled .cs files (output of ilspycmd on Cpp2IL il_recovery DLLs)
and extract every leak we can find for the obfuscated classes:

  - Async state machine names → reveal original method names
  - State machine fields → reveal original parameter names + types
  - Class declaration → parent class + implemented interfaces
  - using directives → which public types/namespaces this class touches
  - Field declarations → preserved field types (the field NAME is renamed but
    type is intact, even when the type is itself obfuscated)

Output:
  dofus-app/data/decompiled-class-info.json — { obfClass: { ... } }
  dofus-app/docs/decompiled-leaks.md — summary of recovered method signatures
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

DECOMPILED = Path(r"C:\Users\Romann\AppData\Local\Temp\decompiled_core")
DATA_OUT = Path(__file__).resolve().parents[1] / "data" / "decompiled-class-info.json"
DOC_OUT = Path(__file__).resolve().parents[1] / "docs" / "decompiled-leaks.md"

# ----- Patterns -----
# class declaration: public class NAME : PARENT, IFACE1, IFACE2 { … }
CLASS_DECL_RE = re.compile(r"^public\s+(?:abstract\s+|sealed\s+|partial\s+)*(?:static\s+)?class\s+(\w+)(?:\s*:\s*([\w,\s.<>`]+))?\s*$", re.MULTILINE)
# struct decl
STRUCT_DECL_RE = re.compile(r"^public\s+(?:partial\s+)?(?:readonly\s+|ref\s+)*struct\s+(\w+)(?:\s*:\s*([\w,\s.<>`]+))?\s*$", re.MULTILINE)
# Async state machine struct: <MethodName>d__N
ASYNC_SM_RE = re.compile(r"_003C([\w\d]+)_003Ed__(\d+)")
# Lambda closure class: <MethodName>b__N_M
LAMBDA_RE   = re.compile(r"_003C([\w\d]+)_003Eb__(\d+)(?:_(\d+))?")
# Local function: <MethodName>g__LocalName|N
LOCALFN_RE  = re.compile(r"_003C([\w\d]+)_003Eg__([\w\d]+)\|(\d+)(?:_(\d+))?")
# State machine field: "public string code;" "public long id;"
SM_FIELD_RE = re.compile(r"^\s*public\s+(?!struct|class|readonly|static)([\w\d.<>\[\]`,\s]+?)\s+(\w+);\s*$", re.MULTILINE)
# using directive
USING_RE = re.compile(r"^using\s+([\w\d.]+);\s*$", re.MULTILINE)

# Heuristic: which simple identifier is "obfuscated"? lowercase 1-3 chars (with optional `N for generics)
def is_obfuscated(name):
    return bool(re.match(r"^[a-z]{1,3}(`\d+)?$", name))

# ----- Walk all files -----
classes: dict = {}
file_count = 0
for f in DECOMPILED.rglob("*.cs"):
    file_count += 1
    try:
        text = f.read_text(encoding="utf-8")
    except Exception:
        continue
    # Class name = file stem (one class per file via -p mode)
    cls_name = f.stem
    if not cls_name or cls_name.startswith("-"):
        continue
    info = {
        "file": str(f.relative_to(DECOMPILED)),
        "namespace": str(f.parent.relative_to(DECOMPILED)).replace("\\", "."),
        "isObfuscated": is_obfuscated(cls_name),
        "parentClass": None,
        "interfaces": [],
        "usings": [],
        "asyncMethods": {},   # methodName → set of param names + types
        "lambdaMethods": set(),
        "localFunctions": set(),
        "stateMachineCount": 0,
    }
    # usings
    for u in USING_RE.findall(text):
        info["usings"].append(u)
    # class decl
    cls_match = CLASS_DECL_RE.search(text)
    if cls_match:
        bases = (cls_match.group(2) or "").strip()
        if bases:
            parts = [p.strip() for p in bases.split(",")]
            # Heuristic: first class-like (PascalCase or lowercase obf) is parent, rest are interfaces
            if parts:
                info["parentClass"] = parts[0]
                info["interfaces"] = parts[1:]
    # async state machines: these are nested structs whose name encodes the parent method
    for m in ASYNC_SM_RE.finditer(text):
        method_name = m.group(1)
        info["asyncMethods"].setdefault(method_name, {"params": []})
        info["stateMachineCount"] += 1
    for m in LAMBDA_RE.finditer(text):
        info["lambdaMethods"].add(m.group(1))
    for m in LOCALFN_RE.finditer(text):
        info["localFunctions"].add((m.group(1), m.group(2)))

    # Now extract param names per state machine
    # Each state machine struct has: fields = (params + state machine bookkeeping)
    # The bookkeeping fields all start with "_003C_003E" or "_003C_003Et"
    # We want to extract real-named fields between two struct declarations
    # Simpler: regex find all `public TYPE PARAM;` inside `_003CMethod_003Ed__N` blocks
    # Use a sliding window approach: split file by "private struct _003C..._003E"
    state_machine_blocks = re.split(r"private\s+struct\s+_003C(\w+)_003Ed__\d+", text)
    # state_machine_blocks[0] is preamble, then alternating (methodName, body)
    for i in range(1, len(state_machine_blocks) - 1, 2):
        method_name = state_machine_blocks[i]
        body = state_machine_blocks[i + 1]
        # Take only up to the next struct or close-of-class
        end = body.find("\n\t[StructLayout")
        if end < 0: end = body.find("\nprivate struct")
        if end < 0: end = body.find("\n}")
        body = body[:end] if end > 0 else body
        params = []
        for fm in SM_FIELD_RE.finditer(body):
            ftype, fname = fm.group(1).strip(), fm.group(2)
            # Skip compiler-generated bookkeeping (named with _003C / __builder / __1 / etc)
            if fname.startswith("_003C") or fname == "_003C_003E1__state" or fname.endswith("__1") or fname.endswith("__2") or fname.endswith("__3") or fname.endswith("__4"):
                continue
            params.append({"name": fname, "type": ftype})
        info["asyncMethods"].setdefault(method_name, {"params": []})
        info["asyncMethods"][method_name]["params"] = params

    info["lambdaMethods"] = sorted(info["lambdaMethods"])
    info["localFunctions"] = [{"method": a, "name": b} for a, b in sorted(info["localFunctions"])]
    classes[cls_name] = info

print(f"Walked {file_count} files. Indexed {len(classes)} classes.")

# ----- Stats -----
obf_count = sum(1 for c in classes.values() if c["isObfuscated"])
clear_count = len(classes) - obf_count
async_methods_total = sum(len(c["asyncMethods"]) for c in classes.values())
print(f"Obfuscated: {obf_count}, Clear: {clear_count}")
print(f"Total async methods (with leaked names): {async_methods_total}")

# Methods with at least 1 param
async_with_params = sum(
    1 for c in classes.values() for m in c["asyncMethods"].values() if m.get("params")
)
print(f"Async methods with leaked param names+types: {async_with_params}")

# ----- Save data -----
DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
DATA_OUT.write_text(json.dumps(classes, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"\nWrote {DATA_OUT}")

# ----- Build summary doc -----
md = ["# Dofus 3.0 — Decompiled-IL leaks\n\n"]
md.append("Extracted by walking every `.cs` file from ilspycmd's decompilation of Cpp2IL's `dll_il_recovery` output of `Core.dll`. Method bodies are stripped (`throw null`) but signatures, async state machines, parameter names, parent classes and interfaces are intact.\n\n")
md.append("## Stats\n\n")
md.append(f"- **{len(classes)}** classes indexed (out of 8923 in Core.dll)\n")
md.append(f"- **{obf_count}** still obfuscated, **{clear_count}** with clear names\n")
md.append(f"- **{async_methods_total}** async/lambda methods with their **original names** recovered (compiler-gen leak)\n")
md.append(f"- **{async_with_params}** of those also have their **original parameter names + types** recovered\n\n")

# Top obfuscated classes by method count + param richness
ranked = sorted(
    [(name, info) for name, info in classes.items() if info["isObfuscated"]],
    key=lambda x: -(len(x[1]["asyncMethods"]) + sum(len(m.get("params", [])) for m in x[1]["asyncMethods"].values()))
)

md.append("## Top obfuscated classes by recovered method signatures\n\n")
md.append("These obfuscated classes have the most async/lambda method names + parameter info recovered. Each method line shows: `methodName(paramName: paramType, ...)`.\n\n")
for name, info in ranked[:25]:
    md.append(f"### `{name}`\n")
    if info["parentClass"]:
        md.append(f"`{name}` extends `{info['parentClass']}`")
        if info["interfaces"]:
            md.append(f", implements {', '.join(f'`{i}`' for i in info['interfaces'])}")
        md.append("\n\n")
    if info["usings"]:
        ankama_usings = [u for u in info["usings"] if "Ankama" in u or "Shopi" in u or "Haapi" in u or "DotNetty" in u or "FMOD" in u or "Sentry" in u or "Polly" in u]
        if ankama_usings:
            md.append("**Touching public types**: " + ", ".join(f"`{u}`" for u in ankama_usings) + "\n\n")
    if info["asyncMethods"]:
        md.append("**Recovered async/lambda methods**:\n")
        for mname, mdata in sorted(info["asyncMethods"].items()):
            params = mdata.get("params", [])
            params_str = ", ".join(f"{p['name']}: `{p['type']}`" for p in params) if params else ""
            md.append(f"- `{mname}({params_str})`\n")
        md.append("\n")

DOC_OUT.parent.mkdir(parents=True, exist_ok=True)
DOC_OUT.write_text("".join(md), encoding="utf-8")
print(f"Wrote {DOC_OUT}")

# ----- Quick sample print to stdout -----
print("\nSample obfuscated class with rich data:")
for name, info in ranked[:3]:
    print(f"\n  === {name} ===")
    print(f"  parent={info['parentClass']!r}, ifaces={info['interfaces']}")
    if info["asyncMethods"]:
        for mname in list(info["asyncMethods"])[:5]:
            params = info["asyncMethods"][mname].get("params", [])
            params_str = ", ".join(f"{p['name']}:{p['type']}" for p in params)
            print(f"    {mname}({params_str})")
