# Sprint multi-path déobfusc Dofus 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pousser la déobfusc Dofus 3 de ~50% à 85-95% du plafond pratique en 1-3 jours en combinant 4 nouvelles sources de signal (AssetRipper bundles, DBI/DDC mapping, hook FileDescriptor par signature, string-refs natif) mergées dans `frida-rename-table.json`.

**Architecture:** Chaque source produit un JSON normalisé `[{obf_name, original_name, namespace, confidence, evidence_source, evidence_detail}]`. Un orchestrateur `merge-rename-table.py` consomme tous les outputs et regen la rename table sans écraser silencieusement les conflits (agrégation en `name_candidates`). Hook FileDescriptor passe par localisation OFFLINE des RVA via XRefs Cpp2IL puis hook Frida ATOMIQUE par RVA — pas d'intercept-tout (a crashé en session 2).

**Tech Stack:** Python 3 (scripts existants pattern), TypeScript (frida-il2cpp-bridge module), Node (driver). Outils externes : AssetRipper CLI, dotnet protodec, Frida. Pas de framework de test formel — chaque script Python termine par une fonction `_self_test()` exécutable via `python script.py --self-test`.

**Spec:** [`dofus-app/docs/superpowers/specs/2026-04-29-deobfusc-sprint-multipath-design.md`](../specs/2026-04-29-deobfusc-sprint-multipath-design.md)

---

## File Structure

**Create (Python scripts) :**
- `dofus-app/scripts/parse-assetripper-monobehaviours.py` (~150 LOC) — parse AssetRipper YAML export, extrait `MonoScript.{m_ClassName, m_Namespace}`, cross-ref Token Cpp2IL.
- `dofus-app/scripts/parse-dbi-tables.py` (~120 LOC) — clone-aware parser DBI/DDC : ilspycmd sur les interop assemblies, extrait les mappings `obf → friendly`.
- `dofus-app/scripts/run-protodec.py` (~80 LOC) — wrapper qui invoque `protodec --il2cpp`, parse les `.proto` rebuilds, diff vs `proto-schema-decompiled.json`.
- `dofus-app/scripts/find-filedescriptor-init-rvas.py` (~150 LOC) — lit l'index Cpp2IL, identifie les méthodes init Protobuf-generated par signature (param `byte[]`, body référence `Google.Protobuf.Reflection`).
- `dofus-app/scripts/parse-captured-descriptors.py` (~120 LOC) — parse les byte[] FileDescriptorProto capturés runtime (utilise lib `protobuf` Python).
- `dofus-app/scripts/extract-stringrefs-classlinks.py` (~200 LOC) — extrait strings du `.rdata` GameAssembly.dll, scanne XRefs natives, cross-ref classes Cpp2IL.
- `dofus-app/scripts/merge-rename-table.py` (~180 LOC) — orchestrateur final, agrège tous les outputs en `frida-rename-table.json` v2, log conflits.

**Create (Frida + Node) :**
- `src/rpc-agent/proto-descriptor-capture.ts` (~150 LOC) — module Frida ciblé, hook par RVA atomique, capture byte[] arg0, throttle 200 hits/session.
- `src/rpc-agent/rpc-methods.ts` modify — register `installFileDescriptorCapture`, `getCapturedDescriptors`, `clearCapturedDescriptors`.
- `dofus-app/scripts/capture-proto-descriptors.js` (~80 LOC) — driver Node : install hooks → wait user input → dump → désinstall.

**Create (data outputs) :**
- `dofus-app/data/external/assetripper-monobehaviours.json`
- `dofus-app/data/external/dbi-name-table.json`
- `dofus-app/data/external/protodec-schema/*.proto` + `dofus-app/data/external/protodec-cross-check.json`
- `dofus-app/data/runtime/filedescriptor-init-candidates.json`
- `dofus-app/data/runtime/protobuf-descriptors-captured.json`
- `dofus-app/data/indexed/string-refs-classlinks.json`
- `dofus-app/data/indexed/frida-rename-table.json` v2 (extends existing)
- `dofus-app/data/indexed/merge-conflicts.md`

**Modify :**
- `dofus-app/docs/dofus-deobfuscation-final.md` — section "Session 8 — Multi-path sprint" en fin de doc.

**No external deps to install** sauf : `protoc`/`protobuf` Python (déjà présent vu sessions précédentes), `protodec` (dotnet tool), `AssetRipper` (binary). Voir Task 0 pour l'installation.

---

## Task 0: Préparation environnement (worktree, dépendances)

**Files:**
- Aucun fichier source modifié, juste install + worktree.

- [ ] **Step 1: Vérifier qu'on est dans un worktree dédié**

```bash
cd /f/FridaIL2CPPToolkit && git status -sb
```

Expected: branche dédiée (ex: `m1-foundation` ou worktree feature). Si on est sur `main`/branch principale, créer un worktree :

```bash
cd /f/FridaIL2CPPToolkit && git worktree add ../FridaIL2CPPToolkit-deobfusc-sprint -b deobfusc-multipath-sprint
cd ../FridaIL2CPPToolkit-deobfusc-sprint
```

- [ ] **Step 2: Vérifier outils tiers présents**

```bash
which python && python --version
which dotnet && dotnet --version
which node && node --version
which frida && frida --version
ls dofus-app/scripts/index-cpp2il-attrs.py  # confirme les scripts existants
ls dofus-app/data/indexed/core.classes.json dofus-app/data/indexed/protocol-game.classes.json
ls dofus-app/data/indexed/frida-rename-table.json
```

Expected: tous présents. Si l'un manque, STOP et demander au user.

- [ ] **Step 3: Installer protodec si absent**

```bash
dotnet tool list -g | grep -i protodec || dotnet tool install --global protodec --version 1.1.0
```

Expected: `protodec` installé globalement.

- [ ] **Step 4: Vérifier ou télécharger AssetRipper CLI**

```bash
ls C:/Tools/AssetRipper/AssetRipper.GUI.Free.exe 2>/dev/null || echo "NEED_TO_INSTALL"
```

Si NEED_TO_INSTALL : télécharger la dernière release Windows depuis https://github.com/AssetRipper/AssetRipper/releases (version supportant Unity 6000.x), extraire dans `C:/Tools/AssetRipper/`. Marquer le path exact dans `dofus-app/scripts/assetripper-config.json` :

```json
{ "exe_path": "C:/Tools/AssetRipper/AssetRipper.GUI.Free.exe" }
```

- [ ] **Step 5: Localiser les fichiers Dofus**

```bash
ls "$DOFUS_INSTALL_PATH/Dofus_Data/StreamingAssets" "$DOFUS_INSTALL_PATH/GameAssembly.dll" "$DOFUS_INSTALL_PATH/Dofus_Data/boot.config"
```

Si `$DOFUS_INSTALL_PATH` n'est pas défini, demander au user où Dofus est installé (typiquement `C:/Users/<user>/AppData/Local/Ankama/zaap/games/dofus-3-windows-x64/` ou similaire). Persister dans `dofus-app/scripts/dofus-paths.json` :

```json
{
  "install_root": "C:/Users/Romann/AppData/Local/Ankama/zaap/games/dofus-3-windows-x64",
  "data_root": "C:/Users/Romann/AppData/Local/Ankama/zaap/games/dofus-3-windows-x64/Dofus_Data",
  "game_assembly_dll": "C:/Users/Romann/AppData/Local/Ankama/zaap/games/dofus-3-windows-x64/GameAssembly.dll",
  "managed_cpp2il_dir": "F:/FridaIL2CPPToolkit/dofus-app/data/cpp2il-output"
}
```

- [ ] **Step 6: Commit la config**

```bash
git add dofus-app/scripts/assetripper-config.json dofus-app/scripts/dofus-paths.json
git commit -m "$(cat <<'EOF'
chore(deobfusc): pin tool paths for multi-path sprint

AssetRipper exe path + Dofus install/data roots for J1 pipelines.
Cpp2IL output dir reused from prior sessions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: Schéma commun + helper `RenameEntry` (foundation pour les parsers)

**Files:**
- Create: `dofus-app/scripts/_rename_schema.py` — module utilitaire partagé par tous les parsers.

- [ ] **Step 1: Créer le module avec types et validateurs**

```python
#!/usr/bin/env python3
"""
Schéma commun pour les rename entries du sprint multi-path.
Tous les parsers J1-J3 émettent des objets RenameEntry homogènes.
Le merger final consomme ces objets.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Iterable, Literal

Confidence = Literal["high_unique", "high_runtime", "medium_xref", "low_struct_match"]
EvidenceSource = Literal[
    "assetripper", "dbi", "protodec", "filedescriptor_hook",
    "stringrefs", "existing_deobmap", "existing_proto_mapping"
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
    raw = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for r in raw:
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
```

- [ ] **Step 2: Run self-test**

Run: `python dofus-app/scripts/_rename_schema.py --self-test`
Expected: `OK _rename_schema._self_test`

- [ ] **Step 3: Commit**

```bash
git add dofus-app/scripts/_rename_schema.py
git commit -m "feat(deobfusc): RenameEntry schema partagé entre parsers J1-J3"
```

---

## Task 2: AssetRipper export + parser MonoBehaviours (J1.1)

**Files:**
- Create: `dofus-app/scripts/parse-assetripper-monobehaviours.py`
- Output: `dofus-app/data/external/assetripper-monobehaviours.json`

- [ ] **Step 1: Lancer AssetRipper sur les bundles Dofus**

Charger `dofus-app/scripts/dofus-paths.json` pour le `data_root`. Lancer AssetRipper en CLI (la GUI Free supporte CLI via flag `--silent` ou via fichier batch). Si CLI non dispo dans cette version, lancer la GUI manuellement, exporter en mode "Export All Files" vers `dofus-app/data/external/assetripper-export/`, scripts off, resources YAML on.

```bash
mkdir -p dofus-app/data/external/assetripper-export
# Option A — CLI si dispo
"C:/Tools/AssetRipper/AssetRipper.GUI.Free.exe" --silent \
  --input "$DATA_ROOT/StreamingAssets" --input "$DATA_ROOT/Resources.assets" \
  --output dofus-app/data/external/assetripper-export

# Option B — GUI manuelle (fallback). Documenter dans le commit.
```

Expected: `dofus-app/data/external/assetripper-export/ExportedProject/Assets/MonoBehaviour/` contient des `.asset` YAML.

- [ ] **Step 2: Créer le parser**

```python
#!/usr/bin/env python3
"""
Parse AssetRipper YAML export → extract MonoBehaviour script names.

Unity sérialise les MonoBehaviour avec m_Script référençant un MonoScript
qui contient m_ClassName + m_Namespace en clair, indépendamment de
l'obfusc IL2CPP côté code.

Cross-ref avec l'index Cpp2IL pour mapper original_name → obf_name via
le Token IL2CPP (préservé entre obfusc et runtime).

Usage: python parse-assetripper-monobehaviours.py [--self-test]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _rename_schema import RenameEntry, write_entries

ROOT = Path(__file__).resolve().parents[2]
EXPORT_DIR = ROOT / "dofus-app" / "data" / "external" / "assetripper-export"
INDEX_CORE = ROOT / "dofus-app" / "data" / "indexed" / "core.classes.json"
INDEX_PROTOGAME = ROOT / "dofus-app" / "data" / "indexed" / "protocol-game.classes.json"
OUTPUT = ROOT / "dofus-app" / "data" / "external" / "assetripper-monobehaviours.json"

# MonoScript YAML reference dans les .asset Unity ressemble à :
#   m_Script: {fileID: 11500000, guid: <hex32>, type: 3}
#   --- !u!114 &<id>
#   MonoBehaviour:
#     m_Script: {fileID: ..., guid: ..., type: ...}
RE_MONOSCRIPT = re.compile(
    r"m_Script:\s*\{fileID:\s*(?P<fileid>-?\d+),\s*guid:\s*(?P<guid>[0-9a-fA-F]+)"
)
# MonoScript yaml content (in dumped MonoScript .meta or .asset) :
#   MonoScript:
#     m_Name: <name>
#     m_ClassName: <ClassName>
#     m_Namespace: <Namespace>
#     m_AssemblyName: <Assembly>.dll
RE_MS_CLASSNAME = re.compile(r"m_ClassName:\s*(?P<name>\S+)")
RE_MS_NAMESPACE = re.compile(r"m_Namespace:\s*(?P<ns>\S*)")
RE_MS_ASSEMBLY = re.compile(r"m_AssemblyName:\s*(?P<asm>\S+)")


