"""
Build a deobfuscation map for Dofus 3.0 by cross-referencing 4 leak vectors:

  1. Compiler-generated nested classes leak the original method name in their
     `<Method>...` syntax, with declaringClass = (possibly obfuscated) parent.
     → mapping: obfuscated_class → [original method names]

  2. Pascal-case classes survived obfuscation (DoNotRename). They form the
     "vocabulary of reference" + give us names we can search for.

  3. Inheritance: when a clear class extends an obfuscated one, the obfuscated
     base class probably shares the domain.

  4. ☆ MOST POWERFUL ☆ Type references: even though OPS renames method bodies,
     the type system is preserved. Field types and method param/return types
     that reference public types (Protobuf models, Unity, FMOD, DotNetty,
     Ankama.HaapiAnkama.Model, Com.Ankama.Shopi.Model, etc.) leak the domain
     of every obfuscated class that touches them.

Inputs: shape_*.json + dump_*.json files dumped from the toolkit's
        `dumpAssemblyShape` and `dumpClassAsString` RPCs.
Output: dofus-app/docs/deobfuscation-map.md  +  deobfuscation-map.json
"""
import json
import re
import sys
from collections import defaultdict, Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

TEMP = Path(r"C:\Users\Romann\AppData\Local\Temp")
DOC_OUT = Path(__file__).resolve().parents[1] / "docs" / "deobfuscation-map.md"
JSON_OUT = Path(__file__).resolve().parents[1] / "docs" / "deobfuscation-map.json"

# ---------- Load shapes ----------
shapes = {}
for f in sorted(TEMP.glob("shape_*.json")):
    if f.stem == "shape_full":
        continue
    try:
        d = json.load(f.open(encoding="utf-8"))["result"]
        asm = f.stem.replace("shape_", "").replace("_", ".")
        shapes[asm] = d
    except Exception as e:
        print(f"skip {f}: {e}")

print(f"Loaded {len(shapes)} assemblies")

# ---------- Load class dumps (output of dumpClassAsString) ----------
# Keyed by simple class name. Each value is the markdown dump string.
class_dumps = {}

# (a) Per-class dumps in %TEMP%\dumps\<name>.txt — each = { "result": "<markdown>" }
dumps_dir = TEMP / "dumps"
if dumps_dir.is_dir():
    for f in sorted(dumps_dir.glob("*.txt")):
        try:
            body = json.load(f.open(encoding="utf-8"))["result"]
            if body and "not found" not in body:
                class_dumps[f.stem] = body
        except Exception:
            pass

# (b) Legacy single-blob from session 1 (16 classes batched)
legacy = Path(r"C:\Users\Romann\.claude\projects\f--FridaIL2CPPToolkit\15ae67f8-92a5-4408-9226-2d6fa4843b81\tool-results\bwtx388hn.txt")
if legacy.exists():
    text = legacy.read_text(encoding="utf-8")
    blocks = re.split(r"^=== (\w+(?:`\d+)?) ===\s*$", text, flags=re.MULTILINE)
    for i in range(1, len(blocks), 2):
        name = blocks[i].strip()
        body = blocks[i + 1] if i + 1 < len(blocks) else ""
        if name not in class_dumps and body.strip():
            class_dumps[name] = body
print(f"Loaded {len(class_dumps)} class dumps")

# ---------- Helpers ----------
def is_obfuscated(name):
    return bool(re.match(r"^[a-z]{1,3}(`\d+)?$", name))

def is_compiler_gen(name):
    return name.startswith("<") or name.startswith("__")

def extract_leaked_method(name):
    if not name.startswith("<"):
        return None
    s = name.rfind("<") + 1
    e = name.find(">", s)
    if e < 0:
        return None
    method = name[s:e]
    if not method or method == "Module" or method.startswith("PrivateImpl"):
        return None
    return method

