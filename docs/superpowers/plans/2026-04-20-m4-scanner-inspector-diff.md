# M4 — Scanner + Inspector + Diff Implementation Plan

**Goal:** Ship three related features that share the "captured instances" foundation.

- **Scanner (IL2CPP-aware)** — "I have 1234 gold in-game, help me find which class/field holds that value". Walks alive managed instances, compares field values, returns candidates. Supports refiner (scan-next with new value).
- **Inspector** — navigate a captured instance's fields as an interactive tree. Click a reference field → capture it, expand. Click a List → show N elements. Per-field actions (watch / edit).
- **Diff** — snapshot a captured instance at T0, perform an action in-game, snapshot at T1, see which fields changed. Copy-for-Claude friendly.

**Architecture:**
- **Scanner (Frida)**: scoped-scan over a chosen assembly (`Assembly-CSharp` default), match int/float/string/bool values. Narrowing refiner keeps only candidates whose value changed to the new target.
- **Inspector (Frida)**: a single `inspectInstance(key)` RPC that returns a uniform tree-node structure with field type hints so the client can render expand/collapse smartly.
- **Diff (Frida + UI)**: RPC returns a flat `{fieldName → stringifiedValue}` map. Client stores T0, computes diff on T1. No server-side state.

**Tech stack:** same as prior milestones. No new dependencies.

---

## Scope boundary — what M4 does NOT do

- No brute-force memory scan (Cheat Engine raw-memory pattern scanning). Only IL2CPP-aware. Future expansion possible in M5+.
- No freeze/write-lock on scanner candidates (pin-to-watchlist is the read affordance; edit uses existing `writeField`).
- No across-class instance comparison in Diff (one captured key = one before/after).
- No graphical diff visualization (plain table).
- No auto-refresh in Inspector tree. Every expand is an explicit click.

---

## Task 1: Scanner Frida module

**Files:**
- Create: `src/rpc-agent/scanner.ts`
- Modify: `src/rpc-agent/rpc-methods.ts` (add `import * as scannerRpc`)

**Implementation:**

```ts
// src/rpc-agent/scanner.ts
// IL2CPP-aware value scanner. Walks alive managed instances and compares field values.
import "frida-il2cpp-bridge";
import { stringifyValue } from "../lib";

export type ScanType = "int" | "float" | "string" | "bool";

interface Candidate {
    id: string;
    className: string;
    fieldName: string;
    handle: string;
    currentValue: string;
}

// Candidates from the last scan, keyed by id. Used by rescanByValue to narrow.
const lastCandidates = new Map<string, { obj: Il2Cpp.Object; fieldName: string }>();
let nextId = 1;

function matchType(typeName: string, scanType: ScanType): boolean {
    if (scanType === "int")    return /Int32$|UInt32$|Int64$|UInt64$|Int16$|UInt16$|Byte$|SByte$/.test(typeName);
    if (scanType === "float")  return /Single$|Double$/.test(typeName);
    if (scanType === "string") return typeName === "System.String";
    if (scanType === "bool")   return typeName === "System.Boolean";
    return false;
}

function valueMatches(fieldValue: unknown, target: string, scanType: ScanType): boolean {
    try {
        if (scanType === "string") {
            const s = fieldValue == null ? "" : String(fieldValue);
            return s.replace(/^"|"$/g, "") === target;
        }
        if (scanType === "bool") {
            const b = String(fieldValue).toLowerCase();
            return (target === "true"  && (b === "true" || b === "1")) ||
                   (target === "false" && (b === "false" || b === "0"));
        }
        const n = typeof fieldValue === "number" ? fieldValue : parseFloat(String(fieldValue));
        const t = parseFloat(target);
        if (scanType === "float") return Math.abs(n - t) < 1e-4;
        return Math.trunc(n) === Math.trunc(t);
    } catch { return false; }
}

export function scanByValue(target: string, scanType: ScanType, assemblyName = "Assembly-CSharp", limit = 200): Promise<Candidate[]> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            try {
                lastCandidates.clear();
                nextId = 1;
                const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
                if (!asm) { reject(new Error(`assembly ${assemblyName} not found`)); return; }
                const out: Candidate[] = [];
                for (const klass of asm.image.classes) {
                    if (klass.isEnum || klass.isInterface) continue;
                    // Skip classes without a matching field type (cheap prefilter).
                    const matchingFields = klass.fields.filter(f => !f.isStatic && matchType(f.type.name, scanType));
                    if (matchingFields.length === 0) continue;
                    let instances: Il2Cpp.Object[];
                    try { instances = Il2Cpp.gc.choose(klass); } catch { continue; }
                    for (const inst of instances) {
                        for (const f of matchingFields) {
                            try {
                                const v = inst.field(f.name).value;
                                if (!valueMatches(v, target, scanType)) continue;
                                const id = `c${nextId++}`;
                                lastCandidates.set(id, { obj: inst, fieldName: f.name });
                                out.push({ id, className: klass.name, fieldName: f.name, handle: String(inst.handle), currentValue: stringifyValue(v) });
                                if (out.length >= limit) { resolve(out); return; }
                            } catch { /* field read failed */ }
                        }
                    }
                }
                console.log(`[scanner] scan complete: ${out.length} candidates in ${assemblyName}`);
                resolve(out);
            } catch (e) { reject(e); }
        });
    });
}

export function rescanByValue(target: string, scanType: ScanType): Promise<Candidate[]> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            try {
                const kept: Candidate[] = [];
                for (const [id, entry] of lastCandidates.entries()) {
                    try {
                        const v = entry.obj.field(entry.fieldName).value;
                        if (valueMatches(v, target, scanType)) {
                            kept.push({ id, className: entry.obj.class.name, fieldName: entry.fieldName, handle: String(entry.obj.handle), currentValue: stringifyValue(v) });
                        } else {
                            lastCandidates.delete(id);
                        }
                    } catch {
                        lastCandidates.delete(id);
                    }
                }
                console.log(`[scanner] rescan: ${kept.length} remain`);
                resolve(kept);
            } catch (e) { reject(e); }
        });
    });
}

export function clearScan(): Promise<number> {
    return new Promise((resolve) => {
        const n = lastCandidates.size;
        lastCandidates.clear();
        resolve(n);
    });
}
```