def collect_monoscripts(export_dir: Path) -> dict[str, dict]:
    """Returns {guid: {class_name, namespace, assembly}}."""
    monoscripts: dict[str, dict] = {}
    candidates = list(export_dir.rglob("MonoScript/*.asset"))
    candidates += list(export_dir.rglob("*.asset"))
    seen = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if "m_ClassName" not in content:
            continue
        m_class = RE_MS_CLASSNAME.search(content)
        m_ns = RE_MS_NAMESPACE.search(content)
        m_asm = RE_MS_ASSEMBLY.search(content)
        if not m_class:
            continue
        meta_path = path.with_suffix(".asset.meta")
        guid = None
        if meta_path.exists():
            meta = meta_path.read_text(encoding="utf-8", errors="ignore")
            mg = re.search(r"guid:\s*([0-9a-fA-F]+)", meta)
            if mg:
                guid = mg.group(1)
        if guid is None:
            continue
        monoscripts[guid] = {
            "class_name": m_class.group("name").strip(),
            "namespace": (m_ns.group("ns").strip() if m_ns else ""),
            "assembly": (m_asm.group("asm").strip() if m_asm else ""),
        }
    return monoscripts


def collect_monobehaviour_refs(export_dir: Path) -> set[str]:
    """Returns set of guids referenced by any MonoBehaviour in scenes/prefabs."""
    refs: set[str] = set()
    for path in export_dir.rglob("*"):
        if path.suffix not in (".prefab", ".unity", ".asset"):
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for m in RE_MONOSCRIPT.finditer(content):
            refs.add(m.group("guid").lower())
    return refs


def load_cpp2il_classes() -> dict[str, dict]:
    """Index obf classes by their obf name → metadata."""
    out: dict[str, dict] = {}
    for index_path in (INDEX_CORE, INDEX_PROTOGAME):
        if not index_path.exists():
            continue
        data = json.loads(index_path.read_text(encoding="utf-8"))
        for class_name, meta in data.items():
            out[class_name] = meta
    return out


def is_obfuscated_name(name: str) -> bool:
    """Heuristic: OPS uses [a-z]+ alphabetic naming. Real names have
    capital letters or digits or are very long."""
    if not name:
        return False
    if any(c.isupper() or c.isdigit() for c in name):
        return False
    return 1 <= len(name) <= 4


def build_entries(monoscripts: dict, refs: set[str], cpp2il: dict) -> list[RenameEntry]:
    """For each MonoScript with a clean name referenced by a MonoBehaviour,
    we have an original_name. The obf_name is the Cpp2IL class with the
    same Token (if MonoScript metadata gives a token), else it's the
    MonoScript class_name itself if it ends up matching an obf class somehow.

    Conservative approach: emit entries only when class_name looks REAL
    (has caps/digits) AND we observe it being referenced by a MB.
    """
    entries: list[RenameEntry] = []
    for guid, ms in monoscripts.items():
        cn = ms["class_name"]
        ns = ms["namespace"]
        if not cn:
            continue
        if guid not in refs:
            # MonoScript exists but no MB references it. Still useful — it
            # means a script with this name is part of the build.
            confidence = "medium_xref"
        else:
            confidence = "high_unique"
        # We do NOT have direct obf→original mapping from AssetRipper.
        # The original_name is `cn` but obf_name is unknown unless we
        # cross-ref by name in cpp2il (when cn appears as a class there).
        # That happens when OPS preserves the class (e.g. [DoNotRename]).
        if cn in cpp2il:
            # Class exists in cpp2il under its real name → already not obfuscated
            entries.append(RenameEntry(
                obf_name=cn,
                original_name=cn,
                namespace=ns,
                confidence=confidence,
                evidence_source="assetripper",
                evidence_detail=f"guid={guid}, asm={ms['assembly']} (clear class)",
            ))
        else:
            # Class name is real but not present in cpp2il under this name
            # → it's been obfuscated. We don't know the obf_name yet.
            # Emit as a "REAL_NAME_AVAILABLE" entry — the merger will try
            # to match against unmatched obf classes by structural similarity.
            entries.append(RenameEntry(
                obf_name=f"__UNKNOWN_OBF_FOR__{cn}",
                original_name=cn,
                namespace=ns,
                confidence="medium_xref",
                evidence_source="assetripper",
                evidence_detail=f"guid={guid}, asm={ms['assembly']} (obf unknown — cross-ref needed)",
            ))
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--export-dir", default=str(EXPORT_DIR))
    ap.add_argument("--output", default=str(OUTPUT))
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    export_dir = Path(args.export_dir)
    if not export_dir.exists():
        sys.exit(f"Export dir missing: {export_dir}")
    print(f"Scanning MonoScripts in {export_dir}...")
    monoscripts = collect_monoscripts(export_dir)
    print(f"  found {len(monoscripts)} MonoScripts with class names")
    refs = collect_monobehaviour_refs(export_dir)
    print(f"  found {len(refs)} distinct MB script refs")
    cpp2il = load_cpp2il_classes()
    print(f"  cpp2il index has {len(cpp2il)} classes")
    entries = build_entries(monoscripts, refs, cpp2il)
    print(f"  emitted {len(entries)} RenameEntry rows")
    n = write_entries(entries, Path(args.output))
    print(f"Wrote {n} rows to {args.output}")


def _self_test():
    # Synthetic input
    monoscripts = {
        "abc123": {"class_name": "MapView", "namespace": "Core.UI", "assembly": "Core.dll"},
        "def456": {"class_name": "egq", "namespace": "", "assembly": "Core.dll"},  # already obf
    }
    refs = {"abc123"}
    cpp2il = {"egq": {"label": "HAAPI client"}}
    entries = build_entries(monoscripts, refs, cpp2il)
    # MapView is real + referenced → emitted with __UNKNOWN_OBF_FOR__
    # egq is in cpp2il already → emitted as clear class
    # Wait: 'egq' is also in monoscripts but NOT in refs.
    found_mapview = [e for e in entries if e.original_name == "MapView"]
    found_egq = [e for e in entries if e.original_name == "egq"]
    assert len(found_mapview) == 1
    assert found_mapview[0].obf_name.startswith("__UNKNOWN_OBF_FOR__")
    assert found_mapview[0].confidence == "high_unique"
    assert len(found_egq) == 1
    assert found_egq[0].obf_name == "egq"
    print("OK parse-assetripper-monobehaviours._self_test")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run self-test**

Run: `python dofus-app/scripts/parse-assetripper-monobehaviours.py --self-test`
Expected: `OK parse-assetripper-monobehaviours._self_test`

- [ ] **Step 4: Run sur l'export réel**