# Leak via compiler-gen
obf_methods = defaultdict(set)
clear_methods = defaultdict(set)
for asm, classes in shapes.items():
    name_to_ns = {c["name"]: c["ns"] for c in classes}
    for c in classes:
        if not is_compiler_gen(c["name"]):
            continue
        method = extract_leaked_method(c["name"])
        if not method:
            continue
        decl = c.get("declaring")
        if not decl:
            continue
        decl_ns = name_to_ns.get(decl, "")
        full = f"{decl_ns}.{decl}" if decl_ns else decl
        key = f"{asm}::{full}"
        if is_obfuscated(decl):
            obf_methods[key].add(method)
        else:
            clear_methods[key].add(method)

# Leak via inheritance
inheritance_clues = defaultdict(set)
for asm, classes in shapes.items():
    for c in classes:
        if not c.get("parent") or not is_obfuscated(c["parent"]):
            continue
        if not is_obfuscated(c["name"]) and not is_compiler_gen(c["name"]):
            inheritance_clues[c["parent"]].add(c["name"])

# Leak via type references (parsed from dump-class output)
# Each dump line is like:
#   - System.Void Foo(Type1 a, Type2 b)
#   - static System.Int32 bar()
#   - Core.DataCenter.Metadata.World.WorldMapData <field>k__BackingField
TYPE_RE = re.compile(r"\b([A-Z][\w.]+(?:\.[A-Z][\w.]+)+)\b")
type_refs = defaultdict(Counter)  # obf_class_name → Counter(public type → count)
for cls_name, body in class_dumps.items():
    if not is_obfuscated(cls_name):
        continue
    for line in body.splitlines():
        for t in TYPE_RE.findall(line):
            # filter out trivial framework noise
            if t.startswith("System."):
                continue
            if t.startswith("Cysharp.Threading"):
                continue
            if t.startswith("UnityEngine."):
                continue  # Unity engine types — too generic
            type_refs[cls_name][t] += 1

# ---------- Domain inference ----------
DOMAIN_KEYWORDS = {
    "Combat":     ["Spell", "Cast", "Damage", "Buff", "Debuff", "Heal", "Fight", "Combat", "Fighter", "Hp", "TurnTime", "FightEvent"],
    "Movement":   ["Move", "Path", "Walk", "Run", "Pos", "Cell", "Direction"],
    "World":      ["World", "Map", "Floor", "Area", "Region", "Cartography", "Subarea"],
    "Pathfind":   ["FindPath", "Pathfind", "Astar", "Solver"],
    "Network":    ["Connect", "Send", "Receive", "Socket", "Packet", "Message", "Handler", "Network", "Channel"],
    "Auth":       ["Login", "Auth", "Token", "ApiKey", "Account", "Sign", "Otp", "Mfa", "Captcha"],
    "Crypto":     ["Encrypt", "Decrypt", "Hash", "Cipher", "Key"],
    "UI":         ["UI", "Window", "Widget", "Tooltip", "Hyperlink", "Bind", "Mesh", "Display", "Render", "Hud", "Cursor", "VisualElement"],
    "Anim":       ["Animation", "Anim", "Tween", "Motion"],
    "Inventory":  ["Inventory", "Item", "Equip", "Stuff", "Slot", "Bag", "Storage", "Box"],
    "Trade":      ["Trade", "Exchange", "Market", "Auction", "Boutique", "Shop", "Kard", "Buy", "Sell", "Cart", "Order", "Bak"],
    "Chat":       ["Chat", "Message", "Channel"],
    "Quest":      ["Quest", "Achievement", "Objective", "Reward"],
    "Guild":      ["Guild", "Alliance"],
    "Audio":      ["Audio", "Sound", "Music", "FMOD", "Voice"],
    "Render":     ["Material", "Texture", "Sprite", "Shader", "Camera", "Light"],
    "Data":       ["Cache", "Preload", "Database", "Definition", "Metadata", "DataCenter"],
    "Time":       ["Timer", "Delay", "Timeout", "Frame", "Tick"],
    "Login":      ["LogIn", "Login", "Connect", "Disconnect"],
    "Boutique":   ["Cart", "Order", "Article", "Catalog", "Promote", "Payment", "Shopi"],
    "Almanax":    ["Almanax"],
    "Money":      ["Ogrine", "MoneyBalance", "Money"],
    "Cms":        ["Cms", "Feed"],
}