Add to `src/rpc-agent/rpc-methods.ts`:
```ts
import * as scannerRpc from "./scanner";
// ... in getRpcMethods return:
...scannerRpc,
```

**Verification:** `npm run build:rpc` exits 0. `grep -E "scanByValue|rescanByValue|clearScan" build/rpc-agent.js | wc -l` ≥ 3.

**Commit:** `feat(rpc): il2cpp-aware value scanner with refiner`

---

## Task 2: Scanner UI panel

**Files:**
- Create: `host/public/panels/scanner.ts`
- Modify: `host/public/index.html` (add "scanner" tab between `instance` and `hookpatch`)
- Modify: `host/public/main.ts` (route the new tab)

**Implementation (`scanner.ts`, ~150 lines):**

Layout:
- Form: type dropdown (`int | float | string | bool`), value input, assembly input (default `Assembly-CSharp`), SCAN button
- After initial scan: NEXT SCAN button (disabled until new value entered) + CLEAR button
- Results: list of candidates as `.readout`-style rows
  - `<class>.<field> = <currentValue>  [📌 pin]  [✎ edit]`
  - pin → `pinField("instance", className, fieldName, "<class>.<field>")` then visual "pinned" tag
  - edit → prompts for new value, calls `writeField` via the existing RPC; refreshes this row's `currentValue` via a `readField` after
- Count at top: "N candidates" / "N remain after rescan"

Key wiring:
- Initial SCAN → `rpcCall("scanByValue", [value, type, asm])`
- NEXT SCAN → `rpcCall("rescanByValue", [newValue, type])`
- CLEAR → `rpcCall("clearScan")` + empty list

**Commit:** `feat(ui): scanner panel with refiner + pin-to-watchlist`

---

## Task 3: Inspector Frida module

**Files:**
- Create: `src/rpc-agent/inspector.ts`
- Modify: `src/rpc-agent/rpc-methods.ts`

**Implementation:**