Run: `python dofus-app/scripts/parse-assetripper-monobehaviours.py`
Expected: print `Wrote N rows to dofus-app/data/external/assetripper-monobehaviours.json` avec N > 50 (sinon l'export AssetRipper a échoué ou Dofus utilise pas de MonoBehaviours sérialisés — voir Section 1.4 critère go/no-go).

- [ ] **Step 5: Commit**

```bash
git add dofus-app/scripts/parse-assetripper-monobehaviours.py dofus-app/data/external/assetripper-monobehaviours.json
git commit -m "$(cat <<'EOF'
feat(deobfusc): J1.1 AssetRipper MonoBehaviour parser

Parse AssetRipper YAML export, cross-ref with Cpp2IL index. Emits
RenameEntry rows for clear class names found via MonoScript references.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: DBI/DDC clone + parser des mappings (J1.2)

**Files:**
- Create: `dofus-app/scripts/parse-dbi-tables.py`
- Output: `dofus-app/data/external/dbi-name-table.json`
- Clone target: `dofus-app/data/external/dbi/{DDC,DBI.Plugins,DBI.Api}/`

- [ ] **Step 1: Cloner les repos DBI**

```bash
mkdir -p dofus-app/data/external/dbi
cd dofus-app/data/external/dbi
git clone --depth 1 https://github.com/Dofus-Batteries-Included/DDC
git clone --depth 1 https://github.com/Dofus-Batteries-Included/DBI.Plugins
git clone --depth 1 https://github.com/Dofus-Batteries-Included/DBI.Api
cd /f/FridaIL2CPPToolkit
```

Expected: 3 sous-dossiers présents.

- [ ] **Step 2: Lire le build-guid local**

```bash
grep build-guid "$(cat dofus-app/scripts/dofus-paths.json | python -c "import json,sys;print(json.load(sys.stdin)['data_root'])")/boot.config"
```

Expected: ligne `build-guid=<hex>`. Noter la valeur.

- [ ] **Step 3: Inspecter la structure DBI pour trouver les mappings**

```bash
find dofus-app/data/external/dbi -name "*.csv" -o -name "*.json" -o -name "*name*" -o -name "*mapping*" 2>/dev/null | head -50
find dofus-app/data/external/dbi -name "*.dll" 2>/dev/null | head -20
```

Expected: identifier où sont stockés les mappings. Cas typiques :
- `data/<build-guid>/types.json` ou similaire dans DDC
- Interop assemblies dans `*.Generated.*.dll` 

Si format imprévu, ajuster le parser de l'étape 4.

- [ ] **Step 4: Créer le parser**

```python
#!/usr/bin/env python3
"""
Parse les mappings de Dofus-Batteries-Included (DBI/DDC) → RenameEntry rows.

DBI publie des "interop assemblies" générées par build-guid Dofus 3.
Les mappings obf → friendly se trouvent typiquement dans :
- des fichiers JSON/CSV de data versionnés par build-guid, OU
- les types des DLL générées (extraits via ilspycmd)

Ce parser supporte les deux formes via heuristiques.

Usage: python parse-dbi-tables.py [--build-guid <hex>] [--self-test]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _rename_schema import RenameEntry, write_entries

ROOT = Path(__file__).resolve().parents[2]
DBI_ROOT = ROOT / "dofus-app" / "data" / "external" / "dbi"
OUTPUT = ROOT / "dofus-app" / "data" / "external" / "dbi-name-table.json"

# Heuristique : un mapping `obf → friendly` est vu typiquement comme
# une ligne CSV / JSON avec deux strings où l'une matche [a-z]+ de
# longueur ≤ 4 et l'autre a des Capitales/digits.
RE_OBF_TOKEN = re.compile(r"^[a-z]{1,4}$")


def looks_like_obf(s: str) -> bool:
    return bool(RE_OBF_TOKEN.match(s))


def looks_like_real_name(s: str) -> bool:
    return any(c.isupper() for c in s) and len(s) >= 4


def scan_csv_files(dbi_root: Path) -> list[tuple[str, str, str]]:
    """Return list of (obf, real, source_path)."""
    out = []
    for csv_path in dbi_root.rglob("*.csv"):
        try:
            with csv_path.open(encoding="utf-8", errors="ignore") as f:
                reader = csv.reader(f)
                for row in reader:
                    if len(row) < 2:
                        continue
                    a, b = row[0].strip(), row[1].strip()
                    if looks_like_obf(a) and looks_like_real_name(b):
                        out.append((a, b, str(csv_path.relative_to(dbi_root))))
                    elif looks_like_obf(b) and looks_like_real_name(a):
                        out.append((b, a, str(csv_path.relative_to(dbi_root))))
        except Exception:
            continue
    return out


def scan_json_files(dbi_root: Path) -> list[tuple[str, str, str]]:
    """JSON mappings can be {obf: real, ...} dicts or arrays."""
    out = []
    for json_path in dbi_root.rglob("*.json"):
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        rel = str(json_path.relative_to(dbi_root))
        if isinstance(data, dict):
            for k, v in data.items():
                if not isinstance(v, str):
                    continue
                if looks_like_obf(k) and looks_like_real_name(v):
                    out.append((k, v, rel))
                elif looks_like_obf(v) and looks_like_real_name(k):
                    out.append((v, k, rel))
        elif isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                obf = item.get("obf") or item.get("obfuscated") or item.get("alias")
                real = item.get("name") or item.get("real") or item.get("original")
                if obf and real and looks_like_obf(obf) and looks_like_real_name(real):
                    out.append((obf, real, rel))
    return out


def filter_by_build_guid(triples: list[tuple[str, str, str]], build_guid: str | None) -> list[tuple[str, str, str, str]]:
    """Returns (obf, real, source, confidence). If source path contains
    our build_guid → high; if contains a different guid → medium; if no
    guid in path → medium."""
    out = []
    for obf, real, src in triples:
        if build_guid and build_guid in src:
            conf = "high_unique"
        else:
            conf = "medium_xref"
        out.append((obf, real, src, conf))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--build-guid", default=None)
    ap.add_argument("--dbi-root", default=str(DBI_ROOT))
    ap.add_argument("--output", default=str(OUTPUT))
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    dbi_root = Path(args.dbi_root)
    if not dbi_root.exists():
        sys.exit(f"DBI root missing: {dbi_root}")
    print(f"Scanning DBI under {dbi_root}...")
    triples = []
    triples += scan_csv_files(dbi_root)
    triples += scan_json_files(dbi_root)
    print(f"  scanned: {len(triples)} candidate (obf,real) pairs")
    quads = filter_by_build_guid(triples, args.build_guid)
    seen = set()
    entries = []
    for obf, real, src, conf in quads:
        if obf in seen:
            continue
        seen.add(obf)
        entries.append(RenameEntry(
            obf_name=obf,
            original_name=real,
            namespace="",
            confidence=conf,
            evidence_source="dbi",
            evidence_detail=src,
        ))
    print(f"  emitted {len(entries)} RenameEntry rows")
    n = write_entries(entries, Path(args.output))
    print(f"Wrote {n} rows to {args.output}")


def _self_test():
    # CSV-like and JSON-like synthetic data
    triples = [
        ("egq", "HaapiClient", "v1/types.csv"),
        ("eat", "CartographyView", "data/random.csv"),
    ]
    quads = filter_by_build_guid(triples, "v1")
    assert quads[0][3] == "high_unique"  # build-guid match
    assert quads[1][3] == "medium_xref"
    quads2 = filter_by_build_guid(triples, None)
    assert all(q[3] == "medium_xref" for q in quads2)
    assert looks_like_obf("egq")
    assert not looks_like_obf("HaapiClient")
    assert looks_like_real_name("HaapiClient")
    assert not looks_like_real_name("egq")
    print("OK parse-dbi-tables._self_test")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run self-test**

Run: `python dofus-app/scripts/parse-dbi-tables.py --self-test`
Expected: `OK parse-dbi-tables._self_test`

- [ ] **Step 6: Run sur les repos clonés avec le build-guid**

```bash
BUILD_GUID=$(grep build-guid "$(python -c 'import json;print(json.load(open("dofus-app/scripts/dofus-paths.json"))["data_root"])')/boot.config" | cut -d= -f2 | tr -d '\r\n')
python dofus-app/scripts/parse-dbi-tables.py --build-guid "$BUILD_GUID"
```

Expected: `Wrote N rows` avec N > 0. Si N == 0, le format DBI a évolué. Inspecter manuellement avec :

```bash
find dofus-app/data/external/dbi -type f \( -name "*.json" -o -name "*.csv" \) | xargs -I{} sh -c 'echo === {} ===; head -20 {}' | head -200
```

Adapter `scan_json_files`/`scan_csv_files` aux formats observés et re-lancer. **Ne pas commiter avant N > 0** (ou marquer explicitement N=0 dans le commit message si DBI ne contient pas de mapping et accepter la perte sur cette source).

- [ ] **Step 7: Commit**

```bash
git add dofus-app/scripts/parse-dbi-tables.py dofus-app/data/external/dbi-name-table.json dofus-app/data/external/dbi/
# (le clone ajoute potentiellement du volume — git n'inclura pas .git des sous-modules clonés en --depth 1 par défaut, vérifier .gitignore)
git commit -m "$(cat <<'EOF'
feat(deobfusc): J1.2 DBI/DDC mappings parser

Clone DDC/DBI.Plugins/DBI.Api, scan CSV+JSON for obf↔friendly pairs,
filter by build-guid for confidence weighting.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: protodec --il2cpp + cross-check (J1.3)

**Files:**
- Create: `dofus-app/scripts/run-protodec.py`
- Output: `dofus-app/data/external/protodec-schema/*.proto` + `dofus-app/data/external/protodec-cross-check.json`

- [ ] **Step 1: Vérifier qu'on a le dump Cpp2IL avec Protocol.Game.dll**

```bash
ls $(python -c "import json;print(json.load(open('dofus-app/scripts/dofus-paths.json'))['managed_cpp2il_dir'])")/Protocol.Game.dll
```

Expected: fichier existe (généré en sessions 4-5).

- [ ] **Step 2: Créer le script wrapper**

```python
#!/usr/bin/env python3
"""
Run protodec --il2cpp on Protocol.Game.dll → rebuilt .proto schemas.

Diff vs proto-schema-decompiled.json (notre schema actuel) pour
confirmer/invalider les 27 high-conf de Voie A et trouver des noms
de messages éventuellement préservés que nous n'avions pas captés.

Usage: python run-protodec.py [--self-test]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _rename_schema import RenameEntry, write_entries

ROOT = Path(__file__).resolve().parents[2]
OUT_PROTO_DIR = ROOT / "dofus-app" / "data" / "external" / "protodec-schema"
OUT_CROSSCHECK = ROOT / "dofus-app" / "data" / "external" / "protodec-cross-check.json"
EXISTING_SCHEMA = ROOT / "dofus-app" / "data" / "proto-schema-decompiled.json"
RENAME_OUTPUT = ROOT / "dofus-app" / "data" / "external" / "protodec-rename.json"

RE_PROTO_MESSAGE = re.compile(r"^\s*message\s+([A-Za-z_][A-Za-z0-9_]*)", re.M)
RE_PROTO_FIELD = re.compile(
    r"^\s*(?:repeated\s+)?(\S+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;",
    re.M,
)


def run_protodec(dll_path: Path, out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["protodec", "--il2cpp", str(dll_path), str(out_dir)]
    print(f"$ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout)
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
    return res.returncode


def parse_proto_files(proto_dir: Path) -> dict[str, list[tuple[str, str, int]]]:
    """Returns {message_name: [(field_type, field_name, tag), ...]}."""
    out = {}
    for proto in proto_dir.rglob("*.proto"):
        text = proto.read_text(encoding="utf-8", errors="ignore")
        for msg_match in RE_PROTO_MESSAGE.finditer(text):
            msg_name = msg_match.group(1)
            # field scan in the block following the message header
            start = msg_match.end()
            depth = 0
            i = start
            while i < len(text):
                ch = text[i]
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth <= 0:
                        break
                i += 1
            block = text[start:i]
            fields = [
                (m.group(1), m.group(2), int(m.group(3)))
                for m in RE_PROTO_FIELD.finditer(block)
            ]
            out[msg_name] = fields
    return out


def diff_against_existing(rebuilt: dict, existing_json: Path) -> dict:
    """Return diff stats: matched_by_signature, names_recovered, conflicts."""
    if not existing_json.exists():
        return {"matched": 0, "names_recovered": 0, "note": "no existing schema"}
    existing = json.loads(existing_json.read_text(encoding="utf-8"))
    # existing is {obf_msg: {fields: [{tag, type}, ...], ...}}
    matched_by_sig = 0
    names_recovered: list[tuple[str, str]] = []  # (obf, real)
    # Build sig index for rebuilt
    rebuilt_sigs: dict[tuple, str] = {}
    for name, fields in rebuilt.items():
        sig = tuple(sorted((tag, ftype) for ftype, _fname, tag in fields))
        if sig in rebuilt_sigs:
            rebuilt_sigs[sig] = "AMBIGUOUS"
        else:
            rebuilt_sigs[sig] = name
    # Match against existing
    for obf, meta in existing.items():
        if not isinstance(meta, dict) or "fields" not in meta:
            continue
        fields = meta["fields"]
        sig = tuple(sorted((f.get("tag", 0), f.get("type", "")) for f in fields))
        if sig in rebuilt_sigs and rebuilt_sigs[sig] != "AMBIGUOUS":
            matched_by_sig += 1
            real = rebuilt_sigs[sig]
            if real != obf:  # name actually recovered
                names_recovered.append((obf, real))
    return {
        "matched": matched_by_sig,
        "names_recovered_count": len(names_recovered),
        "names_recovered_sample": names_recovered[:50],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--dll", default=None, help="Path to Protocol.Game.dll")
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    if not args.dll:
        paths = json.loads((ROOT / "dofus-app" / "scripts" / "dofus-paths.json").read_text())
        args.dll = str(Path(paths["managed_cpp2il_dir"]) / "Protocol.Game.dll")
    dll_path = Path(args.dll)
    rc = run_protodec(dll_path, OUT_PROTO_DIR)
    if rc != 0:
        sys.exit(f"protodec failed with rc={rc}")
    rebuilt = parse_proto_files(OUT_PROTO_DIR)
    print(f"protodec rebuilt {len(rebuilt)} messages")
    diff = diff_against_existing(rebuilt, EXISTING_SCHEMA)
    OUT_CROSSCHECK.write_text(json.dumps(diff, indent=2), encoding="utf-8")
    print(f"Wrote diff to {OUT_CROSSCHECK}")
    print(f"  matched_by_sig: {diff['matched']}")
    print(f"  names_recovered: {diff['names_recovered_count']}")
    # Emit RenameEntry rows for recovered names
    entries = [
        RenameEntry(
            obf_name=obf,
            original_name=real,
            namespace="",
            confidence="high_unique",
            evidence_source="protodec",
            evidence_detail=f"sig-match against protodec output",
        )
        for obf, real in diff.get("names_recovered_sample", [])
    ]
    write_entries(entries, RENAME_OUTPUT)
    print(f"Wrote {len(entries)} rename entries to {RENAME_OUTPUT}")


def _self_test():
    # synthetic .proto block parsing
    text = """
    message Foo {
      int32 a = 1;
      string b = 2;
      repeated Bar c = 3;
    }
    message Bar {
      bool d = 1;
    }
    """
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "x.proto"
        p.write_text(text)
        out = parse_proto_files(Path(td))
    assert "Foo" in out
    assert ("int32", "a", 1) in out["Foo"]
    assert ("string", "b", 2) in out["Foo"]
    assert ("Bar", "c", 3) in out["Foo"]
    assert "Bar" in out
    print("OK run-protodec._self_test")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run self-test**

Run: `python dofus-app/scripts/run-protodec.py --self-test`
Expected: `OK run-protodec._self_test`

- [ ] **Step 4: Run sur le DLL Protocol.Game**

Run: `python dofus-app/scripts/run-protodec.py`
Expected: `protodec rebuilt N messages` avec N > 100, puis stats matched/names_recovered. Si N est très bas (<10) → protodec n'a pas géré le format, log les erreurs et noter pour J3 sans bloquer J1.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/scripts/run-protodec.py dofus-app/data/external/protodec-schema/ dofus-app/data/external/protodec-cross-check.json dofus-app/data/external/protodec-rename.json
git commit -m "$(cat <<'EOF'
feat(deobfusc): J1.3 protodec --il2cpp cross-check

Run protodec on Protocol.Game.dll, parse rebuilt .proto, diff against
proto-schema-decompiled.json. Emits RenameEntry rows for messages whose
sig matches an existing obf message under a different name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Premier merge fin J1 (validation pipeline + critère go/no-go)

**Files:**
- Create: `dofus-app/scripts/merge-rename-table.py` (v1, sera étendu en Task 13)
- Output: `dofus-app/data/indexed/frida-rename-table.json` (nouvelle version) + `dofus-app/data/indexed/merge-conflicts.md`

- [ ] **Step 1: Créer le merger v1 (consomme J1 outputs uniquement)**

```python
#!/usr/bin/env python3
"""
Merge orchestrator for the multi-path deobfusc sprint.

Consumes RenameEntry JSONs from each parser (J1.1, J1.2, J1.3, then J2,
J3) and produces a unified frida-rename-table.json v2.

Conflict policy: do NOT silently overwrite. If two sources name the same
obf differently, aggregate into name_candidates[] and log to
merge-conflicts.md.

Confidence aggregation: 2+ sources concordant → bump to high_unique.

Existing rename-table fields (RVA, FieldOffset, Token, parents) are
PRESERVED — this script only updates label/original_name/confidence/
evidence_source.

Usage: python merge-rename-table.py [--self-test] [--phase 1|2|final]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _rename_schema import RenameEntry, read_entries

ROOT = Path(__file__).resolve().parents[2]
DATA_INDEXED = ROOT / "dofus-app" / "data" / "indexed"
DATA_EXTERNAL = ROOT / "dofus-app" / "data" / "external"
DATA_RUNTIME = ROOT / "dofus-app" / "data" / "runtime"

# Source file paths per phase
J1_SOURCES = [
    DATA_EXTERNAL / "assetripper-monobehaviours.json",
    DATA_EXTERNAL / "dbi-name-table.json",
    DATA_EXTERNAL / "protodec-rename.json",
]
J2_SOURCES = [
    DATA_RUNTIME / "filedescriptor-init-rename.json",
]
J3_SOURCES = [
    DATA_INDEXED / "string-refs-rename.json",
]
EXISTING_TABLE = DATA_INDEXED / "frida-rename-table.json"
OUTPUT_TABLE = DATA_INDEXED / "frida-rename-table.json"
CONFLICTS_LOG = DATA_INDEXED / "merge-conflicts.md"


CONFIDENCE_RANK = {
    "low_struct_match": 0,
    "medium_xref": 1,
    "high_runtime": 2,
    "high_unique": 3,
}


def load_existing_table() -> dict:
    if not EXISTING_TABLE.exists():
        return {"classes": {}, "methods": {}, "references": {}}
    return json.loads(EXISTING_TABLE.read_text(encoding="utf-8"))


def collect_entries(phase: str) -> list[RenameEntry]:
    sources = []
    if phase in ("1", "2", "final"):
        sources += J1_SOURCES
    if phase in ("2", "final"):
        sources += J2_SOURCES
    if phase == "final":
        sources += J3_SOURCES
    out = []
    for src in sources:
        rows = read_entries(src)
        print(f"  read {len(rows):>5} rows from {src.name}")
        out += rows
    return out


def aggregate(entries: list[RenameEntry]) -> tuple[dict, list[dict]]:
    """Returns (aggregated_by_obf, conflicts)."""
    by_obf: dict[str, list[RenameEntry]] = defaultdict(list)
    for e in entries:
        if e.obf_name.startswith("__UNKNOWN_OBF_FOR__"):
            # No real mapping yet — skip for now (Task 13 will handle)
            continue
        by_obf[e.obf_name].append(e)
    aggregated = {}
    conflicts = []
    for obf, group in by_obf.items():
        names = {e.original_name for e in group}
        if len(names) == 1:
            best = max(group, key=lambda e: CONFIDENCE_RANK.get(e.confidence, 0))
            confidence = best.confidence
            if len(group) >= 2 and confidence != "high_unique":
                # Multi-source concord → bump
                confidence = "high_unique"
            aggregated[obf] = {
                "original_name": best.original_name,
                "namespace": best.namespace,
                "confidence": confidence,
                "evidence_sources": sorted({e.evidence_source for e in group}),
                "evidence_details": [e.evidence_detail for e in group],
            }
        else:
            # Conflict: 2+ sources disagree on the original name
            candidates = [
                {
                    "name": e.original_name,
                    "namespace": e.namespace,
                    "source": e.evidence_source,
                    "detail": e.evidence_detail,
                    "confidence": e.confidence,
                }
                for e in group
            ]
            aggregated[obf] = {
                "original_name": None,
                "name_candidates": candidates,
                "confidence": "low_struct_match",
                "evidence_sources": sorted({e.evidence_source for e in group}),
            }
            conflicts.append({"obf": obf, "candidates": candidates})
    return aggregated, conflicts


def write_conflicts_md(conflicts: list[dict], path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Merge conflicts (`merge-rename-table.py`)",
        "",
        f"Total conflicts: **{len(conflicts)}**",
        "",
    ]
    for c in conflicts:
        lines.append(f"## `{c['obf']}`")
        for cand in c["candidates"]:
            lines.append(
                f"- **{cand['name']}** "
                f"(ns=`{cand['namespace']}`, source=`{cand['source']}`, "
                f"conf=`{cand['confidence']}`) — {cand['detail']}"
            )
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def merge_into_table(aggregated: dict, table: dict) -> dict:
    classes = table.get("classes", {})
    for obf, info in aggregated.items():
        existing = classes.get(obf, {})
        # Preserve RVA/FieldOffset/parents/etc, only update label/orig_name
        existing["label"] = info.get("original_name") or existing.get("label", obf)
        existing["original_name"] = info.get("original_name")
        existing["namespace"] = info.get("namespace") or existing.get("namespace", "")
        existing["deobfusc_confidence"] = info.get("confidence", "low_struct_match")
        existing["deobfusc_sources"] = info.get("evidence_sources", [])
        if "name_candidates" in info:
            existing["name_candidates"] = info["name_candidates"]
        classes[obf] = existing
    table["classes"] = classes
    return table


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--phase", choices=["1", "2", "final"], default="final")
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    print(f"Merge phase: {args.phase}")
    entries = collect_entries(args.phase)
    print(f"Total RenameEntry rows: {len(entries)}")
    aggregated, conflicts = aggregate(entries)
    print(f"Aggregated: {len(aggregated)} unique obf names")
    print(f"Conflicts:  {len(conflicts)}")
    table = load_existing_table()
    table = merge_into_table(aggregated, table)
    OUTPUT_TABLE.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUTPUT_TABLE}")
    write_conflicts_md(conflicts, CONFLICTS_LOG)
    print(f"Wrote {CONFLICTS_LOG}")


def _self_test():
    e1 = RenameEntry("egq", "HaapiClient", "", "high_unique", "dbi", "v0.11.30")
    e2 = RenameEntry("egq", "HaapiClient", "Ankama.Haapi", "medium_xref", "assetripper", "guid=abc")
    e3 = RenameEntry("eat", "CartographyView", "", "medium_xref", "dbi", "")
    e4 = RenameEntry("eat", "MapView", "", "medium_xref", "assetripper", "")
    agg, conflicts = aggregate([e1, e2, e3, e4])
    assert "egq" in agg
    assert agg["egq"]["original_name"] == "HaapiClient"
    assert agg["egq"]["confidence"] == "high_unique"
    assert "eat" in agg
    assert agg["eat"]["original_name"] is None
    assert len(agg["eat"]["name_candidates"]) == 2
    assert len(conflicts) == 1
    print("OK merge-rename-table._self_test")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run self-test**

Run: `python dofus-app/scripts/merge-rename-table.py --self-test`
Expected: `OK merge-rename-table._self_test`

- [ ] **Step 3: Run phase 1**

Run: `python dofus-app/scripts/merge-rename-table.py --phase 1`
Expected: `Total RenameEntry rows: N` avec N > 50 idéalement.

- [ ] **Step 4: Métriques fin J1 + critère go/no-go**

Lire `dofus-app/data/indexed/frida-rename-table.json` et compter les classes avec `deobfusc_confidence in ("high_unique", "high_runtime")` :

```bash
python -c "
import json
t = json.load(open('dofus-app/data/indexed/frida-rename-table.json'))
classes = t.get('classes', {})
high = sum(1 for c in classes.values() if c.get('deobfusc_confidence') == 'high_unique')
medium = sum(1 for c in classes.values() if c.get('deobfusc_confidence') == 'medium_xref')
print(f'high_unique: {high}, medium_xref: {medium}')
"
```

**Critère go/no-go fin J1** :
- Si `high_unique + medium_xref` ≥ +50 net vs avant sprint (~110 baseline) → continuer J2 normalement.
- Si < +50 → l'hypothèse "AssetRipper donne des MonoBehaviours" et/ou "DBI a des mappings exploitables" était fausse. Replanifier J3 pour faire stringrefs sur la journée entière au lieu de matin seulement (note dans le doc de session 8).

- [ ] **Step 5: Commit fin J1**

```bash
git add dofus-app/scripts/merge-rename-table.py dofus-app/data/indexed/frida-rename-table.json dofus-app/data/indexed/merge-conflicts.md
git commit -m "$(cat <<'EOF'
feat(deobfusc): J1 merge — phase 1 (AssetRipper + DBI + protodec)

Orchestrator merger consumes per-source RenameEntry JSONs, aggregates
with conflict logging, preserves existing RVA/FieldOffset/parents.
This commit closes Day 1 of the multi-path sprint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Localisation OFFLINE des FileDescriptor init RVAs (J2.1, no risk)

**Files:**
- Create: `dofus-app/scripts/find-filedescriptor-init-rvas.py`
- Output: `dofus-app/data/runtime/filedescriptor-init-candidates.json`

- [ ] **Step 1: Créer le scanner d'index Cpp2IL**

```python
#!/usr/bin/env python3
"""
Localiser les méthodes init de FileDescriptor dans le dump Cpp2IL.

Hypothèse : OPS strippe les byte[] static FileDescriptor mais préserve
les méthodes static .cctor/init de chaque classe Protobuf-generated qui
prennent un byte[] en argument et le passent à MessageDescriptor.BuildAllFrom
(ou équivalent obfusqué). Hooker ces RVA précises permet de capturer le
descriptor brut au boot.

Stratégie A : XRefs offline depuis l'index Cpp2IL des classes
Protobuf-generated. Filtrer les méthodes par signature `(byte[]) → ...`
et présence dans body de tokens `Reflection.FileDescriptor` /
`MessageDescriptor.BuildAllFrom` / `FileDescriptorProto.Parser.ParseFrom`.

Output: liste de RVA candidats avec class_obf_name, method_obf_name,
evidence pour chaque.

Usage: python find-filedescriptor-init-rvas.py [--self-test]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[2]
INDEX_PROTOGAME = ROOT / "dofus-app" / "data" / "indexed" / "protocol-game.classes.json"
INDEX_CORE = ROOT / "dofus-app" / "data" / "indexed" / "core.classes.json"
DECOMPILED_DIR_DEFAULT = ROOT / "dofus-app" / "data" / "cpp2il-output" / "decompiled" / "Protocol.Game"
OUTPUT = ROOT / "dofus-app" / "data" / "runtime" / "filedescriptor-init-candidates.json"

# Patterns dans les bodies décompilés
RE_FILEDESC_TOKENS = re.compile(
    r"FileDescriptor|MessageDescriptor\.BuildAllFrom|"
    r"FileDescriptorProto\.Parser|Google\.Protobuf\.Reflection",
    re.I,
)

# Signature method "([] -> ?)" : prend un byte[] en premier param
RE_BYTE_ARRAY_PARAM = re.compile(r"byte\[\]")


def load_indexed_classes() -> dict:
    """Returns dict of {fully_qualified_class: meta} from cpp2il index."""
    out = {}
    for idx in (INDEX_PROTOGAME, INDEX_CORE):
        if idx.exists():
            data = json.loads(idx.read_text(encoding="utf-8"))
            out.update(data)
    return out


def find_candidates_from_index(classes: dict) -> list[dict]:
    """Score 1 : classes Protobuf-generated qui ont une méthode static
    avec (byte[]) -> ? + body référençant Reflection.FileDescriptor."""
    out = []
    for class_name, meta in classes.items():
        if not meta.get("is_protoc_generated"):
            continue
        methods = meta.get("methods", [])
        for m in methods:
            params = m.get("params", "") or m.get("signature", "")
            if not RE_BYTE_ARRAY_PARAM.search(params):
                continue
            body = m.get("body_excerpt", "") or ""
            score = 0
            evidence = []
            if RE_FILEDESC_TOKENS.search(body):
                score += 3
                evidence.append("body_token_match")
            if "static" in (m.get("modifiers", "") or ""):
                score += 1
                evidence.append("static")
            if score >= 2:
                out.append({
                    "class_obf_name": class_name,
                    "method_obf_name": m.get("name"),
                    "rva": m.get("rva"),
                    "score": score,
                    "evidence": evidence,
                    "param_signature": params,
                })
    return out


def find_candidates_from_decompiled(decomp_dir: Path) -> list[dict]:
    """Strategy fallback : scan .cs files for methods that take byte[]
    AND reference FileDescriptor in body. Useful if the index doesn't
    carry body_excerpt."""
    out = []
    if not decomp_dir.exists():
        return out
    for cs_path in decomp_dir.rglob("*.cs"):
        text = cs_path.read_text(encoding="utf-8", errors="ignore")
        if not RE_FILEDESC_TOKENS.search(text):
            continue
        # heuristique : grep pour "static <ret> <name>(byte[]" ou similar
        for m in re.finditer(
            r"\[Address\(RVA\s*=\s*\"(0x[0-9A-Fa-f]+)\"[^\]]*\)\][^\n]*\n[^\n]*static[^\n]*\((?:[^)]*?)byte\s*\[\s*\]",
            text,
        ):
            rva = m.group(1)
            out.append({
                "class_obf_name": cs_path.stem,
                "method_obf_name": "?",
                "rva": rva,
                "score": 2,
                "evidence": ["decompiled_grep"],
                "param_signature": "byte[] (matched by regex)",
            })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--decompiled-dir", default=str(DECOMPILED_DIR_DEFAULT))
    ap.add_argument("--output", default=str(OUTPUT))
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    classes = load_indexed_classes()
    print(f"Loaded {len(classes)} indexed classes")
    candidates = find_candidates_from_index(classes)
    print(f"Strategy A (index): {len(candidates)} candidates")
    if len(candidates) < 50:
        print("Trying Strategy B (decompiled .cs grep)...")
        more = find_candidates_from_decompiled(Path(args.decompiled_dir))
        print(f"Strategy B: {len(more)} additional candidates")
        # Dedup by (class_obf_name, method_obf_name)
        seen = {(c["class_obf_name"], c["method_obf_name"]) for c in candidates}
        for m in more:
            key = (m["class_obf_name"], m["method_obf_name"])
            if key not in seen:
                candidates.append(m)
                seen.add(key)
    candidates.sort(key=lambda c: (-c["score"], c["class_obf_name"]))
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(candidates, indent=2), encoding="utf-8")
    print(f"Wrote {len(candidates)} candidates to {out_path}")
    if len(candidates) < 30:
        print("WARN: Less than 30 candidates. Stratégie A+B insuffisantes.")
        print("      Check index has 'is_protoc_generated' and 'body_excerpt' fields.")
        print("      May need to enrich index-cpp2il-attrs.py output, or fall back to natif x64 pattern scan.")


def _self_test():
    classes = {
        "Foo": {
            "is_protoc_generated": True,
            "methods": [
                {
                    "name": "init_descriptor",
                    "params": "byte[] data, int x",
                    "modifiers": "public static",
                    "rva": "0x12345",
                    "body_excerpt": "FileDescriptor.FromGeneratedCode(...)",
                },
                {
                    "name": "Bar",
                    "params": "int a",
                    "modifiers": "public",
                    "rva": "0x67890",
                    "body_excerpt": "",
                },
            ],
        },
        "Baz": {
            "is_protoc_generated": False,  # not protoc → skipped
            "methods": [
                {
                    "name": "x",
                    "params": "byte[] d",
                    "modifiers": "static",
                    "rva": "0xABCDE",
                    "body_excerpt": "FileDescriptor reference",
                },
            ],
        },
    }
    cands = find_candidates_from_index(classes)
    assert len(cands) == 1
    assert cands[0]["class_obf_name"] == "Foo"
    assert cands[0]["method_obf_name"] == "init_descriptor"
    assert cands[0]["rva"] == "0x12345"
    print("OK find-filedescriptor-init-rvas._self_test")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run self-test**

Run: `python dofus-app/scripts/find-filedescriptor-init-rvas.py --self-test`
Expected: `OK find-filedescriptor-init-rvas._self_test`

- [ ] **Step 3: Run sur l'index réel**

Run: `python dofus-app/scripts/find-filedescriptor-init-rvas.py`
Expected: `Wrote N candidates` avec N entre 50 et 200 idéalement (un par fichier .proto, on en a 99).

Si N est très bas (<10), l'index actuel ne porte pas `body_excerpt`. Vérifier :

```bash
python -c "
import json
data = json.load(open('dofus-app/data/indexed/protocol-game.classes.json'))
sample = next(iter(data.values()))
print('Sample class meta keys:', list(sample.keys()))
print('Sample method keys:', list(sample.get('methods', [{}])[0].keys()) if sample.get('methods') else 'no methods')
"
```

Si `body_excerpt` est absent → enrichir `index-cpp2il-attrs.py` pour l'ajouter (out of scope ce sprint, fallback B obligatoire). Sinon proceed.

- [ ] **Step 4: Commit**

```bash
git add dofus-app/scripts/find-filedescriptor-init-rvas.py dofus-app/data/runtime/filedescriptor-init-candidates.json
git commit -m "$(cat <<'EOF'
feat(deobfusc): J2.1 locate FileDescriptor init RVAs offline

Strategy A (Cpp2IL index XRefs) + B (decompiled .cs grep). Filters
protoc-generated classes with static (byte[]) → ? methods whose body
references Reflection.FileDescriptor / BuildAllFrom. Outputs candidates
sorted by score for atomic Frida hooks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Module Frida `proto-descriptor-capture.ts` (J2.2 partie 1)

**Files:**
- Create: `src/rpc-agent/proto-descriptor-capture.ts`
- Modify: `src/rpc-agent/rpc-methods.ts` (register the 3 new RPC methods)

- [ ] **Step 1: Lire la structure existante de rpc-methods**

Run: `head -50 src/rpc-agent/rpc-methods.ts`
Note l'import pattern et la registration syntax (déjà utilisée par sentry/gbe-router/datacenter modules).

- [ ] **Step 2: Créer le module**

```typescript
// FileDescriptor capture module — atomic RVA hooks, no intercept-all.
//
// For each candidate RVA from filedescriptor-init-candidates.json, install
// a Frida Interceptor that reads arg0 as an IL2CPP byte[] and dumps the
// raw bytes to a session buffer. The RPC `getCapturedDescriptors()` returns
// the buffer.
//
// Throttle: max 200 captures per session to prevent overhead. Each unique
// (class, method) is only captured once.
//
// Designed to be safe under gameplay — no per-call logging, no allocs in
// hot path.

import "frida-il2cpp-bridge";

interface CapturedDescriptor {
    class_obf_name: string;
    method_obf_name: string;
    rva: string;
    bytes_b64: string;
    captured_at_ms: number;
}

const buffer: CapturedDescriptor[] = [];
const seen = new Set<string>();
const installed: InvocationListener[] = [];
const MAX_CAPTURES = 200;

function readByteArrayIL2CPP(ptr: NativePointer): Uint8Array | null {
    // IL2CPP byte[] layout (System.Byte[]):
    //   ptr + 0x00 : Il2CppObject header (~0x10 bytes)
    //   ptr + 0x10 : array bounds pointer (or 0)
    //   ptr + 0x18 : max_length (uintptr_t)
    //   ptr + 0x20 : first byte
    if (ptr.isNull()) return null;
    try {
        const max_length = ptr.add(0x18).readUInt();
        if (max_length === 0 || max_length > 16 * 1024 * 1024) return null; // sanity
        const data = ptr.add(0x20).readByteArray(max_length);
        if (!data) return null;
        return new Uint8Array(data);
    } catch {
        return null;
    }
}

function bytesToB64(bytes: Uint8Array): string {
    // Frida supports Buffer/btoa equivalents via global atob/btoa? Use manual.
    let binary = "";
    const len = bytes.length;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    // Frida's `Buffer` global doesn't exist; use Memory.alloc + readUtf8?
    // Simpler: emit hex (parser side decodes hex → bytes)
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function installFileDescriptorCapture(candidatesJson: string): { installed: number; skipped: number } {
    const candidates: { class_obf_name: string; method_obf_name: string; rva: string }[] =
        JSON.parse(candidatesJson);
    const baseAddress = Module.findBaseAddress("GameAssembly.dll");
    if (!baseAddress) {
        throw new Error("GameAssembly.dll not loaded yet");
    }
    let n_installed = 0;
    let n_skipped = 0;
    for (const c of candidates) {
        if (!c.rva || c.rva === "0x0") {
            n_skipped++;
            continue;
        }
        const rvaInt = parseInt(c.rva, 16);
        const target = baseAddress.add(rvaInt);
        const key = `${c.class_obf_name}::${c.method_obf_name}`;
        try {
            const listener = Interceptor.attach(target, {
                onEnter(args) {
                    if (buffer.length >= MAX_CAPTURES) return;
                    if (seen.has(key)) return;
                    const bytePtr = args[0];
                    const bytes = readByteArrayIL2CPP(bytePtr);
                    if (!bytes || bytes.length < 8) return;
                    seen.add(key);
                    buffer.push({
                        class_obf_name: c.class_obf_name,
                        method_obf_name: c.method_obf_name,
                        rva: c.rva,
                        bytes_b64: bytesToB64(bytes),
                        captured_at_ms: Date.now(),
                    });
                },
            });
            installed.push(listener);
            n_installed++;
        } catch (e) {
            n_skipped++;
        }
    }
    return { installed: n_installed, skipped: n_skipped };
}

export function getCapturedDescriptors(): CapturedDescriptor[] {
    return [...buffer];
}

export function clearCapturedDescriptors(): { cleared: number } {
    const n = buffer.length;
    buffer.length = 0;
    seen.clear();
    return { cleared: n };
}

export function uninstallFileDescriptorCapture(): { uninstalled: number } {
    const n = installed.length;
    for (const l of installed) {
        try { l.detach(); } catch {}
    }
    installed.length = 0;
    return { uninstalled: n };
}
```

- [ ] **Step 3: Register dans rpc-methods.ts**

Lire `src/rpc-agent/rpc-methods.ts` pour voir la convention exacte. Probablement :

```typescript
import {
    installFileDescriptorCapture,
    getCapturedDescriptors,
    clearCapturedDescriptors,
    uninstallFileDescriptorCapture,
} from "./proto-descriptor-capture";

// ... ailleurs dans le mapping :
"installFileDescriptorCapture": installFileDescriptorCapture,
"getCapturedDescriptors": getCapturedDescriptors,
"clearCapturedDescriptors": clearCapturedDescriptors,
"uninstallFileDescriptorCapture": uninstallFileDescriptorCapture,
```

Adapter exactement à la syntaxe trouvée. Si rpc-methods utilise un decorator pattern ou un registry function, suivre la convention.

- [ ] **Step 4: Build le RPC bundle**

Run: `cd /f/FridaIL2CPPToolkit && npm run build:rpc`
Expected: build OK sans erreur TS.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/proto-descriptor-capture.ts src/rpc-agent/rpc-methods.ts
git commit -m "$(cat <<'EOF'
feat(rpc-agent): proto-descriptor-capture module

Atomic RVA hooks (no intercept-all) on candidate FileDescriptor init
methods. Reads IL2CPP byte[] arg0, dumps as hex with throttle (200/sess).
Avoids the session-2 intercept-all pattern that crashed the PC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Driver Node + capture session runtime (J2.2 partie 2)

**Files:**
- Create: `dofus-app/scripts/capture-proto-descriptors.js`
- Output: `dofus-app/data/runtime/protobuf-descriptors-captured.json`

- [ ] **Step 1: Lire un driver existant pour la convention**

Run: `head -60 dofus-app/scripts/dump-gbe-router.js`
Note l'init Frida + le PORT=3001 pattern.

- [ ] **Step 2: Créer le driver**

```javascript
#!/usr/bin/env node
/*
 * Driver: install FileDescriptor capture → wait → dump → uninstall.
 *
 * Usage:
 *   PORT=3001 node dofus-app/scripts/capture-proto-descriptors.js
 *
 * The script:
 *   1. Loads filedescriptor-init-candidates.json
 *   2. Calls RPC `installFileDescriptorCapture(candidatesJson)` → reports installed count
 *   3. Prompts "Maintenant lance le client Dofus / login / charge une map.
 *      Appuie sur ENTER pour dumper et désinstaller."
 *   4. Calls `getCapturedDescriptors()` → writes to JSON
 *   5. Calls `uninstallFileDescriptorCapture()`
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..", "..");
const CANDIDATES = path.join(ROOT, "dofus-app", "data", "runtime", "filedescriptor-init-candidates.json");
const OUTPUT = path.join(ROOT, "dofus-app", "data", "runtime", "protobuf-descriptors-captured.json");
const PORT = process.env.PORT || "3001";

async function rpcCall(method, args = []) {
    const fetch = (await import("node-fetch")).default;
    const res = await fetch(`http://localhost:${PORT}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
    return await res.json();
}

function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (a) => { rl.close(); resolve(a); });
    });
}