DOMAIN_TYPE_PATTERNS = [
    ("HAAPI",       r"^Com\.Ankama\.HaapiAnkama\."),
    ("HAAPI",       r"^Com\.Ankama\.HaapiDofus\."),
    ("Boutique",    r"^Com\.Ankama\.Shopi\."),
    ("Network",     r"^DotNetty\."),
    ("Network",     r"^Google\.Protobuf\."),
    ("Audio",       r"^FMOD\."),
    ("Audio",       r"^Ankama\.AudioManagement\."),
    ("Audio",       r"^AleCore\."),
    ("DataCenter",  r"^Core\.DataCenter\."),
    ("Protocol",    r"^Ankama\.Dofus\.Protocol\."),
    ("Login",       r"^Ankama\.LauncherConnection\."),
    ("Login",       r"^Ankama\.SpinConnection\."),
    ("Crypto",      r"^Org\.BouncyCastle\."),
    ("UI",          r"^UnityEngine\.UIElements\."),
    ("UI",          r"^Core\.UILogic\."),
    ("Sentry",      r"^Sentry"),
    ("Lua",         r"^XLua"),
    ("Compression", r"^K4os\."),
    ("Anim",        r"^Ankama\.Animator2D\."),
    ("Resource",    r"^Unity\.ResourceManager"),
    ("Tween",       r"^DG\.Tweening"),
]

def infer_domains_from_methods(methods):
    out = Counter()
    for domain, keywords in DOMAIN_KEYWORDS.items():
        for kw in keywords:
            for m in methods:
                if kw.lower() in m.lower():
                    out[domain] += 1
                    break
    return out

def infer_domains_from_types(types):
    out = Counter()
    for t in types:
        for domain, pat in DOMAIN_TYPE_PATTERNS:
            if re.match(pat, t):
                out[domain] += types[t]
    return out

# ---------- Load decompiled-IL leaks (6th leak vector — fullest data) ----------
DECOMPILED_INFO = Path(__file__).resolve().parents[1] / "data" / "decompiled-class-info.json"
decompiled_data: dict = {}
if DECOMPILED_INFO.exists():
    decompiled_data = json.load(DECOMPILED_INFO.open(encoding="utf-8"))
    print(f"Loaded decompiled info: {len(decompiled_data)} classes")

# ---------- Load protocol-handler topology (5th leak vector) ----------
PROTO_HANDLERS = Path(__file__).resolve().parents[1] / "docs" / "protocol-handlers.json"
proto_class_messages: dict = {}
if PROTO_HANDLERS.exists():
    pd_data = json.load(PROTO_HANDLERS.open(encoding="utf-8"))
    proto_class_messages = pd_data.get("classHandledMessages", {})
    print(f"Loaded protocol topology: {len(proto_class_messages)} dispatcher classes")

CLEAR_HANDLER_LABELS = {
    "khe": "FightEntities event",
    "khu": "Inventory event",
    "khn": "Inventory event",
    "iso": "Roleplay intro event",
    "jno": "EndTurn event",
    "iyy": "BuffsFight event",
    "izc": "BuffsFight event",
    "ksl": "ColorSet event",
    "knl": "BasicCharacter event",
    "icb": "SmithMagic event",
    "idm": "WatchEquipment event",
    "jfs": "SmithMagicCoop event",
    "jfi": "SmithMagicCoop event",
    "ibk": "StorageTabInfo event",
    "jjk": "InfiniteDream EndFight event",
    "jsg": "MapDisplay event",
    "kaz": "MarkedCells event",
}