```ts
// src/rpc-agent/inspector.ts
// Inspect a captured instance and return a tree-ready node description.
import "frida-il2cpp-bridge";
import { stringifyValue } from "../lib";
import { getCapturedRaw, setCaptured } from "./registry";

type FieldNode = {
    name: string;
    typeName: string;
    kind: "primitive" | "reference" | "list" | "null" | "error";
    value?: string;          // stringified for primitives / null / error
    listCount?: number;      // for list kind
    listElemType?: string;   // for list kind
    referenceKey?: string;   // registry key if already captured
};

export function inspectInstance(key: string): Promise<{ className: string; handle: string; fields: FieldNode[] } | null> {
    return new Promise((resolve) => {
        Il2Cpp.perform(() => {
            const inst = getCapturedRaw(key);
            if (!inst) { resolve(null); return; }
            const out: FieldNode[] = [];
            for (const f of inst.class.fields) {
                if (f.isStatic) continue;
                const typeName = f.type.name;
                try {
                    const raw = inst.field(f.name).value;
                    if (raw == null || ((raw as any)?.handle?.isNull?.())) {
                        out.push({ name: f.name, typeName, kind: "null", value: "null" });
                        continue;
                    }
                    // List<T> detection
                    if (/^System\.Collections\.Generic\.List`1/.test(typeName)) {
                        let count = -1;
                        let elemType = typeName.match(/<(.+)>$/)?.[1] ?? "?";
                        try {
                            const sz = (raw as any).tryField?.("_size")?.value;
                            count = typeof sz === "number" ? sz : (raw as Il2Cpp.Object).method<number>("get_Count").invoke() as number;
                        } catch {}
                        out.push({ name: f.name, typeName, kind: "list", listCount: count, listElemType: elemType });
                        continue;
                    }
                    // Reference type (object)
                    if (typeof raw === "object" && "handle" in (raw as any)) {
                        out.push({ name: f.name, typeName, kind: "reference", value: `${(raw as Il2Cpp.Object).class.name}@${(raw as Il2Cpp.Object).handle}` });
                        continue;
                    }
                    // Primitive
                    out.push({ name: f.name, typeName, kind: "primitive", value: stringifyValue(raw) });
                } catch (e) {
                    out.push({ name: f.name, typeName, kind: "error", value: `<err: ${String(e).slice(0, 60)}>` });
                }
            }
            resolve({ className: inst.class.name, handle: String(inst.handle), fields: out });
        });
    });
}

/** Capture the value of a reference-typed field under a new key so Inspector can dive into it. */
export function captureField(parentKey: string, fieldName: string, asKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            const parent = getCapturedRaw(parentKey);
            if (!parent) { reject(new Error(`no captured instance for ${parentKey}`)); return; }
            try {
                const val = parent.field(fieldName).value as Il2Cpp.Object;
                if (!val || (val as any).handle?.isNull?.()) { reject(new Error(`${fieldName} is null`)); return; }
                setCaptured(asKey, val);
                console.log(`[inspector] captured ${parentKey}.${fieldName} as "${asKey}" → ${val.class.name}@${val.handle}`);
                resolve(`${val.class.name}@${val.handle}`);
            } catch (e) { reject(e); }
        });
    });
}