async function main() {
    if (!fs.existsSync(CANDIDATES)) {
        console.error("Missing", CANDIDATES, "— run find-filedescriptor-init-rvas.py first");
        process.exit(1);
    }
    const candidatesJson = fs.readFileSync(CANDIDATES, "utf-8");
    console.log("Installing FileDescriptor capture hooks...");
    const installResult = await rpcCall("installFileDescriptorCapture", [candidatesJson]);
    console.log("Installed:", installResult);
    console.log("");
    console.log("✅ Hooks installés.");
    console.log("Lance Dofus.exe maintenant (ou si déjà lancé, login → charge une map).");
    console.log("Les FileDescriptor s'initialisent typiquement au login screen + 1er chargement.");
    console.log("");
    await prompt("Appuie ENTER quand le client a chargé pour dumper... ");
    console.log("Dumping captured descriptors...");
    const captured = await rpcCall("getCapturedDescriptors");
    console.log(`Captured: ${captured.length} descriptors`);
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(captured, null, 2));
    console.log("Wrote", OUTPUT);
    console.log("Uninstalling...");
    const unin = await rpcCall("uninstallFileDescriptorCapture");
    console.log("Uninstalled:", unin);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Vérifier `node-fetch` est dispo dans le repo**

Run: `cd /f/FridaIL2CPPToolkit && cat dofus-app/package.json | grep node-fetch`
Si absent, installer: `cd dofus-app && npm install node-fetch`