# ---------- Combined identification ----------
identifications = []  # list of dicts
all_obf_keys = (set(obf_methods.keys())
                | {f"Core::{n}" for n in type_refs.keys()}
                | {f"Core::{n}" for n in inheritance_clues.keys()}
                | {f"Core::{n}" for n in proto_class_messages.keys() if is_obfuscated(n)})
for key in all_obf_keys:
    asm, full = key.split("::", 1)
    name = full.split(".")[-1] if "." in full else full
    methods = obf_methods.get(key, set())
    types = type_refs.get(name, Counter())
    children = inheritance_clues.get(name, set())
    proto_msgs = proto_class_messages.get(name, [])
    decomp = decompiled_data.get(name, {})
    if not methods and not types and not children and not proto_msgs and not decomp:
        continue
    # Decompiled async methods may have richer signatures than what we got from compiler-gen alone
    decomp_async = decomp.get("asyncMethods", {})
    if decomp_async:
        # Add to methods set for domain inference + signature richness
        for mname in decomp_async:
            methods.add(mname)
    domains_methods = infer_domains_from_methods(methods)
    domains_types = infer_domains_from_types(types)
    combined = domains_methods + domains_types
    sig_richness = sum(len(m.get("params", [])) for m in decomp_async.values())
    score = sum(combined.values()) + len(methods) + len(children) + (len(proto_msgs) // 5) + (sig_richness // 3)
    identifications.append({
        "asm": asm,
        "obf": full,
        "name": name,
        "score": score,
        "methods": sorted(methods),
        "type_refs": types.most_common(15),
        "children": sorted(children),
        "domains": combined.most_common(5),
        "protoMessageCount": len(proto_msgs),
        "decompAsyncMethods": decomp_async,
        "decompParent": decomp.get("parentClass"),
        "decompInterfaces": decomp.get("interfaces", []),
        "decompUsings": decomp.get("usings", []),
    })

identifications.sort(key=lambda x: -x["score"])

# ---------- Build curated picks ----------
def best_label(idx):
    """Pick a human-readable likely identity from domain hints."""
    type_keys = [t for t, _ in idx["type_refs"]]
    methods = idx["methods"]
    children = idx["children"]
    name = idx.get("name") or idx["obf"].split(".")[-1]
    def has(prefix):  # exact prefix match
        return any(t.startswith(prefix) for t in type_keys)
    def hassub(sub):  # substring (use sparingly)
        return any(sub in t for t in type_keys)
    # NEW: Protocol topology first — when a class handles many messages
    # AND some of those have clear-name handlers, this is the strongest
    # signal of role.
    proto_msgs = proto_class_messages.get(name, [])
    if proto_msgs:
        labeled = [m for m in proto_msgs if m in CLEAR_HANDLER_LABELS]
        if labeled:
            domain_counter = Counter(CLEAR_HANDLER_LABELS[m].split()[0] for m in labeled)
            top_domain = domain_counter.most_common(1)[0][0]
            return f"Protocol service [{top_domain}] ({len(proto_msgs)} msg handlers)"
        if len(proto_msgs) >= 50:
            return f"Major protocol dispatcher ({len(proto_msgs)} msg handlers, domain TBD)"
    # Hard rules first (most specific)
    has_haapi_ankama = has("Com.Ankama.HaapiAnkama.")
    has_haapi_dofus  = has("Com.Ankama.HaapiDofus.")
    has_shopi        = has("Com.Ankama.Shopi.")
    has_bak          = any("Bak" in t for t in type_keys)
    if has_haapi_ankama and has_haapi_dofus and has_shopi:
        return "HAAPI/Shopi configuration aggregator"
    if has_haapi_ankama and has_haapi_dofus:
        return "HAAPI client (Ankama+Dofus)"
    if has_shopi:
        return "Shopi (Boutique) client"
    if has_haapi_ankama and has_bak:
        return "HAAPI Ankama client (Bak/auction-house + Kard + CMS)"
    if has_haapi_ankama:
        return "HAAPI Ankama client"
    if has_haapi_dofus:
        return "HAAPI Dofus client (game-specific REST)"
    if any("DotNetty.Transport.Channels.IChannel" in t for t in type_keys):
        return "Network channel manager (DotNetty)"
    if any("Google.Protobuf.IMessage" in t for t in type_keys):
        return "Protobuf message dispatcher"
    if has("FMOD."):
        return "Audio manager (FMOD)"
    # Audio AleCore is specifically AleCore.Data.Sound, NOT Editor.AleCore
    if any("AleCore.Data.Sound" in t for t in type_keys):
        return "Audio playlist (AleCore Sound)"
    if has("Core.Rendering.Entity.") or any("EntityLook" in t for t in type_keys):
        return "Entity factory (rendering)"
    if has("Core.Rendering.Look.") or has("Core.Rendering."):
        return "Rendering pipeline"
    if has("Core.DataCenter.Metadata.World."):
        return "World/cartography UI"
    if has("Core.DataCenter.Metadata."):
        return "DataCenter consumer"
    if has("Ankama.Animator2D.") or has("Editor.AleCore.Data."):
        return "2D animation / sprite"
    if has("Ankama.LauncherConnection."):
        return "Launcher (Zaap) connection"
    if has("Ankama.SpinConnection."):
        return "Spin (login) connection"
    if has("Org.BouncyCastle."):
        return "Crypto routine"
    # Method-based fallbacks
    if any("Spell" in m for m in methods) and any("Fight" in m for m in methods):
        return "Combat (spells/fight)"
    if any("Cart" in m for m in methods) or any("Order" in m for m in methods):
        return "Boutique (cart/order)"
    if any(("CreateMaterial" in m or "GetTexture" in m) for m in methods):
        return "Material/texture renderer"
    if any("Generate" in m and "Character" in m for m in methods):
        return "Character/Entity factory"
    if any("Cartography" in m for m in methods):
        return "Cartography (worldmap)"
    if any("Audio" in m or "Sound" in m or "Music" in m or "FMOD" in m for m in methods):
        return "Audio (manager)"
    if any("Token" in m or "ApiKey" in m for m in methods):
        return "Auth/token service"
    if any("Pathfind" in m or "FindPath" in m for m in methods):
        return "Pathfinding"
    if any("ConnectAsync" in m for m in methods):
        return "Connection lifecycle (network)"
    if proto_msgs and len(proto_msgs) >= 10:
        return f"Protocol dispatcher ({len(proto_msgs)} msg handlers)"

    # Children with semantic content
    if any("SpellZoneShape" in c for c in children):
        return "Spell zone shape behavior (base)"
    if any("Directory" in c for c in children):
        return "Directory base (Guild/Alliance lists)"
    if any("Achievement" in c for c in children):
        return "Generic UI base (large)"
    if any(c.endswith("UI") or c.endswith("Ui") for c in children):
        return "UI base class"
    if any(c.endswith("Step") for c in children):
        return "Sequencer step base"
    if any(c.endswith("Service") for c in children):
        return "Service base class"
    if any(c.endswith("View") for c in children):
        return "View base class"
    if any(c.endswith("Behavior") for c in children):
        return "Behavior base class"
    if any("Objective" in m or "Quest" in m for m in methods):
        return "Quest objective tracker"
    return "?"

for idx in identifications:
    idx["label"] = best_label(idx)

# ---------- Output ----------
md = ["# Dofus 3.0 — Deobfuscation map\n"]
md.append("> Live IL2CPP runtime analysis. 4 leak vectors triangulated:\n")
md.append(">  1. **Compiler-gen leaks** — `<Method>...` nested classes leak the original method name + their declaring (obfuscated) class.\n")
md.append(">  2. **Survived names** — classes marked `[DoNotRename]` retain Pascal-case, used as vocabulary of reference.\n")
md.append(">  3. **Inheritance** — clear classes extending an obfuscated base reveal the base's domain.\n")
md.append(">  4. **Type references** — field & method types reference public types (HAAPI, Protobuf, FMOD, DotNetty, BouncyCastle, DataCenter…). The obfuscator preserves type system → domain leak for free.\n\n")
md.append(f"Coverage: {len(shapes)} assemblies dumped, {len(class_dumps)} classes deeply inspected.\n\n")

md.append("## High-confidence identifications\n")
md.append("Sorted by triangulation score (combination of leaked methods + type ref hits + clear children).\n\n")
md.append("| Score | Asm | Obf | Likely role | Evidence (sample) |\n")
md.append("|---|---|---|---|---|\n")
for idx in identifications[:60]:
    sample_evidence = []
    if idx["methods"]:
        m_str = ", ".join("`" + m + "`" for m in idx["methods"][:3])
        sample_evidence.append("methods: " + m_str)
    if idx["type_refs"]:
        t_str = ", ".join("`" + t.split(".")[-1] + "`" for t, _ in idx["type_refs"][:3])
        sample_evidence.append("types: " + t_str)
    if idx["children"]:
        c_str = ", ".join("`" + c + "`" for c in idx["children"][:3])
        sample_evidence.append("children: " + c_str)
    md.append(f"| {idx['score']} | {idx['asm']} | `{idx['obf']}` | **{idx['label']}** | {' • '.join(sample_evidence)} |\n")

md.append("\n## Detailed identifications (top 30)\n")
for idx in identifications[:30]:
    md.append(f"\n### `{idx['obf']}` — {idx['label']}\n")
    md.append(f"Assembly: `{idx['asm']}` · Score: {idx['score']}\n\n")
    if idx["methods"]:
        md.append(f"**Leaked methods ({len(idx['methods'])})**: {', '.join(f'`{m}`' for m in idx['methods'])}\n\n")
    if idx["type_refs"]:
        md.append("**Top type references**:\n")
        for t, c in idx["type_refs"][:10]:
            md.append(f"- `{t}` × {c}\n")
        md.append("\n")
    if idx["children"]:
        md.append(f"**Clear subclasses ({len(idx['children'])})**: {', '.join(f'`{c}`' for c in idx['children'][:15])}{' …' if len(idx['children']) > 15 else ''}\n\n")
    if idx["domains"]:
        md.append("**Inferred domains**: " + ", ".join(f"{d}({c})" for d, c in idx["domains"]) + "\n\n")

md.append("\n## Inheritance leaks (obfuscated base classes)\n")
md.append("| Obf base | Children | Sample |\n|---|---|---|\n")
for obf, kids in sorted(inheritance_clues.items(), key=lambda x: -len(x[1]))[:30]:
    kids_sorted = sorted(kids)
    md.append(f"| `{obf}` | {len(kids)} | {', '.join(kids_sorted[:5])}{' …' if len(kids) > 5 else ''} |\n")

# Save
DOC_OUT.parent.mkdir(parents=True, exist_ok=True)
DOC_OUT.write_text("".join(md), encoding="utf-8")
print(f"Wrote {DOC_OUT}")

JSON_OUT.write_text(json.dumps({
    "stats": {
        "assemblies": len(shapes),
        "classDumps": len(class_dumps),
        "obfuscatedWithMethodLeaks": len(obf_methods),
        "obfuscatedWithTypeRefs": len(type_refs),
        "obfuscatedWithSubclasses": len(inheritance_clues),
        "totalIdentifications": len(identifications),
    },
    "identifications": [
        {
            "asm": i["asm"],
            "obf": i["obf"],
            "label": i["label"],
            "score": i["score"],
            "methods": i["methods"],
            "typeRefs": i["type_refs"],
            "children": i["children"],
            "domains": i["domains"],
        } for i in identifications
    ],
}, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"Wrote {JSON_OUT}")
print(f"\nTop 15 identifications:")
for idx in identifications[:15]:
    print(f"  [{idx['score']:3}] {idx['obf']:8} → {idx['label']}")
