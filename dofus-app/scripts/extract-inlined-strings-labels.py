#!/usr/bin/env python3
"""
Task 14 — Extract inlined string literals (+ using-namespaces + method names)
from AssetRipper-decompiled obfuscated .cs files, classify per-domain,
and emit RenameEntry rows for classes with strong domain signal.

Offline equivalent of "scan global-metadata.dat" but uses AssetRipper's
already-resolved decompilation as input — no binary parser needed.

CLI:
    python extract-inlined-strings-labels.py              (run, emit JSON)
    python extract-inlined-strings-labels.py --self-test  (smoke test)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "dofus-app" / "scripts"
DATA_INDEXED = ROOT / "dofus-app" / "data" / "indexed"
DATA_EXTERNAL = ROOT / "dofus-app" / "data" / "external"

CS_DIRS = [
    DATA_EXTERNAL / "assetripper-export" / "Scripts" / "Core",
    DATA_EXTERNAL / "assetripper-export" / "Scripts" / "Ankama.Dofus.Protocol.Game",
]

CPP2IL_INDEXES = [
    DATA_INDEXED / "core.classes.json",
    DATA_INDEXED / "protocol-game.classes.json",
]

EXISTING_TABLE = DATA_INDEXED / "frida-rename-table.json"
OUTPUT_JSON = DATA_EXTERNAL / "inlined-strings-rename.json"

# ---------------------------------------------------------------------------
# Import shared schema
# ---------------------------------------------------------------------------
sys.path.insert(0, str(SCRIPTS_DIR))
from _rename_schema import RenameEntry, write_entries  # noqa: E402

# ---------------------------------------------------------------------------
# Domain vocabulary
# ---------------------------------------------------------------------------
DOMAIN_VOCAB: dict[str, list[str]] = {
    "cartography": ["worldMap", "subArea", "cartography", "atlas", "houseDoor",
                    "taxCollector", "anomaly", "dungeonEntry", "zaap",
                    "mapId", "areaId", "hint", "POI", "worldArea"],
    "fight": ["fight", "combat", "spell", "turn", "fighter", "buff", "damage",
              "challenge", "aggression", "battlefield", "summon", "monster"],
    "inventory": ["item", "inventory", "objectItem", "stack", "equip", "slot",
                  "ankaShard", "kama", "ogrines", "shopItem"],
    "audio": ["FMOD", "bank", "studio", "Desktop", "Mobile", "audio", "sound",
              "music", "ambient", "loop", "volume", "fade"],
    "ui_cartography": ["MapUI", "WorldMapUI", "cartographyUI"],
    "haapi": ["haapi", "Haapi", "ankama-account", "kard", "almanax", "shopi",
              "ogrine", "bakBid", "consume", "token", "auth"],
    "social": ["friend", "guild", "chat", "message", "party", "group", "ignore",
               "block", "mute", "alliance"],
    "quest": ["quest", "achievement", "objective", "step", "reward"],
    "npc": ["npc", "dialogue", "interaction", "merchant", "interactive"],
    "render": ["entity", "render", "look", "appearance", "skin", "outfit",
               "anim", "boneAnim", "graphic"],
    "network": ["packet", "message", "network", "socket", "send", "receive",
                "tcp", "udp"],
    "input": ["input", "keyboard", "mouse", "touch", "controller", "gamepad",
              "binding", "shortcut"],
    "tutorial": ["tuto", "tutorial", "newcomer", "introduction", "step"],
    "ankama": ["Ankama", "Dofus", "Krosmoz"],
    "platform": ["Desktop", "Mobile", "iOS", "Android", "WebGL", "PC", "Windows", "Mac"],
    "settings": ["setting", "option", "config", "preference"],
    "asset": ["addressable", "bundle", "asset", "prefab", "sprite", "texture",
              "atlas"],
    "leaderboard": ["leaderboard", "rank", "score", "podium", "ladder"],
}

# Build lowercase version for case-insensitive matching
_DOMAIN_VOCAB_LOWER: dict[str, list[str]] = {
    domain: [kw.lower() for kw in keywords]
    for domain, keywords in DOMAIN_VOCAB.items()
}

# ---------------------------------------------------------------------------
# Domain → suffix/label helpers
# ---------------------------------------------------------------------------
DOMAIN_PASCAL: dict[str, str] = {
    "cartography": "Cartography",
    "fight": "Fight",
    "inventory": "Inventory",
    "audio": "Audio",
    "ui_cartography": "CartographyUI",
    "haapi": "Haapi",
    "social": "Social",
    "quest": "Quest",
    "npc": "Npc",
    "render": "Render",
    "network": "Network",
    "input": "Input",
    "tutorial": "Tutorial",
    "ankama": "Ankama",
    "platform": "Platform",
    "settings": "Settings",
    "asset": "Asset",
    "leaderboard": "Leaderboard",
}

# Strings that are too noisy to carry domain signal
_NOISE_STRINGS = {
    "value", "key", "index", "name", "type", "id", "data", "null", "true", "false",
    "this", "get", "set", "add", "remove", "update", "init", "start", "stop",
    "error", "warning", "info", "debug", "log", "test", "temp", "default",
    "event", "object", "list", "array", "string", "int", "bool", "float",
    "result", "count", "size", "length", "path", "file", "config", "base",
    "new", "old", "yes", "no", "ok",
}

_NUM_RE = re.compile(r"^[\d\s\.\,\-\+\*\/\%\(\)\[\]\{\}:]+$")
_GUID_RE = re.compile(r"^[0-9a-f]{8,}$", re.IGNORECASE)
_PATH_NOISE = re.compile(r"^[A-Z]:\\|^/[a-z]|^\./")

# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------

# Match "..." string literals — does NOT handle escape sequences (fine for our use)
_STRING_LIT_RE = re.compile(r'"([^"]{3,200})"')
_USING_RE = re.compile(r'^using\s+([\w.]+)\s*;', re.MULTILINE)


def extract_strings_from_cs(content: str) -> list[str]:
    """
    Extract informative string tokens from a .cs source file.
    Sources:
      1. Quoted string literals in the body
      2. Using-namespace component tokens (each dot-separated part)
      3. Public method original_names are NOT here (come from Cpp2IL index)

    Returns a flat list of lowercase-normalised tokens for frequency analysis.
    """
    tokens: list[str] = []

    # 1. String literals
    for s in _STRING_LIT_RE.findall(content):
        s_stripped = s.strip()
        if _is_informative(s_stripped):
            # Split on camelCase boundaries + common separators for bag-of-words
            tokens.extend(_tokenise(s_stripped))
            # Also keep the raw string as-is for substring domain matching
            tokens.append(s_stripped)

    # 2. Using namespace tokens
    for ns in _USING_RE.findall(content):
        # e.g. "Com.Ankama.HaapiDofus.Model" → each part
        parts = ns.split(".")
        for p in parts:
            if len(p) >= 3 and p not in {"Com", "Model", "Data", "Core", "Base",
                                          "System", "Collections", "Generic",
                                          "Linq", "Threading", "Tasks"}:
                tokens.append(p)
        # Also keep full namespace for direct substring matching
        tokens.append(ns)

    return tokens


def _is_informative(s: str) -> bool:
    """Filter out noisy or trivially-generic strings."""
    if len(s) < 3 or len(s) > 200:
        return False
    sl = s.lower()
    if sl in _NOISE_STRINGS:
        return False
    if _NUM_RE.match(s):
        return False
    if _GUID_RE.match(s):
        return False
    # Skip things like "ILSpy generated..."  purely ASCII symbol sequences
    if s.startswith("//") or s.startswith("/*"):
        return False
    return True


def _tokenise(s: str) -> list[str]:
    """Split a string on separators and camelCase boundaries."""
    # Split on non-alphanum first
    parts = re.split(r'[_\-\s/\\.:,]+', s)
    out: list[str] = []
    for part in parts:
        if not part:
            continue
        # CamelCase split: "taxCollector" → ["tax", "Collector"]
        sub = re.sub(r'([a-z])([A-Z])', r'\1 \2', part).split()
        out.extend(sub)
        # Keep the original part too
        if part not in sub:
            out.append(part)
    return out


# ---------------------------------------------------------------------------
# Domain classification
# ---------------------------------------------------------------------------

def classify(tokens: list[str]) -> tuple[Optional[str], float, float]:
    """
    Classify a list of tokens into domains.
    Returns (top_domain, top_score, top2_score).
    top_score = (distinct keyword matches) / (total domain keywords).
    """
    if not tokens:
        return None, 0.0, 0.0

    # Build a lowercase token set + keep originals for substring matching
    token_lower_set = set(t.lower() for t in tokens)
    token_concat = " ".join(tokens).lower()

    # Normalisation denominator: use 10 so that 3 distinct keyword hits → score=0.30.
    # This is independent of vocab list size — a domain with 15 keywords isn't
    # penalised relative to one with 5.
    NORM_DENOM = 10.0

    scores: dict[str, float] = {}
    match_counts: dict[str, int] = {}
    for domain, kw_list in _DOMAIN_VOCAB_LOWER.items():
        matched = 0
        for kw in kw_list:
            # Exact token or substring match in concatenated token string
            if kw in token_lower_set or kw in token_concat:
                matched += 1
        if matched > 0:
            scores[domain] = min(matched / NORM_DENOM, 1.0)
            match_counts[domain] = matched

    if not scores:
        return None, 0.0, 0.0

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    top_domain, top_score = ranked[0]
    top2_score = ranked[1][1] if len(ranked) >= 2 else 0.0

    top_distinct_matches = match_counts.get(top_domain, 0)

    if top_score >= 0.30 and top_distinct_matches >= 3:
        return top_domain, top_score, top2_score
    return None, top_score, top2_score


# ---------------------------------------------------------------------------
# Load Cpp2IL index
# ---------------------------------------------------------------------------

def load_cpp2il_index() -> dict[str, dict]:
    """
    Returns a dict keyed by class name → type dict from Cpp2IL.
    Includes method original_names as extra tokens.
    """
    result: dict[str, dict] = {}
    for path in CPP2IL_INDEXES:
        if not path.exists():
            print(f"[WARN] Cpp2IL index missing: {path}", file=sys.stderr)
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        for tp in raw.get("types", []):
            result[tp["name"]] = tp
    return result


# ---------------------------------------------------------------------------
# Suffix heuristic
# ---------------------------------------------------------------------------

PARENT_SUFFIX_HINTS: list[tuple[str, str]] = [
    # (substring to search in parents/labels, suffix)
    ("Service", "Service"),
    ("Manager", "Manager"),
    ("Provider", "Provider"),
    ("View", "View"),
    ("UI", "UI"),
    ("Controller", "Controller"),
    ("Handler", "Handler"),
    ("Listener", "Listener"),
    ("Presenter", "Presenter"),
    ("Repository", "Repository"),
    ("Factory", "Factory"),
    ("Builder", "Builder"),
]


def infer_suffix(obf_name: str, cpp2il_index: dict, rename_table: dict) -> str:
    """
    Look at parent classes (from Cpp2IL) and check if any are already labelled
    with a recognisable suffix. Default: Service.
    """
    tp = cpp2il_index.get(obf_name)
    if not tp:
        return "Service"

    parents = tp.get("parents", [])
    classes_table = rename_table.get("classes", {})

    for parent_obf in parents:
        parent_entry = classes_table.get(parent_obf, {})
        parent_label = parent_entry.get("label", parent_obf)
        for hint, suffix in PARENT_SUFFIX_HINTS:
            if hint.lower() in parent_label.lower():
                return suffix

    # Fall back on the class's own parent name string
    for parent_obf in parents:
        for hint, suffix in PARENT_SUFFIX_HINTS:
            if hint.lower() in parent_obf.lower():
                return suffix

    return "Service"


# ---------------------------------------------------------------------------
# Main scan
# ---------------------------------------------------------------------------

def scan_directory(cs_dir: Path, cpp2il_index: dict, rename_table: dict,
                   existing_high_unique: set[str]) -> tuple[list[RenameEntry], dict]:
    """
    Scan all obfuscated .cs files in cs_dir.
    Returns (entries, stats).
    """
    entries: list[RenameEntry] = []
    stats = {
        "total_files": 0,
        "with_strings": 0,
        "with_signal": 0,
        "validated": 0,
        "contradicted": 0,
        "contradicted_list": [],
        "new": 0,
    }

    if not cs_dir.exists():
        print(f"[WARN] CS dir missing: {cs_dir}", file=sys.stderr)
        return entries, stats

    for cs_file in cs_dir.glob("*.cs"):
        # Only process obfuscated class files (short names, ≤5 chars + .cs)
        stem = cs_file.stem
        if len(stem) > 8 or not re.match(r'^[a-z][a-z_]{1,7}$', stem, re.IGNORECASE):
            continue

        stats["total_files"] += 1

        try:
            content = cs_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        # Extract tokens (strings + namespace parts)
        tokens = extract_strings_from_cs(content)

        # Also enrich with method original_names from Cpp2IL index
        tp = cpp2il_index.get(stem)
        if tp:
            for m in tp.get("methods", []):
                orig = m.get("original_name")
                if orig and len(orig) >= 3:
                    tokens.extend(_tokenise(orig))
                    tokens.append(orig)

        if len(tokens) < 3:
            continue

        stats["with_strings"] += 1

        domain, top_score, top2_score = classify(tokens)
        if domain is None:
            continue

        stats["with_signal"] += 1

        # Determine confidence
        if top_score >= 0.50 and top2_score < 0.30:
            confidence = "high_unique"
        elif top_score >= 0.30 and top2_score < top_score * 0.7:
            confidence = "medium_xref"
        else:
            confidence = "low_struct_match"

        # Infer label
        suffix = infer_suffix(stem, cpp2il_index, rename_table)
        pascal = DOMAIN_PASCAL.get(domain, domain.title())
        inferred_label = f"{pascal}{suffix}"

        # Cross-validate vs existing labels
        classes_table = rename_table.get("classes", {})
        existing_entry = classes_table.get(stem, {})
        existing_label = existing_entry.get("label", "")
        existing_conf = existing_entry.get("deobfusc_confidence", "")

        # Treat '?' or purely-obfuscated labels as absent (no real existing label)
        has_real_label = (existing_label and existing_label != stem
                          and existing_label != "?" and len(existing_label) > 3)

        if has_real_label:
            # Class already labelled — check if our domain matches
            if _label_matches_domain(existing_label, domain):
                stats["validated"] += 1
            else:
                stats["contradicted"] += 1
                stats["contradicted_list"].append({
                    "obf": stem,
                    "existing": existing_label,
                    "inferred": inferred_label,
                    "domain": domain,
                    "score": round(top_score, 3),
                })
            # Don't overwrite high_unique existing entries
            if existing_conf == "high_unique":
                continue

        else:
            stats["new"] += 1

        entry = RenameEntry(
            obf_name=stem,
            original_name=inferred_label,
            namespace="",
            confidence=confidence,
            evidence_source="inlined_strings",
            evidence_detail=f"domain={domain} score={top_score:.3f} top2={top2_score:.3f}",
        )
        entries.append(entry)

    return entries, stats


def _label_matches_domain(label: str, domain: str) -> bool:
    """Check if an existing label is broadly consistent with an inferred domain."""
    label_lower = label.lower()
    pascal_lower = DOMAIN_PASCAL.get(domain, domain).lower()
    if pascal_lower in label_lower:
        return True
    # Some fuzzy aliases
    DOMAIN_ALIASES: dict[str, list[str]] = {
        "cartography": ["map", "world", "cartograph", "atlas", "zaap"],
        "fight": ["fight", "combat", "battle", "spell"],
        "audio": ["audio", "sound", "fmod", "music"],
        "haapi": ["haapi", "ankama", "kard", "almanax"],
        "social": ["friend", "guild", "chat", "social", "party"],
        "quest": ["quest", "achiev", "objective"],
        "render": ["render", "entity", "look", "skin"],
        "network": ["network", "socket", "packet"],
        "inventory": ["inventory", "item", "equip", "slot"],
        "settings": ["setting", "option", "config", "pref"],
        "input": ["input", "keyboard", "mouse", "controller"],
        "asset": ["asset", "bundle", "sprite", "prefab", "texture"],
        "leaderboard": ["leaderboard", "rank", "score", "podium"],
    }
    for alias in DOMAIN_ALIASES.get(domain, []):
        if alias in label_lower:
            return True
    return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Extract inlined-string domain labels")
    parser.add_argument("--self-test", action="store_true", help="Run smoke test and exit")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    # Load indexes
    print("[INFO] Loading Cpp2IL indexes...", file=sys.stderr)
    cpp2il_index = load_cpp2il_index()
    print(f"[INFO] Cpp2IL types loaded: {len(cpp2il_index)}", file=sys.stderr)

    # Load existing rename table
    print("[INFO] Loading existing rename table...", file=sys.stderr)
    if not EXISTING_TABLE.exists():
        rename_table = {"classes": {}, "methods": {}, "references": {}}
    else:
        rename_table = json.loads(EXISTING_TABLE.read_text(encoding="utf-8"))

    existing_high_unique: set[str] = {
        k for k, v in rename_table.get("classes", {}).items()
        if v.get("deobfusc_confidence") == "high_unique"
    }
    print(f"[INFO] Existing high_unique entries: {len(existing_high_unique)}", file=sys.stderr)

    # Scan all CS dirs
    all_entries: list[RenameEntry] = []
    total_stats = {
        "total_files": 0,
        "with_strings": 0,
        "with_signal": 0,
        "validated": 0,
        "contradicted": 0,
        "contradicted_list": [],
        "new": 0,
    }

    for cs_dir in CS_DIRS:
        print(f"[INFO] Scanning {cs_dir.name}...", file=sys.stderr)
        entries, stats = scan_directory(cs_dir, cpp2il_index, rename_table, existing_high_unique)
        all_entries.extend(entries)
        for k in ["total_files", "with_strings", "with_signal", "validated",
                  "contradicted", "new"]:
            total_stats[k] += stats[k]
        total_stats["contradicted_list"].extend(stats["contradicted_list"])

    # Dedup: keep highest-confidence entry per obf_name
    best: dict[str, RenameEntry] = {}
    conf_rank = {"high_unique": 3, "medium_xref": 2, "low_struct_match": 1, "high_runtime": 2}
    for e in all_entries:
        existing = best.get(e.obf_name)
        if existing is None or conf_rank.get(e.confidence, 0) > conf_rank.get(existing.confidence, 0):
            best[e.obf_name] = e
    deduped = list(best.values())

    # Write output
    n = write_entries(deduped, OUTPUT_JSON)
    print(f"[INFO] Wrote {n} entries -> {OUTPUT_JSON}", file=sys.stderr)

    # Print stats
    print("\n=== INLINED-STRINGS SCAN STATS ===")
    print(f"  Total obfuscated .cs files scanned : {total_stats['total_files']}")
    print(f"  Files with extractable strings (>=3): {total_stats['with_strings']}")
    print(f"  Files with strong domain signal    : {total_stats['with_signal']}")
    print(f"  Unique classes emitted (deduped)   : {len(deduped)}")
    print(f"  --- Validation vs existing labels ---")
    print(f"  Validated (domain match)           : {total_stats['validated']}")
    print(f"  Contradicted (domain mismatch)     : {total_stats['contradicted']}")
    print(f"  New (no existing label)            : {total_stats['new']}")

    if total_stats["contradicted_list"]:
        print("\n  CONTRADICTIONS (first 10):")
        for item in total_stats["contradicted_list"][:10]:
            print(f"    {item['obf']} | existing={item['existing']!r} | "
                  f"inferred={item['inferred']!r} | domain={item['domain']} score={item['score']}")

    # Top 15 inferred labels
    by_conf = sorted(deduped, key=lambda e: conf_rank.get(e.confidence, 0), reverse=True)
    print("\n  Top 15 inferred labels:")
    print(f"  {'obf':<8} {'label':<32} {'conf':<16} {'detail'}")
    for e in by_conf[:15]:
        print(f"  {e.obf_name:<8} {e.original_name:<32} {e.confidence:<16} {e.evidence_detail}")

    print("===================================")


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _self_test() -> None:
    sample_cs = '''
    using Com.Ankama.Haapi.Model;
    public class eat {
        private const string dgfx = "taxCollector";
        private const string dgfy = "anomaly";
        private const string dgir = "flag_custom";
        private const string dgis = "flag_chat";
        public void GotoMap(string a, string b = "worldMap") { }
    }
    '''
    strings = extract_strings_from_cs(sample_cs)
    assert "taxCollector" in strings, f"taxCollector missing from {strings[:10]}"
    assert "anomaly" in strings, f"anomaly missing from {strings[:10]}"
    assert "worldMap" in strings, f"worldMap missing from {strings[:10]}"
    domain, score, top2_score = classify(strings)
    assert domain == "cartography", f"Expected cartography, got {domain!r} (score={score:.3f})"
    assert score >= 0.30, f"Expected score >= 0.30, got {score:.3f}"
    print("OK extract-inlined-strings-labels._self_test")


if __name__ == "__main__":
    main()