- [ ] **Step 4: Lancer Dofus + Frida + driver**

⚠️ Étape MANUELLE — l'agent ne peut pas attacher Frida tout seul.

```bash
# Terminal 1 — lancer Dofus.exe (zaap launcher ou direct)
# Terminal 2 — Frida + RPC agent
cd /f/FridaIL2CPPToolkit
PORT=3001 node dofus-app/dist-rpc/agent.js  # ou la commande standard du repo

# Terminal 3 — driver
PORT=3001 node dofus-app/scripts/capture-proto-descriptors.js
```

Pendant l'install, **ne pas continuer le gameplay agressivement**. Les hooks sont atomiques mais 99 hooks installés simultanément ajoutent de la latence au cold path Protobuf.

Après login + chargement de map → ENTER → dump.

- [ ] **Step 5: Vérifier output**

```bash
python -c "
import json
data = json.load(open('dofus-app/data/runtime/protobuf-descriptors-captured.json'))
print(f'Captured: {len(data)} descriptors')
for d in data[:5]:
    bytes_len = len(d['bytes_b64']) // 2
    print(f'  {d[\"class_obf_name\"]}::{d[\"method_obf_name\"]} → {bytes_len} bytes')
"
```

**Critère go/no-go fin J2** :
- ≥10 captures → ✅ succès, parser au Task 9.
- 1-9 → succès partiel, parser quand même + J3 stringrefs.
- 0 → OPS a probablement réécrit le pipeline Protobuf custom. Marquer dans le commit + J3 stringrefs sur la journée entière.