/** Pull a slice of a captured List<T> as a flat array of {index, summary}. */
export function sliceList(key: string, fieldName: string, offset = 0, limit = 50): Promise<Array<{ index: number; summary: string; isReference: boolean }>> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            const owner = getCapturedRaw(key);
            if (!owner) { reject(new Error(`no captured instance for ${key}`)); return; }
            const listObj = owner.field(fieldName).value as Il2Cpp.Object;
            if (!listObj || (listObj as any).handle?.isNull?.()) { resolve([]); return; }
            let items: Il2Cpp.Array<any> | null = null;
            let size = -1;
            try {
                const sz = (listObj as any).tryField?.("_size")?.value;
                if (typeof sz === "number") size = sz;
            } catch {}
            try {
                const arr = (listObj as any).tryField?.("_items")?.value;
                if (arr && typeof (arr as any).length === "number") items = arr as any;
            } catch {}
            if (size < 0) {
                try { size = listObj.method<number>("get_Count").invoke() as number; } catch { size = 0; }
            }
            const end = Math.min(offset + limit, size);
            const out: Array<{ index: number; summary: string; isReference: boolean }> = [];
            for (let i = offset; i < end; i++) {
                try {
                    const elem = items ? items.get(i) : listObj.method("get_Item").invoke(i);
                    if (elem == null || (elem as any)?.handle?.isNull?.()) {
                        out.push({ index: i, summary: "null", isReference: false });
                    } else if (typeof elem === "object" && "handle" in (elem as any)) {
                        out.push({ index: i, summary: `${(elem as Il2Cpp.Object).class.name}@${(elem as Il2Cpp.Object).handle}`, isReference: true });
                    } else {
                        out.push({ index: i, summary: stringifyValue(elem), isReference: false });
                    }
                } catch (e) {
                    out.push({ index: i, summary: `<err: ${String(e).slice(0, 60)}>`, isReference: false });
                }
            }
            resolve(out);
        });
    });
}
```

Registry helper note: add `export function setCaptured(key, obj)` if it doesn't exist — it mirrors the existing `getCapturedRaw` accessor pattern.

Add `import * as inspectorRpc from "./inspector"` + spread in `rpc-methods.ts`.

**Verification:** `npm run build:rpc` exits 0.

**Commit:** `feat(rpc): inspector module with instance tree, captureField, sliceList`

---

## Task 4: Inspector UI panel

**Files:**
- Create: `host/public/panels/inspector.ts`
- Modify: `host/public/index.html` (add "inspector" tab between `instance` and `scanner`, OR replace `instance` depending on UX call — recommendation: ADD, keep both, since instance panel has capture actions Inspector relies on)
- Modify: `host/public/main.ts`

**Implementation (`inspector.ts`, ~200 lines):**

Layout:
- Top bar: input for "inspect key" (defaults to last-captured key via `listCaptured` RPC on tab mount), REFRESH button
- Tree:
  - Root: `{className}@{handle}` header row
  - For each field:
    - Primitive: `<name>: <value>  [📌 watch]  [✎ edit]`
    - Null: `<name>: null` (greyed)
    - Reference: `<name>: {className}@{handle}  [▸ inspect]` — clicking CAPTURES under an auto-generated key (`<parentKey>.<field>`) and renders its tree inline below the row as nested.
    - List: `<name>: List<T>[N]  [▸ expand]` — clicking shows first 50 elements with `[i] <summary>  [▸ inspect]` (if reference)
    - Error: `<name>: <err:...>` (red)

Each reference expansion is a call to `captureField(parentKey, fieldName, autoKey)` then `inspectInstance(autoKey)` to get the child tree.

Depth tracking: `depth` parameter per row, used for indent styling.

**Copy-for-Claude**: top-right button `📋 Copy tree` → markdown of the current visible tree.

**Commit:** `feat(ui): inspector panel with navigable field tree and list expansion`

---

## Task 5: Diff Frida helper + module wiring

**Files:**
- Create: `src/rpc-agent/diff.ts`
- Modify: `src/rpc-agent/rpc-methods.ts`

**Implementation:**

```ts
// src/rpc-agent/diff.ts
import "frida-il2cpp-bridge";
import { stringifyValue } from "../lib";
import { getCapturedRaw } from "./registry";

/** Snapshot all non-static fields of a captured instance as a flat string-map. */
export function snapshotInstance(key: string): Promise<{ className: string; fields: Record<string, string> } | null> {
    return new Promise((resolve) => {
        Il2Cpp.perform(() => {
            const inst = getCapturedRaw(key);
            if (!inst) { resolve(null); return; }
            const fields: Record<string, string> = {};
            for (const f of inst.class.fields) {
                if (f.isStatic) continue;
                try {
                    fields[f.name] = stringifyValue(inst.field(f.name).value);
                } catch (e) {
                    fields[f.name] = `<err: ${String(e).slice(0, 60)}>`;
                }
            }
            resolve({ className: inst.class.name, fields });
        });
    });
}
```

Add to rpc-methods aggregator: `import * as diffRpc from "./diff"` + spread.

**Commit:** `feat(rpc): diff snapshot helper for captured instances`

---

## Task 6: Diff UI panel

**Files:**
- Create: `host/public/panels/diff.ts`
- Modify: `host/public/index.html` (add "diff" tab)
- Modify: `host/public/main.ts`

**Implementation (`diff.ts`, ~120 lines):**

Layout:
- Input: inspect key (default = last-captured)
- Two slots: `[ T0 snapshot ] — stored @ <ts>` / `[ T1 snapshot ] — stored @ <ts>`
- TAKE T0 button → `rpcCall("snapshotInstance", [key])`, stash in module-level
- TAKE T1 button → same, then compute diff
- Results table: `field | T0 | T1 | Δ`
  - Changed rows highlighted (amber background)
  - Sort toggle: "changed first" / "alphabetical"
- CLEAR button
- `📋 Copy diff for Claude` button → markdown table of changed rows only

Delta logic:
- If both numeric: show `+N` / `−N` with color
- If strings: show `"old" → "new"` in one cell
- If types differ or one is error: flag in Δ column

**Commit:** `feat(ui): diff panel with T0/T1 snapshots and changed-fields highlight`

---

## Task 7: Smoke test + tag

**Files:**
- Modify: `scripts/smoke.md`

Append:

```markdown
## M4 — Scanner + Inspector + Diff