- [ ] **Step 6: Commit (avec output réel ou note d'échec)**

```bash
git add dofus-app/scripts/capture-proto-descriptors.js dofus-app/data/runtime/protobuf-descriptors-captured.json
git commit -m "$(cat <<'EOF'
feat(deobfusc): J2.2 driver + runtime capture session

Driver Node calls install → wait → dump → uninstall. Captured N
descriptors on this run (or 0 if hypothesis invalidated — see J3
fallback plan).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Parser des descriptors capturés → RenameEntry (J2.3)

**Files:**
- Create: `dofus-app/scripts/parse-captured-descriptors.py`
- Output: `dofus-app/data/runtime/filedescriptor-init-rename.json`

- [ ] **Step 1: Vérifier que la lib `protobuf` Python est dispo**

```bash
python -c "from google.protobuf.descriptor_pb2 import FileDescriptorProto; print('OK')"
```

Expected: `OK`. Si KO : `pip install protobuf`.

- [ ] **Step 2: Créer le parser**

```python
#!/usr/bin/env python3
"""
Parse les byte[] FileDescriptorProto capturés runtime → noms de messages.

Chaque entry de filedescriptor-init-rename.json est un dump hex d'un
FileDescriptorProto Google.Protobuf. On le re-parse via
google.protobuf.descriptor_pb2 et on extrait :
- file_name (.proto file name original — *si présent*)
- package (Ankama.Dofus.Protocol.Game.X)
- message_type[] avec name + field[].name + field[].number + field[].type

Cross-ref avec le caller obf class_name → on apprend que cette obf class
est cette message-name dans ce .proto-file. Pour les messages
imbriqués, on capture aussi.

Usage: python parse-captured-descriptors.py [--self-test]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _rename_schema import RenameEntry, write_entries

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "dofus-app" / "data" / "runtime" / "protobuf-descriptors-captured.json"
OUTPUT = ROOT / "dofus-app" / "data" / "runtime" / "filedescriptor-init-rename.json"
EXISTING_SCHEMA = ROOT / "dofus-app" / "data" / "proto-schema-decompiled.json"


def parse_one_descriptor(hex_str: str):
    """Returns (file_name, package, [(msg_name, [(field_name, tag, type)])])"""
    from google.protobuf.descriptor_pb2 import FileDescriptorProto
    raw = bytes.fromhex(hex_str)
    fdp = FileDescriptorProto()
    fdp.ParseFromString(raw)
    msgs = []
    for mt in fdp.message_type:
        fields = [(f.name, f.number, f.type) for f in mt.field]
        msgs.append((mt.name, fields))
    return fdp.name, fdp.package, msgs


def cross_ref_to_obf(captured: list, existing_schema: Path) -> list[RenameEntry]:
    """For each captured descriptor, the caller class_obf_name IS the
    obf name of the *first* (or top-level) message in this descriptor.
    Subsequent messages (nested or other) need to be matched by signature
    against existing_schema."""
    if not existing_schema.exists():
        existing = {}
    else:
        existing = json.loads(existing_schema.read_text(encoding="utf-8"))
    # Build sig index for existing schema (obf → sig)
    sig_to_obf: dict[tuple, str] = {}
    for obf, meta in existing.items():
        if not isinstance(meta, dict) or "fields" not in meta:
            continue
        sig = tuple(sorted((f.get("tag", 0), f.get("type", "")) for f in meta["fields"]))
        sig_to_obf.setdefault(sig, obf)  # first wins
    entries = []
    for cap in captured:
        try:
            file_name, package, msgs = parse_one_descriptor(cap["bytes_b64"])
        except Exception as e:
            print(f"WARN: failed parse {cap['class_obf_name']}: {e}", file=sys.stderr)
            continue
        # Top-level msgs[0] is typically the "file's main message"
        # but actually a FileDescriptor has many message_types. The caller
        # class is the message whose .cctor was hooked. We report the
        # caller class as the file_name's "first matching message".
        # Heuristic : prendre le message dont la sig matche la sig connue
        # de cap["class_obf_name"] dans existing.
        caller_obf = cap["class_obf_name"]
        caller_sig = None
        if caller_obf in existing and isinstance(existing[caller_obf], dict):
            fields = existing[caller_obf].get("fields", [])
            caller_sig = tuple(sorted((f.get("tag", 0), f.get("type", "")) for f in fields))
        # For each message in this descriptor, emit a rename entry
        for msg_name, fields in msgs:
            entry_sig = tuple(sorted((tag, ftype) for fname, tag, ftype in fields))
            # Find which obf has this sig
            obf_for_msg = sig_to_obf.get(entry_sig)
            if obf_for_msg is None and caller_sig is not None and entry_sig == caller_sig:
                obf_for_msg = caller_obf
            if obf_for_msg is None:
                continue  # can't map this message to a known obf
            entries.append(RenameEntry(
                obf_name=obf_for_msg,
                original_name=msg_name,
                namespace=package or "",
                confidence="high_runtime",
                evidence_source="filedescriptor_hook",
                evidence_detail=f"file={file_name}, captured via {caller_obf}",
            ))
    # Dedup by obf_name (keep highest confidence first)
    seen = set()
    out = []
    for e in entries:
        if e.obf_name in seen:
            continue
        seen.add(e.obf_name)
        out.append(e)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--input", default=str(INPUT))
    ap.add_argument("--output", default=str(OUTPUT))
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    inp = Path(args.input)
    if not inp.exists():
        sys.exit(f"Missing input: {inp}")
    captured = json.loads(inp.read_text(encoding="utf-8"))
    print(f"Loaded {len(captured)} captured descriptors")
    if len(captured) == 0:
        print("Nothing to parse. Writing empty output.")
        write_entries([], Path(args.output))
        return
    entries = cross_ref_to_obf(captured, EXISTING_SCHEMA)
    n = write_entries(entries, Path(args.output))
    print(f"Wrote {n} RenameEntry rows to {args.output}")


def _self_test():
    # Build a synthetic FileDescriptorProto bytes
    from google.protobuf.descriptor_pb2 import FileDescriptorProto, DescriptorProto, FieldDescriptorProto
    fdp = FileDescriptorProto()
    fdp.name = "test.proto"
    fdp.package = "Ankama.Test"
    msg = fdp.message_type.add()
    msg.name = "FooMessage"
    f1 = msg.field.add()
    f1.name = "id"; f1.number = 1; f1.type = FieldDescriptorProto.TYPE_INT32
    raw_hex = fdp.SerializeToString().hex()
    # Now parse it back
    name, pkg, msgs = parse_one_descriptor(raw_hex)
    assert name == "test.proto"
    assert pkg == "Ankama.Test"
    assert msgs[0][0] == "FooMessage"
    assert msgs[0][1][0] == ("id", 1, FieldDescriptorProto.TYPE_INT32)
    print("OK parse-captured-descriptors._self_test")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run self-test**

Run: `python dofus-app/scripts/parse-captured-descriptors.py --self-test`
Expected: `OK parse-captured-descriptors._self_test`

- [ ] **Step 4: Run sur les captures**

Run: `python dofus-app/scripts/parse-captured-descriptors.py`
Expected: `Wrote N RenameEntry rows` avec N = nombre de messages successfully matched. Si captured était 0, output sera 0 (cohérent avec critère go/no-go).

- [ ] **Step 5: Re-run merger phase 2 pour intégrer J2**

Run: `python dofus-app/scripts/merge-rename-table.py --phase 2`
Expected: nouvelle stat `Total RenameEntry rows: N+M` (N de J1 + M de J2).

- [ ] **Step 6: Commit**

```bash
git add dofus-app/scripts/parse-captured-descriptors.py dofus-app/data/runtime/filedescriptor-init-rename.json dofus-app/data/indexed/frida-rename-table.json dofus-app/data/indexed/merge-conflicts.md
git commit -m "$(cat <<'EOF'
feat(deobfusc): J2.3 parse captured FileDescriptors + merge phase 2

Re-parse hex byte[] dumps as FileDescriptorProto, cross-ref each message
by signature against proto-schema-decompiled.json. Emits high_runtime
RenameEntries. Merger phase 2 integrates these into frida-rename-table.json.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: String-refs sweep — extraction strings (J3.1 partie 1)

**Files:**
- Create: `dofus-app/scripts/extract-stringrefs-classlinks.py`
- Output: `dofus-app/data/indexed/string-refs-classlinks.json`

- [ ] **Step 1: Identifier l'outil pour parser le PE x64**

Vérifier que `pefile` Python est dispo :

```bash
python -c "import pefile; print(pefile.__version__)"
```

Si KO : `pip install pefile capstone`.

- [ ] **Step 2: Créer le script (partie 1 — extraction strings + scan XRefs basique)**

```python
#!/usr/bin/env python3
"""
String-refs sweep adapté de la méthodologie VRChat phase 2.

1. Extract all ASCII/UTF-16 strings (≥4 chars) from .rdata of GameAssembly.dll
2. Filter strings by interesting patterns:
   - Logger names: "Some.Class.Name", "Loading <X>"
   - Exception messages: "<X> not found", "Cannot <verb>"
   - Asset paths: "Assets/Scripts/<X>.cs", "PackageCache/com.ankama.*"
3. For each kept string, find functions that reference it via `lea rax, [string]`
   pattern (or load address into reg). Use Capstone disassembler.
4. Cross-ref with Cpp2IL index: each XRef → (class_obf, method_obf).
5. Heuristics for confidence:
   - String looks like class name + 1 class refs it → high_unique
   - String is exception ref'd by 2-5 → medium_xref
   - Ref'd by 50+ → ignored (generic logger)

Usage: python extract-stringrefs-classlinks.py [--self-test]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _rename_schema import RenameEntry, write_entries

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "dofus-app" / "data" / "indexed" / "string-refs-classlinks.json"
RENAME_OUT = ROOT / "dofus-app" / "data" / "indexed" / "string-refs-rename.json"
INDEX_CORE = ROOT / "dofus-app" / "data" / "indexed" / "core.classes.json"
INDEX_PROTOGAME = ROOT / "dofus-app" / "data" / "indexed" / "protocol-game.classes.json"


def get_game_assembly_path() -> Path:
    paths_json = ROOT / "dofus-app" / "scripts" / "dofus-paths.json"
    paths = json.loads(paths_json.read_text(encoding="utf-8"))
    return Path(paths["game_assembly_dll"])


# --- String filters ---
RE_DOTTED_CLASS = re.compile(r"^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]+){1,5}$")
RE_ASSET_PATH = re.compile(r"^(?:Assets|PackageCache|Library)/.+\.(?:cs|prefab|asset|unity)$")
RE_LOG_PATTERN = re.compile(r"^(?:Loading|Failed to|Cannot|Initializing|Closing|Starting|Stopping)\s+\w+")
RE_EXCEPTION = re.compile(r"\b(?:[A-Z][a-z]+){2,}\b\s+not\s+(?:found|registered|valid|loaded)")


def is_interesting_string(s: str) -> tuple[bool, str]:
    """Returns (keep, category)."""
    if len(s) < 6 or len(s) > 200:
        return False, ""
    if RE_DOTTED_CLASS.match(s):
        return True, "dotted_class"
    if RE_ASSET_PATH.match(s):
        return True, "asset_path"
    if RE_LOG_PATTERN.match(s):
        return True, "log_pattern"
    if RE_EXCEPTION.search(s):
        return True, "exception"
    return False, ""


def extract_strings_from_pe(pe_path: Path):
    """Yields (offset, string, category) for interesting strings in .rdata."""
    import pefile
    pe = pefile.PE(str(pe_path), fast_load=True)
    rdata = None
    for s in pe.sections:
        nm = s.Name.rstrip(b"\x00").decode("ascii", errors="ignore")
        if nm == ".rdata":
            rdata = s
            break
    if rdata is None:
        raise RuntimeError("No .rdata section found in PE")
    data = rdata.get_data()
    base_va = rdata.VirtualAddress
    # Walk byte by byte looking for ASCII strings
    i = 0
    while i < len(data):
        # try ASCII
        j = i
        while j < len(data) and 0x20 <= data[j] < 0x7F:
            j += 1
        if j > i + 5 and j < len(data) and data[j] == 0:
            try:
                s = data[i:j].decode("ascii")
            except Exception:
                s = ""
            keep, cat = is_interesting_string(s)
            if keep:
                yield (base_va + i, s, cat)
            i = j + 1
        else:
            i += 1


def find_xrefs_to_strings(pe_path: Path, string_offsets: dict[int, str]):
    """For each string at virtual_address va, find call sites that
    reference it. Strategy: scan .text for `lea reg, [rip + disp]`
    instructions where rip+disp lands in our string_offsets.

    Returns {va: [callsite_va, ...]}
    """
    import pefile
    from capstone import Cs, CS_ARCH_X86, CS_MODE_64
    pe = pefile.PE(str(pe_path), fast_load=True)
    text = None
    for s in pe.sections:
        nm = s.Name.rstrip(b"\x00").decode("ascii", errors="ignore")
        if nm == ".text":
            text = s
            break
    if text is None:
        raise RuntimeError("No .text section found")
    code = text.get_data()
    base_va = text.VirtualAddress + pe.OPTIONAL_HEADER.ImageBase
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = True
    image_base = pe.OPTIONAL_HEADER.ImageBase
    string_set = set(string_offsets.keys())
    refs: dict[int, list[int]] = defaultdict(list)
    # WARNING: full disassembly of GameAssembly.dll is slow (~1-3 GB binary).
    # We chunk in 1 MiB blocks and only consider lea/mov instructions.
    chunk_size = 1 * 1024 * 1024
    for offset in range(0, len(code), chunk_size):
        chunk = code[offset:offset + chunk_size]
        chunk_va = base_va + offset
        for ins in md.disasm(chunk, chunk_va):
            if ins.mnemonic not in ("lea", "mov"):
                continue
            for op in ins.operands:
                if op.type != 3:  # CS_OP_MEM
                    continue
                # rip-relative: op.mem.base == X86_REG_RIP
                if op.mem.base == 0x29:  # X86_REG_RIP id
                    target_va = ins.address + ins.size + op.mem.disp
                    target_rva = target_va - image_base
                    if target_rva in string_set:
                        refs[target_rva].append(ins.address - image_base)
                        break
    return refs


def load_cpp2il_method_index() -> dict:
    """Returns {rva_int: (class_obf, method_obf)} from indexed classes."""
    out = {}
    for idx in (INDEX_CORE, INDEX_PROTOGAME):
        if not idx.exists():
            continue
        data = json.loads(idx.read_text(encoding="utf-8"))
        for class_name, meta in data.items():
            for m in meta.get("methods", []):
                rva = m.get("rva")
                length = m.get("length") or m.get("Length")
                if not rva:
                    continue
                rva_int = int(rva, 16) if isinstance(rva, str) else rva
                length_int = int(length, 16) if isinstance(length, str) else (length or 0x100)
                # Index by method start, but the resolver will need a range
                out[rva_int] = (class_name, m.get("name"), length_int)
    return out


def resolve_callsites_to_methods(refs: dict, method_index: dict):
    """For each (string_rva, [callsite_rva]), resolve callsite to (class, method)."""
    # method_index : {rva_int: (class, method, length)}
    sorted_starts = sorted(method_index.keys())
    string_to_classes: dict[int, dict] = defaultdict(lambda: defaultdict(int))
    import bisect
    for str_rva, callsites in refs.items():
        for cs_rva in callsites:
            i = bisect.bisect_right(sorted_starts, cs_rva) - 1
            if i < 0:
                continue
            start = sorted_starts[i]
            cls, mth, length = method_index[start]
            if cs_rva > start + length:
                continue  # outside method
            string_to_classes[str_rva][cls] += 1
    return string_to_classes


def build_rename_entries(strings_by_rva: dict, string_to_classes: dict, category_for_rva: dict) -> list[RenameEntry]:
    out = []
    for str_rva, class_counts in string_to_classes.items():
        if not class_counts:
            continue
        # If a single class refs the string and the string looks like a
        # class name → high_unique
        if len(class_counts) == 1:
            cls = next(iter(class_counts))
            s = strings_by_rva.get(str_rva, "")
            cat = category_for_rva.get(str_rva, "")
            if cat == "dotted_class" or cat == "asset_path":
                # Extract probable class name from string
                if cat == "dotted_class":
                    real = s.split(".")[-1]
                    ns = ".".join(s.split(".")[:-1])
                else:
                    real = Path(s).stem
                    ns = ""
                out.append(RenameEntry(
                    obf_name=cls,
                    original_name=real,
                    namespace=ns,
                    confidence="high_unique",
                    evidence_source="stringrefs",
                    evidence_detail=f"only ref to '{s}' (cat={cat})",
                ))
        # If 2-5 classes → medium_xref candidates (no single mapping)
        elif 2 <= len(class_counts) <= 5:
            s = strings_by_rva.get(str_rva, "")
            cat = category_for_rva.get(str_rva, "")
            if cat in ("dotted_class", "asset_path"):
                # Emit each as a low-confidence candidate
                for cls in class_counts:
                    real = s.split(".")[-1] if cat == "dotted_class" else Path(s).stem
                    out.append(RenameEntry(
                        obf_name=cls,
                        original_name=real,
                        namespace="",
                        confidence="low_struct_match",
                        evidence_source="stringrefs",
                        evidence_detail=f"{len(class_counts)}-way ref to '{s}'",
                    ))
        # 50+ → ignored (handled by upstream filter)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--dll", default=None)
    ap.add_argument("--output", default=str(OUTPUT))
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    dll_path = Path(args.dll) if args.dll else get_game_assembly_path()
    if not dll_path.exists():
        sys.exit(f"DLL not found: {dll_path}")
    print(f"Extracting strings from {dll_path}")
    strings_iter = extract_strings_from_pe(dll_path)
    strings_by_rva = {}
    cat_by_rva = {}
    for rva, s, cat in strings_iter:
        strings_by_rva[rva] = s
        cat_by_rva[rva] = cat
    print(f"  {len(strings_by_rva)} interesting strings retained")
    print("Disassembling .text + finding XRefs (this takes a few minutes)...")
    refs = find_xrefs_to_strings(dll_path, strings_by_rva)
    total_refs = sum(len(v) for v in refs.values())
    print(f"  {total_refs} total xrefs across {len(refs)} strings")
    print("Loading Cpp2IL method index...")
    method_index = load_cpp2il_method_index()
    print(f"  {len(method_index)} methods indexed")
    print("Resolving callsites...")
    string_to_classes = resolve_callsites_to_methods(refs, method_index)
    print(f"  {len(string_to_classes)} strings successfully resolved to ≥1 class")
    print("Writing classlinks JSON...")
    classlinks = {
        str(rva): {
            "string": strings_by_rva[rva],
            "category": cat_by_rva[rva],
            "classes": dict(class_counts),
        }
        for rva, class_counts in string_to_classes.items()
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(classlinks, indent=2), encoding="utf-8")
    print(f"  → {args.output}")
    print("Building RenameEntry rows...")
    entries = build_rename_entries(strings_by_rva, string_to_classes, cat_by_rva)
    n = write_entries(entries, RENAME_OUT)
    print(f"  → {RENAME_OUT} ({n} rows)")


def _self_test():
    keep, cat = is_interesting_string("Core.UI.Cartography.MapView")
    assert keep and cat == "dotted_class"
    keep, cat = is_interesting_string("Loading scene")
    assert keep and cat == "log_pattern"
    keep, cat = is_interesting_string("a")
    assert not keep
    keep, cat = is_interesting_string("Assets/Scripts/Foo.cs")
    assert keep and cat == "asset_path"
    print("OK extract-stringrefs-classlinks._self_test")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run self-test**

Run: `python dofus-app/scripts/extract-stringrefs-classlinks.py --self-test`
Expected: `OK extract-stringrefs-classlinks._self_test`

- [ ] **Step 4: Run sur GameAssembly.dll**

Run: `python dofus-app/scripts/extract-stringrefs-classlinks.py`

Expected: prend 5-15 min sur un binaire d'environ 1 GB. `Wrote N rows` avec N entre 50 et 500. Si le disassembly chunked rate timeout/crash, augmenter `chunk_size` à 4 MiB ou réduire la portée à `.text` chunks contigus seulement.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/scripts/extract-stringrefs-classlinks.py dofus-app/data/indexed/string-refs-classlinks.json dofus-app/data/indexed/string-refs-rename.json
git commit -m "$(cat <<'EOF'
feat(deobfusc): J3.1 string-refs sweep on GameAssembly.dll

Extract dotted class names / asset paths / log patterns / exceptions
from .rdata, find rip-relative XRefs in .text via Capstone, resolve
callsites to (class, method) via Cpp2IL method RVA index. Emits
high_unique entries when a single class refs a class-name string.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Merge final + regen docs (J3.2)

**Files:**
- Modify: `dofus-app/data/indexed/frida-rename-table.json` (final state via merge --phase final)
- Modify: `dofus-app/docs/dofus-deobfuscation-final.md` — add Session 8 section
- Modify: `dofus-app/data/indexed/merge-conflicts.md`

- [ ] **Step 1: Run merge final**

Run: `python dofus-app/scripts/merge-rename-table.py --phase final`

Expected: `Total RenameEntry rows: N` qui agrège J1+J2+J3.

- [ ] **Step 2: Calculer les métriques finales**

```bash
python -c "
import json
t = json.load(open('dofus-app/data/indexed/frida-rename-table.json'))
classes = t.get('classes', {})
high = sum(1 for c in classes.values() if c.get('deobfusc_confidence') == 'high_unique')
high_runtime = sum(1 for c in classes.values() if c.get('deobfusc_confidence') == 'high_runtime')
medium = sum(1 for c in classes.values() if c.get('deobfusc_confidence') == 'medium_xref')
low = sum(1 for c in classes.values() if c.get('deobfusc_confidence') == 'low_struct_match')
total = high + high_runtime + medium + low
print(f'high_unique: {high}')
print(f'high_runtime: {high_runtime}')
print(f'medium_xref: {medium}')
print(f'low_struct_match: {low}')
print(f'TOTAL named: {total}')
print(f'Per-source breakdown:')
sources = {}
for obf, c in classes.items():
    for s in (c.get('deobfusc_sources') or []):
        sources[s] = sources.get(s, 0) + 1
for s, n in sorted(sources.items(), key=lambda kv: -kv[1]):
    print(f'  {s}: {n}')
"
```

- [ ] **Step 3: Mettre à jour `dofus-deobfuscation-final.md` avec une section Session 8**

```python
# Append à la fin de dofus-app/docs/dofus-deobfuscation-final.md :
```

```markdown
## Session 8 — Multi-path sprint (terminée 2026-04-29 → 2026-05-01)

Sprint de 3 jours combinant 4-5 nouvelles sources non tentées avant.
Spec : [`docs/superpowers/specs/2026-04-29-deobfusc-sprint-multipath-design.md`](superpowers/specs/2026-04-29-deobfusc-sprint-multipath-design.md).

### Pipeline

```
[AssetRipper bundles]    →  data/external/assetripper-monobehaviours.json
[DBI/DDC mappings]       →  data/external/dbi-name-table.json
[protodec --il2cpp]      →  data/external/protodec-rename.json
[FileDescriptor hook]    →  data/runtime/filedescriptor-init-rename.json
[String-refs sweep]      →  data/indexed/string-refs-rename.json
                                      │
                                      ▼
                  [merge-rename-table.py]
                                      │
                                      ▼
            data/indexed/frida-rename-table.json
```

### Résultats

| Source | RenameEntry rows | Confidence dominante |
|---|---|---|
| AssetRipper MonoBehaviours | (N) | (high_unique/medium_xref) |
| DBI/DDC | (N) | |
| protodec | (N) | |
| FileDescriptor hook | (N) | high_runtime |
| String-refs | (N) | |

(remplir les cellules avec les compteurs réels du Step 2)

### Métriques finales

| Avant sprint | Après sprint |
|---|---|
| ~110 classes nommées | (N) |
| 44 messages .proto haute conf | (N) |

### Pistes confirmées / invalidées dans ce sprint

- `[ASSETRIPPER_RESULT]` : décrire si l'hypothèse "MonoBehaviours sérialisés en YAML" a tenu
- `[FILEDESCRIPTOR_HOOK_RESULT]` : succès / échec partiel / échec total
- `[STRING_REFS_RESULT]` : nombre d'entries high_unique extraites

### Outputs session 8

- `dofus-app/scripts/parse-assetripper-monobehaviours.py`
- `dofus-app/scripts/parse-dbi-tables.py`
- `dofus-app/scripts/run-protodec.py`
- `dofus-app/scripts/find-filedescriptor-init-rvas.py`
- `dofus-app/scripts/parse-captured-descriptors.py`
- `dofus-app/scripts/extract-stringrefs-classlinks.py`
- `dofus-app/scripts/merge-rename-table.py`
- `src/rpc-agent/proto-descriptor-capture.ts`
- `dofus-app/scripts/capture-proto-descriptors.js`
```

Ouvrir le fichier et l'éditer avec le bloc ci-dessus, en remplaçant les `[..._RESULT]` placeholders par les vrais résultats observés.

- [ ] **Step 4: Commit final du sprint**

```bash
git add dofus-app/data/indexed/frida-rename-table.json dofus-app/data/indexed/merge-conflicts.md dofus-app/docs/dofus-deobfuscation-final.md
git commit -m "$(cat <<'EOF'
docs+data(deobfusc): J3 final merge + session 8 summary

- merge-rename-table.py phase=final consumes all 5 sources
- Session 8 section added to dofus-deobfuscation-final.md with metrics
- Sprint multi-path complete

Before:  ~110 classes named, 44 .proto messages high-conf
After:   (N) classes, (M) .proto messages
Plafond pratique: from 75% to (X)%

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Smoke test final + validation table

**Files:**
- Aucun nouveau fichier — vérification globale.

- [ ] **Step 1: Validate frida-rename-table.json structure**

```bash
python -c "
import json
t = json.load(open('dofus-app/data/indexed/frida-rename-table.json'))
classes = t.get('classes', {})
# Schema sanity checks
broken = []
for obf, c in classes.items():
    if 'label' not in c:
        broken.append((obf, 'no label'))
    # If has name_candidates, original_name should be None
    if c.get('name_candidates') and c.get('original_name'):
        broken.append((obf, 'both name_candidates and original_name'))
print(f'Total classes: {len(classes)}')
print(f'Schema violations: {len(broken)}')
for b in broken[:10]:
    print(f'  {b}')
assert len(broken) == 0, 'Schema violations detected'
print('OK structure valid')
"
```

Expected: `OK structure valid`. Si violations, fix dans `merge-rename-table.py` et re-run merge final + commit fix.

- [ ] **Step 2: Sample 10 random nouvelles entries pour audit manuel**

```bash
python -c "
import json, random
t = json.load(open('dofus-app/data/indexed/frida-rename-table.json'))
classes = t.get('classes', {})
new_named = [(obf, c) for obf, c in classes.items() if c.get('deobfusc_sources') and c.get('original_name')]
random.seed(42)
sample = random.sample(new_named, min(10, len(new_named)))
for obf, c in sample:
    print(f'  {obf} → {c[\"original_name\"]} (conf={c.get(\"deobfusc_confidence\")}, sources={c.get(\"deobfusc_sources\")})')
"
```

Inspecter à l'œil que les noms sont plausibles. Si beaucoup d'aberrations (ex: `egq → MonsterFightZoneEvent` clairement faux vu qu'on sait `egq = HaapiClient`), revoir la priorité de confidence aggregation.

- [ ] **Step 3: Vérifier que la regen `deobfuscation-map.md` est cohérente**

Si `dofus-app/scripts/build-deobfuscation-map.py` consomme `frida-rename-table.json` et regen le `.md`, le lancer :

```bash
python dofus-app/scripts/build-deobfuscation-map.py 2>&1 | tail -20
```

Expected: `.md` regen sans erreur. Si le script ne consomme pas la nouvelle structure, c'est OK pour ce sprint — le `.md` reste à jour avec l'ancienne map et la nouvelle table sert pour les sessions futures.

- [ ] **Step 4: Update mémoire claude session 2026-04-29 → ajouter pointer vers session 8**

Note pour future référence — le sprint a été completé sur les dates `2026-04-29 → 2026-05-01`. Pas besoin de modifier le memory file maintenant ; il sera mis à jour automatiquement à la fin de la conversation suivante quand on en discutera.

- [ ] **Step 5: Commit final si quelque chose a bougé**

```bash
git status
# si rien à commiter, OK. Sinon commit final récap.
```

---

## Self-Review

Relecture avec un œil neuf, vs la spec.

**1. Spec coverage check** :
- Section 1 spec (architecture data flow) → Tasks 1, 5, 11
- Section 2.1 (AssetRipper) → Task 2
- Section 2.2 (DBI/DDC) → Task 3
- Section 2.3 (protodec) → Task 4
- Section 2.4 (merge fin J1) + critère go/no-go → Task 5
- Section 3.1 (localisation offline) → Task 6
- Section 3.2 (hook ciblé runtime) → Tasks 7+8
- Section 3.3 (critère go/no-go fin J2) → Task 8 step 5
- Section 4.1 (string-refs) → Task 10
- Section 4.2 (merge final) → Task 11
- Section 4.3 (regen + commit) → Task 11
- Section 4.4 (livrables) → tous (file structure)
- Section 4.5 (métriques) → Task 11 step 2 + Task 12 step 2

Couverture : ✅ complète.

**2. Placeholder scan** : aucun TBD/TODO/"implement later" trouvé. Les `[..._RESULT]` dans Task 11 step 3 sont explicitement marqués comme placeholders à remplir avec les vrais résultats observés à l'exécution — c'est une instruction, pas un placeholder de plan.

**3. Type consistency** :
- `RenameEntry` défini en Task 1, utilisé partout via `read_entries`/`write_entries` ✅
- `evidence_source` valeurs : `assetripper`, `dbi`, `protodec`, `filedescriptor_hook`, `stringrefs` — toutes définies dans `_rename_schema.py` Literal ✅
- `confidence` valeurs : `high_unique`, `high_runtime`, `medium_xref`, `low_struct_match` — toutes définies ✅
- `find-filedescriptor-init-rvas.py` output champ `class_obf_name` consommé par `proto-descriptor-capture.ts` ✅
- `merge-rename-table.py` source paths : J1_SOURCES, J2_SOURCES, J3_SOURCES — chaque parser écrit le path attendu ✅

**Issue spotted** : dans `merge-rename-table.py` Task 5, `J2_SOURCES` pointe vers `filedescriptor-init-rename.json` — c'est aussi le nom utilisé par `parse-captured-descriptors.py` Task 9. ✅ cohérent.

**Issue spotted 2** : `string-refs-rename.json` dans Task 10 vs `J3_SOURCES` dans Task 5. Le path est `dofus-app/data/indexed/string-refs-rename.json` partout. ✅

Plan validé.

---

## Execution Handoff

Plan complete et sauvegardé à `dofus-app/docs/superpowers/plans/2026-04-29-deobfusc-sprint-multipath.md`.

Deux options d'exécution :

**1. Subagent-Driven (recommandé)** — je dispatch un subagent frais par tâche, review entre tâches, itération rapide.

**2. Inline Execution** — exécution des tâches dans cette session via executing-plans, exécution batch avec checkpoints pour review.

Quelle approche ?