Attach to FridaCobaye.exe, capture Player via hook (`Update`).

### Scanner
- [ ] In Scanner tab: type=int, value=5000 (or current health), assembly=Assembly-CSharp → SCAN
- [ ] Results list contains `Player.health = 5000` (and possibly other matches with same value)
- [ ] Change health in-game; click NEXT SCAN with new value → list narrows to Player.health only
- [ ] Click 📌 pin on `Player.health` candidate → appears in watchlist live
- [ ] CLEAR → results empty

### Inspector
- [ ] Switch to Inspector tab, key = `Player` → tree renders with all primitive fields visible
- [ ] Click 📌 on `health` primitive → added to watchlist
- [ ] Click ✎ on `gold`, set 12345 → value changes in-game and tree reflects
- [ ] If Player has a reference field (e.g. `_inventory`), click ▸ inspect → child tree appears below with auto-generated key
- [ ] If a List field exists, click ▸ expand → up to 50 elements listed

### Diff
- [ ] In Diff tab, key = `Player`, click TAKE T0 → T0 slot filled with timestamp
- [ ] In-game: change health (take damage / cheat) → click TAKE T1
- [ ] Diff table shows `health` with T0=100 T1=80 Δ=−20 highlighted amber
- [ ] Click "📋 Copy diff for Claude" → clipboard contains markdown table of changed rows only
```

**Tag:** `git tag -a m4-scanner-inspector-diff -m "M4 complete: scanner + inspector + diff"`

**Commit:** `docs: append m4 smoke checklist`

---

## Self-Review

**Spec coverage for M4:**
- "Memory scanner, IL2CPP-aware" → Task 1 (backend) + Task 2 (UI) ✓
- "Inspector tree navigable" → Task 3 + 4 ✓
- "Diff d'instances avant/après" → Task 5 + 6 ✓
- "📌 pin from scanner to watchlist" → Task 2 uses existing `pinField` RPC ✓
- "📋 Copy for Claude on inspector tree" → Task 4 ✓
- "📋 Copy diff for Claude" → Task 6 ✓

**Placeholder scan:** No "TODO"/"TBD". Every file has concrete instructions.

**File size targets:**
- `scanner.ts` (Frida) ≈ 100 lines. OK.
- `scanner.ts` (UI) ≈ 150 lines. OK.
- `inspector.ts` (Frida) ≈ 120 lines. OK.
- `inspector.ts` (UI) ≈ 200 lines. Slightly over the 200 target but justified by tree rendering with expand/collapse logic.
- `diff.ts` (Frida) ≈ 30 lines. OK.
- `diff.ts` (UI) ≈ 120 lines. OK.

**Known risks:**
- `Il2Cpp.gc.choose(klass)` is expensive on first call (walks managed heap). For large Assembly-CSharp, initial scan may take several seconds. Acceptable for M4; show a spinner during scan.
- `registry.setCaptured` may not already exist as a named export — Task 3 adds it if missing.
- Inspector re-render on tree expand mutates DOM incrementally, not full re-render. Risk: orphan listeners. The panel uses the same event-delegation pattern as instance.ts (container-level click listener scoped to the fresh-wrapper, dying on tab switch). Already the right pattern.
