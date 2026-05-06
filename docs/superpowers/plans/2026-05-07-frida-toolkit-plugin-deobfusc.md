# Plugin Deobfusc (v1.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Étendre le moteur de migration existant aux **fields** et **methods** pour que les renames survivent aux updates IL2CPP.

**Architecture:** Pas de nouveau plugin. On enrichit `ClassFingerprint` avec des entités structurées `FieldFingerprint[]` et `MethodFingerprint[]` (côté agent et côté core). On ajoute une passe 2 dans `matchFingerprints` qui, pour chaque classe auto-matchée, matche aussi ses fields (STRICT) et ses methods (LENIENT). Les routes accept/reject deviennent polymorphes (acceptent `LabelKey` au lieu de `oldObf` brut). L'UI Migrations est réécrite en 3 zones (REVIEW étalés, AUTO rollupés, LOST collapsed).

**Tech Stack:** TypeScript, Node.js, vitest (backend tests), supertest (route tests), vanilla TS + Vite (frontend), frida-il2cpp-bridge (agent VM).

**Spec source:** [docs/superpowers/specs/2026-05-07-frida-toolkit-plugin-deobfusc-design.md](docs/superpowers/specs/2026-05-07-frida-toolkit-plugin-deobfusc-design.md) (commit `9c8523e`)

---

## Task 1: Add `FieldFingerprint` and `MethodFingerprint` types

**Files:**
- Modify: `app/backend/core/types.ts:79-86` (replace `ClassFingerprint`)

- [ ] **Step 1: Replace ClassFingerprint definition**

In [app/backend/core/types.ts](app/backend/core/types.ts), replace lines 79-86 (the existing `ClassFingerprint` interface) with:

```typescript
export interface FieldFingerprint {
    obfName: string;
    typeName: string;
    declIndex: number;
    isStatic: boolean;
    isPublic: boolean;
}

export interface MethodFingerprint {
    obfName: string;
    token: string | null;
    paramTypes: string[];
    returnType: string;
    paramCount: number;
    declIndex: number;
    isStatic: boolean;
}

export interface ClassFingerprint {
    obfName: string;
    token: string | null;
    parents: string[];
    methodCount: number;
    fields: FieldFingerprint[];
    methods: MethodFingerprint[];
}
```

Note: this **removes** `methodSignatures: string[]` and `fieldTypes: string[]`. The migration engine and tests will be updated next to compute Jaccard from `fields` and `methods` directly.

- [ ] **Step 2: Run typecheck to capture every breakage**

Run: `cd app && npm run typecheck`
Expected: FAIL with errors in:
- `app/backend/core/migrations.ts` (uses `methodSignatures`, `fieldTypes`)
- `app/test/backend/core/migrations.test.ts` (constructs `ClassFingerprint` literals)
- `src/rpc-agent/fingerprints.ts` (still has its own copy — that's fine, it's the agent)

We will fix each of those in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add app/backend/core/types.ts
git commit -m "feat(deobfusc): add FieldFingerprint/MethodFingerprint types"
```

---

## Task 2: Update agent `fingerprints.ts` to emit new schema

**Files:**
- Modify: `src/rpc-agent/fingerprints.ts` (full file)

- [ ] **Step 1: Replace fingerprints.ts content**

Replace the entire content of [src/rpc-agent/fingerprints.ts](src/rpc-agent/fingerprints.ts) with:

```typescript
// Return ClassFingerprint[] for every class in every assembly.
// Used by the toolkit's migration engine at attach of a new build to
// match old labels against new obf names via structural similarity.

import "frida-il2cpp-bridge";

interface FieldFingerprint {
    obfName: string;
    typeName: string;
    declIndex: number;
    isStatic: boolean;
    isPublic: boolean;
}

interface MethodFingerprint {
    obfName: string;
    token: string | null;
    paramTypes: string[];
    returnType: string;
    paramCount: number;
    declIndex: number;
    isStatic: boolean;
}

interface ClassFingerprint {
    obfName: string;
    token: string | null;
    parents: string[];
    methodCount: number;
    fields: FieldFingerprint[];
    methods: MethodFingerprint[];
}

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

export function listClassFingerprints(): Promise<ClassFingerprint[]> {
    return inVm(() => {
        const out: ClassFingerprint[] = [];
        for (const asm of Il2Cpp.domain.assemblies) {
            for (const klass of asm.image.classes) {
                try {
                    out.push(fingerprint(klass));
                } catch {
                    // Some classes throw on inspection (generic instantiations,
                    // pointer types, etc.) — skip them rather than abort.
                }
            }
        }
        return out;
    });
}

function fingerprint(klass: Il2Cpp.Class): ClassFingerprint {
    const parents: string[] = [];
    if (klass.parent) parents.push(klass.parent.name);
    for (const iface of klass.interfaces) parents.push(iface.name);

    const fields: FieldFingerprint[] = [];
    let fieldIdx = 0;
    for (const f of klass.fields) {
        try {
            const flags = (f as unknown as { flags?: number }).flags ?? 0;
            fields.push({
                obfName: f.name,
                typeName: f.type.name,
                declIndex: fieldIdx,
                isStatic: !!(f as unknown as { isStatic?: boolean }).isStatic,
                isPublic: (flags & 0x0006) === 0x0006,
            });
        } catch {
            // skip unreadable field
        }
        fieldIdx++;
    }

    const methods: MethodFingerprint[] = [];
    let methodIdx = 0;
    for (const m of klass.methods) {
        try {
            const params = m.parameters.map((p) => p.type.name);
            const ret = m.returnType.name;
            const t = (m as unknown as { token?: number }).token;
            methods.push({
                obfName: m.name,
                token: typeof t === "number" ? "0x" + t.toString(16).toUpperCase() : null,
                paramTypes: params,
                returnType: ret,
                paramCount: params.length,
                declIndex: methodIdx,
                isStatic: !!(m as unknown as { isStatic?: boolean }).isStatic,
            });
        } catch {
            // skip
        }
        methodIdx++;
    }

    let token: string | null = null;
    try {
        const t = (klass as unknown as { token?: number }).token;
        if (typeof t === "number") {
            token = "0x" + t.toString(16).toUpperCase();
        }
    } catch {
        // leave null
    }

    return {
        obfName: klass.name,
        token,
        parents: parents.sort(),
        methodCount: klass.methods.length,
        fields,
        methods,
    };
}
```

- [ ] **Step 2: Verify the agent typechecks**

Run: `npx tsc --noEmit -p src/rpc-agent/tsconfig.json` (or whatever the agent's tsconfig is — fall back to `npm run build:agent` if that exists)
Expected: PASS

If the agent has no separate tsconfig, run the project-wide typecheck and ignore the still-failing core/migrations errors (they are fixed in Task 4):
Run: `cd app && npm run typecheck`
Expected: errors only in `app/backend/core/migrations.ts` and `app/test/backend/core/migrations.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/fingerprints.ts
git commit -m "feat(deobfusc): agent emits structured FieldFingerprint+MethodFingerprint"
```

---

## Task 3: Update existing migration tests to use new fingerprint shape

**Files:**
- Modify: `app/test/backend/core/migrations.test.ts:6-17`

- [ ] **Step 1: Replace the `cls` helper**

In [app/test/backend/core/migrations.test.ts](app/test/backend/core/migrations.test.ts), replace lines 6-17 (the `cls` helper) with:

```typescript
const cls = (
    obfName: string,
    overrides: Partial<ClassFingerprint> = {},
): ClassFingerprint => ({
    obfName,
    token: null,
    parents: [],
    methodCount: 0,
    fields: [],
    methods: [],
    ...overrides,
});

// Convert the old test helper format (fieldTypes: ["x:int"]) to
// FieldFingerprint[] for tests written before v1.3.
const fieldsFromTypes = (specs: string[]): import("../../../backend/core/types").FieldFingerprint[] =>
    specs.map((s, i) => {
        const [name, type] = s.split(":");
        return {
            obfName: name,
            typeName: type,
            declIndex: i,
            isStatic: false,
            isPublic: true,
        };
    });

// Convert ["a(int)int", "b(string)bool"] to MethodFingerprint[].
const methodsFromSigs = (sigs: string[]): import("../../../backend/core/types").MethodFingerprint[] =>
    sigs.map((sig, i) => {
        const m = sig.match(/^(\w+)\(([^)]*)\)(.+)$/);
        if (!m) throw new Error(`bad sig: ${sig}`);
        const [, name, paramsRaw, ret] = m;
        const paramTypes = paramsRaw === "" ? [] : paramsRaw.split(",");
        return {
            obfName: name,
            token: null,
            paramTypes,
            returnType: ret,
            paramCount: paramTypes.length,
            declIndex: i,
            isStatic: false,
        };
    });
```

- [ ] **Step 2: Update each test in the file to use the new shape**

In each `it(...)` block, replace `methodSignatures: ["a(int)int", ...]` with `methods: methodsFromSigs(["a(int)int", ...])`, and `fieldTypes: ["x:int", ...]` with `fields: fieldsFromTypes(["x:int", ...])`.

For example, the test starting at line 34 (`it("auto-migrates when fingerprint score is >= 0.95...")`) should have its `cls("egq", {...})` block changed to:

```typescript
cls("egq", {
    token: null,
    parents: ["base1"],
    methodCount: 17,
    methods: methodsFromSigs(["a(int)int", "b(string)bool", "c()void"]),
    fields: fieldsFromTypes(["x:int", "y:string"]),
})
```

Apply the equivalent replacement to all five tests in the file (lines 20-124 — the `cls(...)` calls inside each `it`).

- [ ] **Step 3: Run tests — they will fail because `migrations.ts` still references old fields**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts`
Expected: FAIL with errors about `methodSignatures`/`fieldTypes` undefined in `migrations.ts`.

- [ ] **Step 4: Commit**

```bash
git add app/test/backend/core/migrations.test.ts
git commit -m "test(deobfusc): update migration tests for new fingerprint shape"
```

---

## Task 4: Adapt `migrations.ts` Jaccard computation to new fingerprint shape (no behavior change)

**Files:**
- Modify: `app/backend/core/migrations.ts:103-114` (`similarity` function)

- [ ] **Step 1: Update the `similarity` function**

In [app/backend/core/migrations.ts](app/backend/core/migrations.ts), replace lines 103-114 (the `similarity` function body) with:

```typescript
export function similarity(a: ClassFingerprint, b: ClassFingerprint): number {
    const parentScore = jaccard(new Set(a.parents), new Set(b.parents));

    const mcDiff = Math.abs(a.methodCount - b.methodCount);
    const mcMax = Math.max(a.methodCount, b.methodCount, 1);
    const methodCountScore = Math.max(0, 1 - mcDiff / mcMax);

    const aMethodSigs = a.methods.map((m) => `${m.obfName}(${m.paramTypes.join(",")})→${m.returnType}`);
    const bMethodSigs = b.methods.map((m) => `${m.obfName}(${m.paramTypes.join(",")})→${m.returnType}`);
    const sigScore = jaccard(new Set(aMethodSigs), new Set(bMethodSigs));

    const aFieldKeys = a.fields.map((f) => `${f.obfName}:${f.typeName}`);
    const bFieldKeys = b.fields.map((f) => `${f.obfName}:${f.typeName}`);
    const fieldScore = jaccard(new Set(aFieldKeys), new Set(bFieldKeys));

    return parentScore * 0.20 + methodCountScore * 0.20 + sigScore * 0.30 + fieldScore * 0.30;
}
```

This is **purely a refactor** — produces the same numeric scores as before because we re-derive the same string-set keys.

- [ ] **Step 2: Run the existing migration tests — should now PASS**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Run full backend test suite to make sure nothing else broke**

Run: `cd app && npx vitest run test/backend`
Expected: PASS — no regression on the v1.2 baseline (~167 tests).

- [ ] **Step 4: Commit**

```bash
git add app/backend/core/migrations.ts
git commit -m "refactor(deobfusc): adapt similarity() to structured fingerprint fields"
```

---

## Task 5: Add new MigrationResult record types with `parentClassMigration`

**Files:**
- Modify: `app/backend/core/types.ts:88-92` (replace `MigrationResult`)

- [ ] **Step 1: Replace MigrationResult definition**

In [app/backend/core/types.ts](app/backend/core/types.ts), replace lines 88-92 (the existing `MigrationResult`) with:

```typescript
export interface MigrationAutoRecord {
    key: LabelKey;
    oldObf: string;
    newObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

export interface MigrationReviewRecord {
    key: LabelKey;
    oldObf: string;
    candidates: Array<{ newObf: string; score: number; reason: string }>;
    label: string;
    parentClassMigration?: string;
}

export interface MigrationLostRecord {
    key: LabelKey;
    oldObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

export interface MigrationResult {
    auto: MigrationAutoRecord[];
    review: MigrationReviewRecord[];
    lost: MigrationLostRecord[];
}
```

- [ ] **Step 2: Run typecheck to confirm no breakage**

Run: `cd app && npm run typecheck`
Expected: PASS — the existing fields (`key`, `oldObf`, etc.) are preserved, and `parentClassMigration` is optional.

- [ ] **Step 3: Commit**

```bash
git add app/backend/core/types.ts
git commit -m "feat(deobfusc): add MigrationResult record types with parentClassMigration"
```

---

## Task 6: Implement `matchClassMembers` — pure function for fields+methods of one class pair

**Files:**
- Modify: `app/backend/core/migrations.ts` (append at end of file)
- Test: `app/test/backend/core/migrations.test.ts` (append new `describe` block)

- [ ] **Step 1: Write failing tests for fields STRICT**

Append to [app/test/backend/core/migrations.test.ts](app/test/backend/core/migrations.test.ts) at the end of the file:

```typescript
import { matchClassMembers } from "../../../backend/core/migrations";

describe("matchClassMembers — fields (STRICT)", () => {
    const oldCls = cls("oldA", {
        fields: [
            { obfName: "emjv", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
            { obfName: "emkh", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
            { obfName: "emkj", typeName: "System.Int32", declIndex: 2, isStatic: false, isPublic: true },
        ],
    });

    it("AUTO when type is unique on both sides", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "aaa", typeName: "System.Int64", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "bbb", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
                { obfName: "ccc", typeName: "System.Int64", declIndex: 2, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(oldCls, newCls, {}, { "oldA.emkh": "userName" });
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].key).toEqual({ kind: "field", className: "newA", fieldName: "bbb" });
        expect(result.auto[0].reason).toContain("unique type match");
        expect(result.auto[0].parentClassMigration).toBe("oldA");
    });

    it("AUTO when type N×N with declIndex aligned (type+ordinal)", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "p", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "q", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
                { obfName: "r", typeName: "System.Int32", declIndex: 2, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(
            oldCls,
            newCls,
            {},
            { "oldA.emjv": "playerId", "oldA.emkj": "mapId" },
        );
        expect(result.auto).toHaveLength(2);
        const playerIdRec = result.auto.find((r) => r.label === "playerId")!;
        expect(playerIdRec.key).toEqual({ kind: "field", className: "newA", fieldName: "p" });
        expect(playerIdRec.reason).toContain("type+ordinal");
        const mapIdRec = result.auto.find((r) => r.label === "mapId")!;
        expect(mapIdRec.key).toEqual({ kind: "field", className: "newA", fieldName: "r" });
    });

    it("REVIEW when type count changes (N != M)", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "a", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "b", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
                { obfName: "c", typeName: "System.Int32", declIndex: 2, isStatic: false, isPublic: true },
                { obfName: "d", typeName: "System.Int32", declIndex: 3, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(oldCls, newCls, {}, { "oldA.emjv": "playerId" });
        expect(result.review).toHaveLength(1);
        expect(result.review[0].candidates.length).toBeGreaterThanOrEqual(2);
        expect(result.review[0].candidates.length).toBeLessThanOrEqual(5);
        expect(result.review[0].candidates[0].reason).toContain("type System.Int32 count changed");
    });

    it("LOST when type disappears", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "x", typeName: "System.Single", declIndex: 0, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(oldCls, newCls, {}, { "oldA.emjv": "playerId" });
        expect(result.lost).toHaveLength(1);
        expect(result.lost[0].reason).toContain("type System.Int32 disappeared");
        expect(result.lost[0].parentClassMigration).toBe("oldA");
    });
});
```

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts`
Expected: FAIL — `matchClassMembers is not defined`.

- [ ] **Step 2: Implement `matchClassMembers` — fields STRICT half**

Append to [app/backend/core/migrations.ts](app/backend/core/migrations.ts):

```typescript
import type {
    FieldFingerprint,
    MethodFingerprint,
    MigrationAutoRecord,
    MigrationReviewRecord,
    MigrationLostRecord,
} from "./types";

export interface ClassMembersResult {
    auto: MigrationAutoRecord[];
    review: MigrationReviewRecord[];
    lost: MigrationLostRecord[];
}

/**
 * Match the fields and methods of one already-paired (old, new) class.
 * Pure function — no I/O.
 *
 * @param oldCls           The old class fingerprint (the one labels were created against).
 * @param newCls           The new class fingerprint (the migration target).
 * @param oldMethodLabels  Method labels keyed by `${oldClsObf}.${methodObf}`.
 * @param oldFieldLabels   Field labels keyed by `${oldClsObf}.${fieldObf}`.
 */
export function matchClassMembers(
    oldCls: ClassFingerprint,
    newCls: ClassFingerprint,
    oldMethodLabels: Record<string, string>,
    oldFieldLabels: Record<string, string>,
): ClassMembersResult {
    const result: ClassMembersResult = { auto: [], review: [], lost: [] };
    matchFieldsStrict(oldCls, newCls, oldFieldLabels, result);
    matchMethodsLenient(oldCls, newCls, oldMethodLabels, result);
    return result;
}

function matchFieldsStrict(
    oldCls: ClassFingerprint,
    newCls: ClassFingerprint,
    oldFieldLabels: Record<string, string>,
    out: ClassMembersResult,
): void {
    // Pre-bucket new fields by typeName for fast lookups.
    const newByType = new Map<string, FieldFingerprint[]>();
    for (const f of newCls.fields) {
        const list = newByType.get(f.typeName) ?? [];
        list.push(f);
        newByType.set(f.typeName, list);
    }
    // Sort each bucket by declIndex so type+ordinal alignment is deterministic.
    for (const list of newByType.values()) list.sort((a, b) => a.declIndex - b.declIndex);

    // Same on the old side.
    const oldByType = new Map<string, FieldFingerprint[]>();
    for (const f of oldCls.fields) {
        const list = oldByType.get(f.typeName) ?? [];
        list.push(f);
        oldByType.set(f.typeName, list);
    }
    for (const list of oldByType.values()) list.sort((a, b) => a.declIndex - b.declIndex);

    for (const oldField of oldCls.fields) {
        const compoundKey = `${oldCls.obfName}.${oldField.obfName}`;
        const label = oldFieldLabels[compoundKey];
        if (!label) continue;

        const key = { kind: "field" as const, className: newCls.obfName, fieldName: "" };
        const oldsOfType = oldByType.get(oldField.typeName) ?? [];
        const newsOfType = newByType.get(oldField.typeName) ?? [];

        // Rule 1: type unique on both sides
        if (oldsOfType.length === 1 && newsOfType.length === 1) {
            out.auto.push({
                key: { kind: "field", className: newCls.obfName, fieldName: newsOfType[0].obfName },
                oldObf: compoundKey,
                newObf: `${newCls.obfName}.${newsOfType[0].obfName}`,
                label,
                reason: `unique type match (${oldField.typeName})`,
                parentClassMigration: oldCls.obfName,
            });
            continue;
        }

        // Rule 2: type N×N with same position-within-type-group
        if (oldsOfType.length === newsOfType.length && oldsOfType.length > 1) {
            const oldPosInGroup = oldsOfType.findIndex((f) => f.obfName === oldField.obfName);
            const newField = newsOfType[oldPosInGroup];
            if (newField) {
                out.auto.push({
                    key: { kind: "field", className: newCls.obfName, fieldName: newField.obfName },
                    oldObf: compoundKey,
                    newObf: `${newCls.obfName}.${newField.obfName}`,
                    label,
                    reason: `type+ordinal match (position ${oldPosInGroup} of type ${oldField.typeName})`,
                    parentClassMigration: oldCls.obfName,
                });
                continue;
            }
        }

        // Rule 3: type disappeared
        if (newsOfType.length === 0) {
            out.lost.push({
                key,
                oldObf: compoundKey,
                label,
                reason: `type ${oldField.typeName} disappeared`,
                parentClassMigration: oldCls.obfName,
            });
            continue;
        }

        // Rule 4: REVIEW with candidates sorted by |declIndex - oldDeclIndex|
        const candidates = newsOfType
            .slice()
            .sort(
                (a, b) =>
                    Math.abs(a.declIndex - oldField.declIndex) -
                    Math.abs(b.declIndex - oldField.declIndex),
            )
            .slice(0, 5)
            .map((f) => ({
                newObf: `${newCls.obfName}.${f.obfName}`,
                score: 1 - Math.abs(f.declIndex - oldField.declIndex) / Math.max(oldCls.fields.length, newCls.fields.length, 1),
                reason: `type ${oldField.typeName} count changed (old=${oldsOfType.length}, new=${newsOfType.length})`,
            }));
        out.review.push({
            key,
            oldObf: compoundKey,
            candidates,
            label,
            parentClassMigration: oldCls.obfName,
        });
    }
}

function matchMethodsLenient(
    _oldCls: ClassFingerprint,
    _newCls: ClassFingerprint,
    _oldMethodLabels: Record<string, string>,
    _out: ClassMembersResult,
): void {
    // Filled in Task 7. Empty for now to keep field tests passing.
}
```

- [ ] **Step 3: Run field tests**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts -t "fields (STRICT)"`
Expected: PASS — all 4 field tests green.

- [ ] **Step 4: Run full migration test file to confirm no regression**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts`
Expected: PASS — 9 tests (5 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/migrations.ts app/test/backend/core/migrations.test.ts
git commit -m "feat(deobfusc): matchClassMembers — STRICT field matching"
```

---

## Task 7: Method matching LENIENT (cascade: token → exact sig → sig-no-name → score)

**Files:**
- Modify: `app/backend/core/migrations.ts` (`matchMethodsLenient` body)
- Test: `app/test/backend/core/migrations.test.ts` (append new `describe` block)

- [ ] **Step 1: Write failing tests for methods LENIENT**

Append to [app/test/backend/core/migrations.test.ts](app/test/backend/core/migrations.test.ts):

```typescript
describe("matchClassMembers — methods (LENIENT)", () => {
    const mkMethod = (overrides: Partial<import("../../../backend/core/types").MethodFingerprint> = {}): import("../../../backend/core/types").MethodFingerprint => ({
        obfName: "x",
        token: null,
        paramTypes: [],
        returnType: "System.Void",
        paramCount: 0,
        declIndex: 0,
        isStatic: false,
        ...overrides,
    });

    it("AUTO when token matches", () => {
        const oldCls = cls("oldA", { methods: [mkMethod({ obfName: "vto", token: "0x600A1B2" })] });
        const newCls = cls("newA", { methods: [mkMethod({ obfName: "abc", token: "0x600A1B2" })] });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].key).toEqual({ kind: "method", className: "newA", methodName: "abc" });
        expect(result.auto[0].reason).toBe("token match");
    });

    it("AUTO when full signature exact + name preserved + unique", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "Encode", paramTypes: ["int", "string"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "Encode", paramTypes: ["int", "string"], returnType: "void" }),
                mkMethod({ obfName: "Other", paramTypes: ["bool"], returnType: "void", declIndex: 1 }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.Encode": "encode" }, {});
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].reason).toContain("exact signature, name preserved");
    });

    it("AUTO when signature without name is unique", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "vto", paramTypes: ["int", "string"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "abc", paramTypes: ["int", "string"], returnType: "void" }),
                mkMethod({ obfName: "def", paramTypes: ["bool"], returnType: "void", declIndex: 1 }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].key).toEqual({ kind: "method", className: "newA", methodName: "abc" });
        expect(result.auto[0].reason).toContain("signature match, renamed method");
    });

    it("REVIEW when score 0.60-0.95 (multiple candidates)", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "vto", paramTypes: ["int", "int"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "a", paramTypes: ["int", "long"], returnType: "void" }),
                mkMethod({ obfName: "b", paramTypes: ["long", "int"], returnType: "void", declIndex: 1 }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.review.length).toBeGreaterThanOrEqual(1);
        expect(result.review[0].candidates.length).toBeGreaterThanOrEqual(1);
    });

    it("LOST when no candidate >= 0.60", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "vto", paramTypes: ["int", "int", "int"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "a", paramTypes: ["string"], returnType: "bool" }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.lost).toHaveLength(1);
        expect(result.lost[0].reason).toContain("no candidate above 0.60");
    });
});
```

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts -t "methods (LENIENT)"`
Expected: FAIL (5 tests, all matched to LOST in current empty implementation, or all wrong shape).

- [ ] **Step 2: Implement `matchMethodsLenient`**

In [app/backend/core/migrations.ts](app/backend/core/migrations.ts), replace the empty `matchMethodsLenient` body with:

```typescript
function matchMethodsLenient(
    oldCls: ClassFingerprint,
    newCls: ClassFingerprint,
    oldMethodLabels: Record<string, string>,
    out: ClassMembersResult,
): void {
    for (const oldMethod of oldCls.methods) {
        const compoundKey = `${oldCls.obfName}.${oldMethod.obfName}`;
        const label = oldMethodLabels[compoundKey];
        if (!label) continue;

        const key = { kind: "method" as const, className: newCls.obfName, methodName: "" };

        // Rule 1: token match
        if (oldMethod.token) {
            const tokMatches = newCls.methods.filter((m) => m.token === oldMethod.token);
            if (tokMatches.length === 1) {
                out.auto.push({
                    key: { kind: "method", className: newCls.obfName, methodName: tokMatches[0].obfName },
                    oldObf: compoundKey,
                    newObf: `${newCls.obfName}.${tokMatches[0].obfName}`,
                    label,
                    reason: "token match",
                    parentClassMigration: oldCls.obfName,
                });
                continue;
            }
        }

        // Rule 2: exact signature + name preserved, unique
        const exactNamed = newCls.methods.filter(
            (m) =>
                m.obfName === oldMethod.obfName &&
                m.returnType === oldMethod.returnType &&
                arraysEqual(m.paramTypes, oldMethod.paramTypes),
        );
        if (exactNamed.length === 1) {
            out.auto.push({
                key: { kind: "method", className: newCls.obfName, methodName: exactNamed[0].obfName },
                oldObf: compoundKey,
                newObf: `${newCls.obfName}.${exactNamed[0].obfName}`,
                label,
                reason: "exact signature, name preserved",
                parentClassMigration: oldCls.obfName,
            });
            continue;
        }

        // Rule 3: exact signature without name, unique
        const exactUnnamed = newCls.methods.filter(
            (m) =>
                m.returnType === oldMethod.returnType &&
                arraysEqual(m.paramTypes, oldMethod.paramTypes),
        );
        if (exactUnnamed.length === 1) {
            out.auto.push({
                key: { kind: "method", className: newCls.obfName, methodName: exactUnnamed[0].obfName },
                oldObf: compoundKey,
                newObf: `${newCls.obfName}.${exactUnnamed[0].obfName}`,
                label,
                reason: "signature match, renamed method",
                parentClassMigration: oldCls.obfName,
            });
            continue;
        }

        // Rule 4: structural score
        const scored = newCls.methods
            .map((m) => ({ m, score: methodSimilarity(oldMethod, m) }))
            .filter((c) => c.score >= 0.60)
            .sort((a, b) => b.score - a.score);

        if (scored.length === 0) {
            out.lost.push({
                key,
                oldObf: compoundKey,
                label,
                reason: "no candidate above 0.60 similarity",
                parentClassMigration: oldCls.obfName,
            });
            continue;
        }

        const top = scored[0];
        const second = scored[1];
        if (top.score >= 0.95 && (!second || top.score - second.score >= 0.10)) {
            out.auto.push({
                key: { kind: "method", className: newCls.obfName, methodName: top.m.obfName },
                oldObf: compoundKey,
                newObf: `${newCls.obfName}.${top.m.obfName}`,
                label,
                reason: `unique structural match (score=${top.score.toFixed(3)})`,
                parentClassMigration: oldCls.obfName,
            });
        } else {
            out.review.push({
                key,
                oldObf: compoundKey,
                candidates: scored.slice(0, 5).map((c) => ({
                    newObf: `${newCls.obfName}.${c.m.obfName}`,
                    score: c.score,
                    reason: `structural similarity ${c.score.toFixed(3)}`,
                })),
                label,
                parentClassMigration: oldCls.obfName,
            });
        }
    }
}

function methodSimilarity(a: MethodFingerprint, b: MethodFingerprint): number {
    const cntDiff = Math.abs(a.paramCount - b.paramCount);
    const cntMax = Math.max(a.paramCount, b.paramCount, 1);
    const paramCountScore = Math.max(0, 1 - cntDiff / cntMax);

    const paramJaccard = jaccard(new Set(a.paramTypes), new Set(b.paramTypes));
    const returnScore = a.returnType === b.returnType ? 1 : 0;

    return paramCountScore * 0.4 + paramJaccard * 0.4 + returnScore * 0.2;
}

function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
```

- [ ] **Step 3: Run method tests**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts -t "methods (LENIENT)"`
Expected: PASS — 5 tests green.

- [ ] **Step 4: Run all migration tests**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts`
Expected: PASS — 14 tests (5 original + 4 fields + 5 methods).

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/migrations.ts app/test/backend/core/migrations.test.ts
git commit -m "feat(deobfusc): matchClassMembers — LENIENT method matching"
```

---

## Task 8: Wire pass 2 into `matchFingerprints` for AUTO classes

**Files:**
- Modify: `app/backend/core/migrations.ts:18-93` (`matchFingerprints` function)
- Test: `app/test/backend/core/migrations.test.ts` (append integration tests)

- [ ] **Step 1: Write failing tests for the integration**

Append to [app/test/backend/core/migrations.test.ts](app/test/backend/core/migrations.test.ts):

```typescript
describe("matchFingerprints — pass 2 (auto classes get fields/methods migrated)", () => {
    it("emits field+method records for an auto-migrated class", () => {
        const oldA = cls("oldA", {
            token: "0x100",
            methodCount: 1,
            methods: methodsFromSigs(["v(int)void"]),
            fields: fieldsFromTypes(["a:System.Int32"]),
        });
        const newA = cls("newA", {
            token: "0x100",
            methodCount: 1,
            methods: methodsFromSigs(["w(int)void"]),
            fields: fieldsFromTypes(["b:System.Int32"]),
        });
        const result = matchFingerprints({
            oldFps: [oldA],
            newFps: [newA],
            oldLabels: { oldA: "Encoder" },
            oldMethodLabels: { "oldA.v": "encodeInt" },
            oldFieldLabels: { "oldA.a": "playerId" },
        });
        expect(result.auto.find((r) => r.key.kind === "class" && r.label === "Encoder")).toBeDefined();
        expect(result.auto.find((r) => r.key.kind === "method" && r.label === "encodeInt")).toBeDefined();
        expect(result.auto.find((r) => r.key.kind === "field" && r.label === "playerId")).toBeDefined();
    });

    it("does NOT emit member records for a class in REVIEW (suspended)", () => {
        const oldA = cls("oldA", {
            methodCount: 5,
            methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "e()void"]),
            fields: fieldsFromTypes(["x:int"]),
        });
        const newA = cls("aaa", {
            methodCount: 5,
            methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "e()void"]),
            fields: fieldsFromTypes(["x:long"]),
        });
        const newB = cls("bbb", {
            methodCount: 5,
            methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "f()void"]),
            fields: fieldsFromTypes(["x:int"]),
        });
        const result = matchFingerprints({
            oldFps: [oldA],
            newFps: [newA, newB],
            oldLabels: { oldA: "ClassA" },
            oldMethodLabels: { "oldA.a": "method_a" },
            oldFieldLabels: { "oldA.x": "fieldX" },
        });
        // Class is in REVIEW — no member records yet
        expect(result.review.length).toBe(1);
        expect(result.auto.filter((r) => r.key.kind === "method")).toHaveLength(0);
        expect(result.auto.filter((r) => r.key.kind === "field")).toHaveLength(0);
    });

    it("cascades fields/methods to LOST when their parent class is LOST", () => {
        const oldA = cls("oldA", {
            methodCount: 17,
            methods: methodsFromSigs(["specific()void"]),
            fields: fieldsFromTypes(["uniqueField:int"]),
        });
        const newA = cls("aaa", {
            methodCount: 1,
            methods: methodsFromSigs(["totally_different()void"]),
            fields: fieldsFromTypes(["other:string"]),
        });
        const result = matchFingerprints({
            oldFps: [oldA],
            newFps: [newA],
            oldLabels: { oldA: "ClassA" },
            oldMethodLabels: { "oldA.specific": "specificLabel" },
            oldFieldLabels: { "oldA.uniqueField": "fieldLabel" },
        });
        expect(result.lost.length).toBe(3); // class + method + field
        const memberLost = result.lost.filter((r) => r.key.kind !== "class");
        expect(memberLost).toHaveLength(2);
        expect(memberLost.every((r) => r.reason.includes("parent class lost"))).toBe(true);
    });
});
```

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts -t "pass 2"`
Expected: FAIL — `oldMethodLabels` / `oldFieldLabels` not in MatchInput, and pass 2 not wired.

- [ ] **Step 2: Extend `MatchInput` and wire pass 2**

In [app/backend/core/migrations.ts](app/backend/core/migrations.ts), update the `MatchInput` interface (lines 19-23):

```typescript
export interface MatchInput {
    oldFps: ClassFingerprint[];
    newFps: ClassFingerprint[];
    oldLabels: Record<string, string>;
    /** Method labels keyed by `${classObf}.${methodObf}`. Optional, defaults to {}. */
    oldMethodLabels?: Record<string, string>;
    /** Field labels keyed by `${classObf}.${fieldObf}`. Optional, defaults to {}. */
    oldFieldLabels?: Record<string, string>;
}
```

In the `matchFingerprints` function body (around line 28+), add at the very top after line 30 (`const result: MigrationResult = ...`):

```typescript
const oldMethodLabels = input.oldMethodLabels ?? {};
const oldFieldLabels = input.oldFieldLabels ?? {};
```

Build a lookup of new fingerprints by obf name (used by pass 2 to find the matched class):

```typescript
const newByObf = new Map<string, ClassFingerprint>();
for (const fp of newFps) newByObf.set(fp.obfName, fp);
```

Then, after the AUTO push for a class (both in the token-match branch around line 46, and in the score-match branch around line 73), call pass 2 inline. Replace the whole `matchFingerprints` body with this version that integrates pass 2:

```typescript
export function matchFingerprints(input: MatchInput): MigrationResult {
    const { oldFps, newFps, oldLabels } = input;
    const oldMethodLabels = input.oldMethodLabels ?? {};
    const oldFieldLabels = input.oldFieldLabels ?? {};
    const result: MigrationResult = { auto: [], review: [], lost: [] };

    const newByToken = new Map<string, ClassFingerprint>();
    for (const fp of newFps) {
        if (fp.token) newByToken.set(fp.token, fp);
    }
    const newByObf = new Map<string, ClassFingerprint>();
    for (const fp of newFps) newByObf.set(fp.obfName, fp);

    const runPass2 = (oldCls: ClassFingerprint, newCls: ClassFingerprint): void => {
        const sub = matchClassMembers(oldCls, newCls, oldMethodLabels, oldFieldLabels);
        result.auto.push(...sub.auto);
        result.review.push(...sub.review);
        result.lost.push(...sub.lost);
    };

    const cascadeLost = (oldCls: ClassFingerprint, reason: string): void => {
        for (const [k, label] of Object.entries(oldMethodLabels)) {
            if (k.startsWith(oldCls.obfName + ".")) {
                const methodName = k.slice(oldCls.obfName.length + 1);
                result.lost.push({
                    key: { kind: "method", className: oldCls.obfName, methodName },
                    oldObf: k,
                    label,
                    reason,
                    parentClassMigration: oldCls.obfName,
                });
            }
        }
        for (const [k, label] of Object.entries(oldFieldLabels)) {
            if (k.startsWith(oldCls.obfName + ".")) {
                const fieldName = k.slice(oldCls.obfName.length + 1);
                result.lost.push({
                    key: { kind: "field", className: oldCls.obfName, fieldName },
                    oldObf: k,
                    label,
                    reason,
                    parentClassMigration: oldCls.obfName,
                });
            }
        }
    };

    for (const oldFp of oldFps) {
        const label = oldLabels[oldFp.obfName];
        if (!label) continue;

        const key: LabelKey = { kind: "class", className: oldFp.obfName };

        if (oldFp.token) {
            const tokMatch = newByToken.get(oldFp.token);
            if (tokMatch) {
                result.auto.push({
                    key, label,
                    oldObf: oldFp.obfName,
                    newObf: tokMatch.obfName,
                    reason: `token match (${oldFp.token})`,
                });
                runPass2(oldFp, tokMatch);
                continue;
            }
        }

        const candidates = newFps
            .map((newFp) => ({ newFp, score: similarity(oldFp, newFp) }))
            .filter((c) => c.score >= REVIEW_THRESHOLD)
            .sort((a, b) => b.score - a.score);

        if (candidates.length === 0) {
            result.lost.push({
                key, label,
                oldObf: oldFp.obfName,
                reason: "no candidate above 0.60 similarity",
            });
            cascadeLost(oldFp, `parent class lost: ${oldFp.obfName}`);
            continue;
        }

        const top = candidates[0];
        const second = candidates[1];

        if (top.score >= AUTO_THRESHOLD && (!second || top.score - second.score >= 0.10)) {
            result.auto.push({
                key, label,
                oldObf: oldFp.obfName,
                newObf: top.newFp.obfName,
                reason: `unique structural match (score=${top.score.toFixed(3)})`,
            });
            runPass2(oldFp, top.newFp);
        } else {
            result.review.push({
                key, label,
                oldObf: oldFp.obfName,
                candidates: candidates.slice(0, 5).map((c) => ({
                    newObf: c.newFp.obfName,
                    score: c.score,
                    reason: `structural similarity ${c.score.toFixed(3)}`,
                })),
            });
            // Members suspended — not emitted yet. Routes will trigger pass 2 on accept.
        }
    }

    return result;
}
```

(The `cascadeLost` helper is also used for the new "REVIEW class rejected → cascade" path in routes — but in `matchFingerprints` it's only used for LOST classes.)

- [ ] **Step 3: Run pass-2 integration tests**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts -t "pass 2"`
Expected: PASS — 3 tests green.

- [ ] **Step 4: Run full file**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/migrations.ts app/test/backend/core/migrations.test.ts
git commit -m "feat(deobfusc): wire pass 2 into matchFingerprints (auto + cascade lost)"
```

---

## Task 9: Extend `loadProfileLabels` to expose method+field labels

**Files:**
- Modify: `app/backend/core/profile.ts:159-174`
- Test: `app/test/backend/core/profile.test.ts` (append test if file exists; otherwise inline in profile.test.ts)

- [ ] **Step 1: Add load methods for method+field labels**

In [app/backend/core/profile.ts](app/backend/core/profile.ts), replace lines 159-174 (the existing `loadProfileLabels`) with:

```typescript
async loadProfileLabels(gameName: string, buildId: string): Promise<Record<string, string>> {
    const data = await this.readLabelsFile(gameName, buildId);
    const out: Record<string, string> = {};
    for (const [obf, entry] of Object.entries(data.classes ?? {})) {
        out[obf] = entry.label;
    }
    return out;
}

async loadProfileMethodLabels(gameName: string, buildId: string): Promise<Record<string, string>> {
    const data = await this.readLabelsFile(gameName, buildId);
    const out: Record<string, string> = {};
    for (const [k, entry] of Object.entries(data.methods ?? {})) {
        out[k] = entry.label;
    }
    return out;
}

async loadProfileFieldLabels(gameName: string, buildId: string): Promise<Record<string, string>> {
    const data = await this.readLabelsFile(gameName, buildId);
    const out: Record<string, string> = {};
    for (const [k, entry] of Object.entries(data.fields ?? {})) {
        out[k] = entry.label;
    }
    return out;
}

private async readLabelsFile(gameName: string, buildId: string): Promise<{
    classes?: Record<string, { label: string }>;
    methods?: Record<string, { label: string }>;
    fields?: Record<string, { label: string }>;
}> {
    const labelsPath = path.join(this.profilesRoot, gameName, buildId, "labels.json");
    if (!fs.existsSync(labelsPath)) return {};
    try {
        return JSON.parse(await fs.promises.readFile(labelsPath, "utf-8"));
    } catch {
        return {};
    }
}
```

- [ ] **Step 2: Run typecheck and existing tests**

Run: `cd app && npm run typecheck`
Expected: PASS

Run: `cd app && npx vitest run test/backend/core/profile.test.ts`
Expected: PASS — existing tests untouched.

- [ ] **Step 3: Commit**

```bash
git add app/backend/core/profile.ts
git commit -m "feat(deobfusc): expose loadProfileMethodLabels + loadProfileFieldLabels"
```

---

## Task 10: Wire method+field labels into Session.attach migration call

**Files:**
- Modify: `app/backend/session.ts:117-132`

- [ ] **Step 1: Update the migration block**

In [app/backend/session.ts](app/backend/session.ts), replace lines 117-132 (the migration block inside `_doAttach`) with:

```typescript
// Run migrations when the profile was freshly derived from a previous build.
if (isNewProfile && profile.manifest.derivedFrom) {
    const previousBuildId = profile.manifest.derivedFrom.split("/")[1];
    const oldFps = await this.profileManager.loadFingerprints(gameName, previousBuildId);
    if (oldFps && currentFps.length > 0) {
        const oldLabels = await this.profileManager.loadProfileLabels(gameName, previousBuildId);
        const oldMethodLabels = await this.profileManager.loadProfileMethodLabels(gameName, previousBuildId);
        const oldFieldLabels = await this.profileManager.loadProfileFieldLabels(gameName, previousBuildId);
        const result = matchFingerprints({
            oldFps,
            newFps: currentFps,
            oldLabels,
            oldMethodLabels,
            oldFieldLabels,
        });
        for (const m of result.auto) {
            profile.labels.set(m.key, m.label);
        }
        await profile.labels.flush();
        this.currentMigrations = { result, oldFps, currentFps };
    }
}
```

Note: `profile.labels.set(m.key, m.label)` works for all three kinds — `LabelKey` is polymorphic.

- [ ] **Step 2: Run typecheck**

Run: `cd app && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run full backend tests**

Run: `cd app && npx vitest run test/backend`
Expected: PASS — no regression.

- [ ] **Step 4: Commit**

```bash
git add app/backend/session.ts
git commit -m "feat(deobfusc): wire method+field label migration in Session.attach"
```

---

## Task 11: Routes — polymorphic accept (LabelKey payload + backward-compat alias)

**Files:**
- Modify: `app/backend/routes/migrations.ts:14-34`
- Test: `app/test/backend/routes-migrations.test.ts`

- [ ] **Step 1: Write failing tests for polymorphic accept**

Append to [app/test/backend/routes-migrations.test.ts](app/test/backend/routes-migrations.test.ts):

```typescript
describe("migrations routes — polymorphic accept", () => {
    function makeFakeSessionPoly(reviewItems: any[]) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-poly-"));
        const labelStore = new LabelStore(path.join(tmpDir, "labels.json"));
        const profile: any = { labels: labelStore };
        const migrations = { result: { auto: [], review: reviewItems, lost: [] } };
        return {
            profile: () => profile,
            migrations: () => migrations,
            labelStore,
        };
    }

    it("accepts a field key and writes the label under {kind:field}", async () => {
        const session = makeFakeSessionPoly([
            {
                key: { kind: "field", className: "newCls", fieldName: "" },
                label: "playerId",
                oldObf: "oldCls.emjv",
                candidates: [
                    { newObf: "newCls.aaa", score: 0.9, reason: "type+ordinal" },
                    { newObf: "newCls.bbb", score: 0.7, reason: "..." },
                ],
                parentClassMigration: "oldCls",
            },
        ]);
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({
                key: { kind: "field", className: "newCls", fieldName: "aaa" },
                oldObf: "oldCls.emjv",
            });
        expect(res.status).toBe(200);
        expect(session.labelStore.get({ kind: "field", className: "newCls", fieldName: "aaa" })).toBe("playerId");
        const m = session.migrations()!;
        expect(m.result.review).toHaveLength(0);
        expect(m.result.auto).toHaveLength(1);
    });

    it("accepts a method key", async () => {
        const session = makeFakeSessionPoly([
            {
                key: { kind: "method", className: "newCls", methodName: "" },
                label: "encode",
                oldObf: "oldCls.vto",
                candidates: [{ newObf: "newCls.abc", score: 0.95, reason: "..." }],
                parentClassMigration: "oldCls",
            },
        ]);
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({
                key: { kind: "method", className: "newCls", methodName: "abc" },
                oldObf: "oldCls.vto",
            });
        expect(res.status).toBe(200);
        expect(session.labelStore.get({ kind: "method", className: "newCls", methodName: "abc" })).toBe("encode");
    });

    it("backward-compat: oldObf+newObf payload still accepted (assumed class)", async () => {
        const session = makeFakeSessionPoly([
            {
                key: { kind: "class", className: "ecu" },
                label: "OldClass",
                oldObf: "ecu",
                candidates: [{ newObf: "egq", score: 0.92, reason: "..." }],
            },
        ]);
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({ oldObf: "ecu", newObf: "egq" });
        expect(res.status).toBe(200);
        expect(session.labelStore.get({ kind: "class", className: "egq" })).toBe("OldClass");
    });
});
```

Run: `cd app && npx vitest run test/backend/routes-migrations.test.ts`
Expected: FAIL — first two tests get 400 (current handler only accepts `{oldObf, newObf}`).

- [ ] **Step 2: Rewrite the accept handler**

In [app/backend/routes/migrations.ts](app/backend/routes/migrations.ts), replace lines 14-34 (the `accept` handler) with:

```typescript
app.post("/api/migrations/accept", async (req, res) => {
    const p = deps.session.profile();
    const m = deps.session.migrations();
    if (!p || !m) { res.status(503).json({ error: "no migrations or no profile" }); return; }

    // Accept either:
    //   v1.3 polymorphic: { key: LabelKey, oldObf: string }
    //   v1.2 legacy:      { oldObf: string, newObf: string }   (assumed class)
    const body = req.body ?? {};
    let key: LabelKey;
    let oldObf: string;
    if (body.key && typeof body.oldObf === "string") {
        key = body.key as LabelKey;
        oldObf = body.oldObf;
    } else if (typeof body.oldObf === "string" && typeof body.newObf === "string") {
        key = { kind: "class", className: body.newObf };
        oldObf = body.oldObf;
    } else {
        res.status(400).json({ error: "expected {key,oldObf} or {oldObf,newObf}" });
        return;
    }

    const idx = m.result.review.findIndex((r) => r.oldObf === oldObf);
    if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
    const entry = m.result.review[idx];

    p.labels.set(key, entry.label);
    p.labels.scheduleFlush();
    m.result.review.splice(idx, 1);

    // Compute newObf for the AUTO record
    const newObf =
        key.kind === "class"  ? key.className
      : key.kind === "method" ? `${key.className}.${key.methodName}`
      : `${key.className}.${key.fieldName}`;

    m.result.auto.push({
        key,
        label: entry.label,
        oldObf: entry.oldObf,
        newObf,
        reason: "user accepted",
        parentClassMigration: entry.parentClassMigration,
    });

    res.json({ ok: true });
});
```

Add at the top of the file:

```typescript
import type { LabelKey } from "../core/types.js";
```

- [ ] **Step 3: Run route tests**

Run: `cd app && npx vitest run test/backend/routes-migrations.test.ts`
Expected: PASS — all existing + 3 new tests green.

- [ ] **Step 4: Commit**

```bash
git add app/backend/routes/migrations.ts app/test/backend/routes-migrations.test.ts
git commit -m "feat(deobfusc): polymorphic /api/migrations/accept (LabelKey payload)"
```

---

## Task 12: Routes — accept-class triggers pass 2 + WS broadcast

**Files:**
- Modify: `app/backend/routes/migrations.ts` (extend accept handler)
- Modify: `app/backend/session.ts` (expose helper for pass-2 trigger)
- Test: `app/test/backend/routes-migrations.test.ts` (append cascade test)

- [ ] **Step 1: Add a helper on Session for accept-class cascade**

In [app/backend/session.ts](app/backend/session.ts), inside the `Session` class, after the `migrations()` method (line 71), add:

```typescript
/**
 * After a class is accepted in REVIEW → AUTO, run pass 2 (match its fields and
 * methods) and insert the resulting records into the live MigrationResult.
 * Returns the records that were inserted, for the WS broadcast payload.
 */
applyClassPass2(oldClassObf: string, newClassObf: string): import("./core/types.js").MigrationResult {
    const empty = { auto: [], review: [], lost: [] };
    if (!this.currentMigrations) return empty;
    const oldCls = this.currentMigrations.oldFps.find((f) => f.obfName === oldClassObf);
    const newCls = this.currentMigrations.currentFps.find((f) => f.obfName === newClassObf);
    if (!oldCls || !newCls || !this.currentProfile) return empty;

    // Re-derive method/field labels from the previous-build labels file.
    // We cached fingerprints but not labels, so reload them. Fast (one JSON read).
    const previousBuildId = this.currentProfile.manifest.derivedFrom?.split("/")[1];
    if (!previousBuildId) return empty;

    const result: import("./core/types.js").MigrationResult = empty;
    // We don't await here because matchClassMembers is sync. Read labels sync via fs is fine
    // but this method is async-callable. Use the cached map below instead — store it on attach.
    // For now, return empty and rely on Step-2 below to populate.
    return result;
}
```

Wait — this is awkward. Easier: store `oldMethodLabels` and `oldFieldLabels` on the migrations object at attach time, so accept-handler can use them synchronously.

Replace the helper above with this approach. First update the `currentMigrations` storage shape:

In [app/backend/session.ts](app/backend/session.ts), update lines 37-41 (the `currentMigrations` field declaration):

```typescript
private currentMigrations: {
    result: MigrationResult;
    oldFps: ClassFingerprint[];
    currentFps: ClassFingerprint[];
    oldMethodLabels: Record<string, string>;
    oldFieldLabels: Record<string, string>;
} | null = null;
```

Then in `_doAttach` (the migration block from Task 10), update the `this.currentMigrations = ...` assignment to:

```typescript
this.currentMigrations = {
    result, oldFps, currentFps,
    oldMethodLabels, oldFieldLabels,
};
```

Now add the helper method (replacing the awkward stub above):

```typescript
applyClassPass2(oldClassObf: string, newClassObf: string): {
    auto: Array<import("./core/types.js").MigrationAutoRecord>;
    review: Array<import("./core/types.js").MigrationReviewRecord>;
    lost: Array<import("./core/types.js").MigrationLostRecord>;
} {
    const empty = { auto: [], review: [], lost: [] };
    if (!this.currentMigrations || !this.currentProfile) return empty;
    const oldCls = this.currentMigrations.oldFps.find((f) => f.obfName === oldClassObf);
    const newCls = this.currentMigrations.currentFps.find((f) => f.obfName === newClassObf);
    if (!oldCls || !newCls) return empty;

    const sub = matchClassMembers(
        oldCls,
        newCls,
        this.currentMigrations.oldMethodLabels,
        this.currentMigrations.oldFieldLabels,
    );
    // Apply auto labels immediately
    for (const r of sub.auto) {
        this.currentProfile.labels.set(r.key, r.label);
    }
    this.currentProfile.labels.scheduleFlush();
    // Insert into live result
    this.currentMigrations.result.auto.push(...sub.auto);
    this.currentMigrations.result.review.push(...sub.review);
    this.currentMigrations.result.lost.push(...sub.lost);
    return sub;
}
```

Add the import at the top of the file:

```typescript
import { matchFingerprints, matchClassMembers } from "./core/migrations.js";
```

(Replace the existing `import { matchFingerprints } from "./core/migrations.js";`)

- [ ] **Step 2: Update accept handler in routes to call applyClassPass2 for class accepts**

In [app/backend/routes/migrations.ts](app/backend/routes/migrations.ts), at the bottom of the rewritten `accept` handler (just before `res.json({ ok: true })`), add:

```typescript
// If a class was accepted, trigger pass 2 (members migrate now).
let pass2Records: ReturnType<typeof deps.session.applyClassPass2> | null = null;
if (key.kind === "class") {
    pass2Records = deps.session.applyClassPass2(entry.oldObf, key.className);
}

res.json({ ok: true, pass2: pass2Records });
return;
```

(Replace the bare `res.json({ ok: true });`.)

Update `MigrationsDeps` typing — `Session` needs to expose `applyClassPass2`. The deps interface already passes a full `Session`, so it's fine.

- [ ] **Step 3: Add test for cascade-on-class-accept**

Append to [app/test/backend/routes-migrations.test.ts](app/test/backend/routes-migrations.test.ts):

```typescript
describe("migrations routes — accept class triggers pass 2", () => {
    function makeFakeSessionWithPass2() {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-pass2-"));
        const labelStore = new LabelStore(path.join(tmpDir, "labels.json"));
        const profile: any = { labels: labelStore };
        const review = [
            {
                key: { kind: "class", className: "fzc" },
                label: "Encoder",
                oldObf: "fzc",
                candidates: [{ newObf: "abc", score: 0.92, reason: "..." }],
            },
        ];
        const migrations = { result: { auto: [], review, lost: [] } };
        const pass2Calls: any[] = [];
        return {
            profile: () => profile,
            migrations: () => migrations,
            labelStore,
            applyClassPass2: (oldObf: string, newObf: string) => {
                pass2Calls.push({ oldObf, newObf });
                const inserted = {
                    auto: [
                        {
                            key: { kind: "field", className: newObf, fieldName: "p" },
                            label: "playerId",
                            oldObf: "fzc.emjv",
                            newObf: `${newObf}.p`,
                            reason: "type+ordinal",
                            parentClassMigration: oldObf,
                        },
                    ],
                    review: [],
                    lost: [],
                };
                migrations.result.auto.push(...inserted.auto);
                return inserted;
            },
            pass2Calls,
        };
    }

    it("accept class triggers applyClassPass2 with old+new obf", async () => {
        const session = makeFakeSessionWithPass2();
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({
                key: { kind: "class", className: "abc" },
                oldObf: "fzc",
            });
        expect(res.status).toBe(200);
        expect(session.pass2Calls).toEqual([{ oldObf: "fzc", newObf: "abc" }]);
        expect(res.body.pass2.auto).toHaveLength(1);
    });
});
```

Run: `cd app && npx vitest run test/backend/routes-migrations.test.ts`
Expected: PASS — all tests including the new cascade test.

- [ ] **Step 4: Commit**

```bash
git add app/backend/session.ts app/backend/routes/migrations.ts app/test/backend/routes-migrations.test.ts
git commit -m "feat(deobfusc): accept-class triggers pass 2 (members migrate immediately)"
```

---

## Task 13: Routes — polymorphic reject + cascade-lost on class reject

**Files:**
- Modify: `app/backend/routes/migrations.ts` (reject handler)
- Modify: `app/backend/session.ts` (helper for cascade-lost)
- Test: `app/test/backend/routes-migrations.test.ts`

- [ ] **Step 1: Add `applyClassRejectCascade` helper on Session**

In [app/backend/session.ts](app/backend/session.ts), after `applyClassPass2`, add:

```typescript
/**
 * After a class is rejected in REVIEW → LOST, mark all its labeled fields/methods
 * as LOST too (they had no class to migrate against).
 */
applyClassRejectCascade(oldClassObf: string): import("./core/types.js").MigrationLostRecord[] {
    if (!this.currentMigrations) return [];
    const out: import("./core/types.js").MigrationLostRecord[] = [];
    for (const [k, label] of Object.entries(this.currentMigrations.oldMethodLabels)) {
        if (k.startsWith(oldClassObf + ".")) {
            const methodName = k.slice(oldClassObf.length + 1);
            out.push({
                key: { kind: "method", className: oldClassObf, methodName },
                oldObf: k,
                label,
                reason: "parent class rejected by user",
                parentClassMigration: oldClassObf,
            });
        }
    }
    for (const [k, label] of Object.entries(this.currentMigrations.oldFieldLabels)) {
        if (k.startsWith(oldClassObf + ".")) {
            const fieldName = k.slice(oldClassObf.length + 1);
            out.push({
                key: { kind: "field", className: oldClassObf, fieldName },
                oldObf: k,
                label,
                reason: "parent class rejected by user",
                parentClassMigration: oldClassObf,
            });
        }
    }
    this.currentMigrations.result.lost.push(...out);
    return out;
}
```

- [ ] **Step 2: Rewrite reject handler with polymorphic + cascade**

In [app/backend/routes/migrations.ts](app/backend/routes/migrations.ts), replace the existing reject handler (lines 36-50) with:

```typescript
app.post("/api/migrations/reject", (req, res) => {
    const m = deps.session.migrations();
    if (!m) { res.status(503).json({ error: "no migrations" }); return; }

    const body = req.body ?? {};
    let key: LabelKey;
    let oldObf: string;
    if (body.key && typeof body.oldObf === "string") {
        key = body.key as LabelKey;
        oldObf = body.oldObf;
    } else if (typeof body.oldObf === "string") {
        key = { kind: "class", className: body.oldObf };
        oldObf = body.oldObf;
    } else {
        res.status(400).json({ error: "expected {key,oldObf} or {oldObf}" });
        return;
    }

    const idx = m.result.review.findIndex((r) => r.oldObf === oldObf);
    if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
    const entry = m.result.review[idx];
    m.result.review.splice(idx, 1);
    m.result.lost.push({
        key,
        label: entry.label,
        oldObf: entry.oldObf,
        reason: "user rejected",
        parentClassMigration: entry.parentClassMigration,
    });

    let cascaded: import("../core/types.js").MigrationLostRecord[] = [];
    if (key.kind === "class") {
        cascaded = deps.session.applyClassRejectCascade(entry.oldObf);
    }

    res.json({ ok: true, cascaded });
});
```

- [ ] **Step 3: Test cascade-on-reject**

Append to [app/test/backend/routes-migrations.test.ts](app/test/backend/routes-migrations.test.ts):

```typescript
describe("migrations routes — reject class cascades members to LOST", () => {
    it("rejecting a class invokes applyClassRejectCascade and adds members to lost", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-reject-"));
        const labelStore = new LabelStore(path.join(tmpDir, "labels.json"));
        const review = [{
            key: { kind: "class", className: "fzc" },
            label: "Encoder",
            oldObf: "fzc",
            candidates: [{ newObf: "abc", score: 0.7, reason: "..." }],
        }];
        const migrations = { result: { auto: [], review, lost: [] } };
        const cascadeReturn = [
            { key: { kind: "field", className: "fzc", fieldName: "emjv" }, oldObf: "fzc.emjv", label: "playerId", reason: "parent class rejected by user", parentClassMigration: "fzc" },
        ];
        const session: any = {
            profile: () => ({ labels: labelStore }),
            migrations: () => migrations,
            applyClassRejectCascade: (oldObf: string) => {
                migrations.result.lost.push(...(cascadeReturn as any));
                return cascadeReturn;
            },
        };
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session });

        const res = await request(local).post("/api/migrations/reject").send({ oldObf: "fzc" });
        expect(res.status).toBe(200);
        expect(res.body.cascaded).toHaveLength(1);
        // class itself + the cascaded field
        expect(migrations.result.lost.length).toBeGreaterThanOrEqual(2);
    });
});
```

Run: `cd app && npx vitest run test/backend/routes-migrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/backend/session.ts app/backend/routes/migrations.ts app/test/backend/routes-migrations.test.ts
git commit -m "feat(deobfusc): polymorphic reject + cascade-lost on class reject"
```

---

## Task 14: WS bridge — broadcast `migration-updated` after accept/reject

**Files:**
- Modify: `app/backend/ws-bridge.ts`
- Modify: `app/backend/routes/migrations.ts` (emit event)
- Modify: `app/backend/session.ts` (re-emit)

- [ ] **Step 1: Have Session emit `migration-updated`**

In [app/backend/routes/migrations.ts](app/backend/routes/migrations.ts), at the very bottom of `accept` (just before `res.json(...)`) and `reject` (just before `res.json(...)`), add:

```typescript
deps.session.emit("migration-updated");
```

(`Session extends EventEmitter`, so `.emit` is available.)

- [ ] **Step 2: Wire ws-bridge to forward the event**

In [app/backend/ws-bridge.ts](app/backend/ws-bridge.ts), insert immediately after line 44 (the `session.on("hook-store-change", ...)` line) :

```typescript
session.on("migration-updated", () => broadcast({ type: "migration-updated" }));
```

- [ ] **Step 3: Run full backend tests**

Run: `cd app && npx vitest run test/backend`
Expected: PASS. The WS broadcast itself isn't unit-tested (it's a thin pipe) — frontend tests will exercise WS messages later.

- [ ] **Step 4: Commit**

```bash
git add app/backend/routes/migrations.ts app/backend/ws-bridge.ts
git commit -m "feat(deobfusc): broadcast migration-updated WS event on accept/reject"
```

---

## Task 15: Routes — `POST /api/migrations/accept-top-all` for bulk-accept

**Files:**
- Modify: `app/backend/routes/migrations.ts` (new endpoint)
- Test: `app/test/backend/routes-migrations.test.ts`

- [ ] **Step 1: Write failing test for bulk accept**

Append to [app/test/backend/routes-migrations.test.ts](app/test/backend/routes-migrations.test.ts):

```typescript
describe("POST /api/migrations/accept-top-all", () => {
    it("accepts the top candidate for every review item", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-bulk-"));
        const labelStore = new LabelStore(path.join(tmpDir, "labels.json"));
        const review = [
            { key: { kind: "class", className: "fzc" }, label: "Encoder", oldObf: "fzc", candidates: [{ newObf: "abc", score: 0.92, reason: "..." }] },
            { key: { kind: "field", className: "newCls", fieldName: "" }, label: "playerId", oldObf: "oldCls.emjv", candidates: [{ newObf: "newCls.aaa", score: 0.85, reason: "..." }], parentClassMigration: "oldCls" },
        ];
        const migrations = { result: { auto: [], review, lost: [] } };
        const session: any = {
            profile: () => ({ labels: labelStore }),
            migrations: () => migrations,
            applyClassPass2: () => ({ auto: [], review: [], lost: [] }),
            emit: () => {},
        };
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session });

        const res = await request(local).post("/api/migrations/accept-top-all").send({});
        expect(res.status).toBe(200);
        expect(res.body.acceptedCount).toBe(2);
        expect(migrations.result.review).toHaveLength(0);
        expect(migrations.result.auto).toHaveLength(2);
        expect(labelStore.get({ kind: "class", className: "abc" })).toBe("Encoder");
        expect(labelStore.get({ kind: "field", className: "newCls", fieldName: "aaa" })).toBe("playerId");
    });

    it("returns 503 when no migrations active", async () => {
        const session: any = { profile: () => null, migrations: () => null };
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session });
        const res = await request(local).post("/api/migrations/accept-top-all").send({});
        expect(res.status).toBe(503);
    });
});
```

Run: `cd app && npx vitest run test/backend/routes-migrations.test.ts -t "accept-top-all"`
Expected: FAIL — endpoint doesn't exist (404).

- [ ] **Step 2: Implement endpoint**

In [app/backend/routes/migrations.ts](app/backend/routes/migrations.ts), append before the closing `}` of `mountMigrations`:

```typescript
app.post("/api/migrations/accept-top-all", (_req, res) => {
    const p = deps.session.profile();
    const m = deps.session.migrations();
    if (!p || !m) { res.status(503).json({ error: "no migrations or no profile" }); return; }

    let accepted = 0;
    // Iterate on a snapshot — we mutate review[] inside the loop.
    const snapshot = m.result.review.slice();
    for (const entry of snapshot) {
        if (entry.candidates.length === 0) continue;
        const top = entry.candidates[0];

        // Build the destination LabelKey from the entry's key shape + top.newObf.
        let destKey: LabelKey;
        if (entry.key.kind === "class") {
            destKey = { kind: "class", className: top.newObf };
        } else if (entry.key.kind === "method") {
            const dot = top.newObf.lastIndexOf(".");
            destKey = { kind: "method", className: top.newObf.slice(0, dot), methodName: top.newObf.slice(dot + 1) };
        } else {
            const dot = top.newObf.lastIndexOf(".");
            destKey = { kind: "field", className: top.newObf.slice(0, dot), fieldName: top.newObf.slice(dot + 1) };
        }

        p.labels.set(destKey, entry.label);
        const idx = m.result.review.findIndex((r) => r.oldObf === entry.oldObf);
        if (idx >= 0) m.result.review.splice(idx, 1);
        m.result.auto.push({
            key: destKey,
            label: entry.label,
            oldObf: entry.oldObf,
            newObf: top.newObf,
            reason: "user accepted (bulk top)",
            parentClassMigration: entry.parentClassMigration,
        });
        if (destKey.kind === "class") {
            deps.session.applyClassPass2(entry.oldObf, destKey.className);
        }
        accepted++;
    }
    p.labels.scheduleFlush();
    deps.session.emit("migration-updated");
    res.json({ ok: true, acceptedCount: accepted });
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/routes-migrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/backend/routes/migrations.ts app/test/backend/routes-migrations.test.ts
git commit -m "feat(deobfusc): /api/migrations/accept-top-all bulk endpoint"
```

---

## Task 16: Frontend `api.ts` — polymorphic accept/reject + accept-top-all

**Files:**
- Modify: `app/frontend/core/api.ts`

- [ ] **Step 1: Replace migration methods on the `api` object**

The current methods are at [app/frontend/core/api.ts:48-50](app/frontend/core/api.ts#L48-L50):

```typescript
getMigrations() { return call<any>("GET", "/api/migrations"); },
acceptMigration(oldObf: string, newObf: string) { return call("POST", "/api/migrations/accept", { oldObf, newObf }); },
rejectMigration(oldObf: string) { return call("POST", "/api/migrations/reject", { oldObf }); },
```

Replace those three lines with:

```typescript
getMigrations() { return call<any>("GET", "/api/migrations"); },
acceptMigration(payload: { key: import("./types.js").LabelKeyLite; oldObf: string }) {
    return call<{ ok: boolean; pass2?: { auto: any[]; review: any[]; lost: any[] } | null }>(
        "POST", "/api/migrations/accept", payload,
    );
},
rejectMigration(payload: { key: import("./types.js").LabelKeyLite; oldObf: string }) {
    return call<{ ok: boolean; cascaded?: any[] }>("POST", "/api/migrations/reject", payload);
},
acceptTopForAllReviews() {
    return call<{ ok: boolean; acceptedCount: number }>("POST", "/api/migrations/accept-top-all", {});
},
```

- [ ] **Step 2: Add `LabelKeyLite` to frontend types**

In [app/frontend/core/types.ts](app/frontend/core/types.ts), append:

```typescript
export interface LabelKeyLite {
    kind: "class" | "method" | "field";
    className: string;
    methodName?: string;
    fieldName?: string;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npm run typecheck`
Expected: errors only in `app/frontend/pages/migrations.ts` (it still uses old signatures — fixed in Tasks 17-21).

- [ ] **Step 4: Commit**

```bash
git add app/frontend/core/api.ts app/frontend/core/types.ts
git commit -m "feat(deobfusc): frontend api — polymorphic accept/reject + bulk top"
```

---

## Task 17: Frontend `migrations.ts` — REVIEW zone (rewrite top half)

**Files:**
- Modify: `app/frontend/pages/migrations.ts` (full rewrite)

- [ ] **Step 1: Note the current export and call sites**

Current file [app/frontend/pages/migrations.ts](app/frontend/pages/migrations.ts) exports `mountMigrationsPage(host)` (single function, no cleanup return). Whoever calls this at the routing layer (search the codebase for `mountMigrationsPage`) — keep that name.

- [ ] **Step 2: Rewrite the component**

Replace the **entire content** of [app/frontend/pages/migrations.ts](app/frontend/pages/migrations.ts) with:

```typescript
// app/frontend/pages/migrations.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import { icons } from "../core/icons.js";
import type { LabelKeyLite } from "../core/types.js";

interface MigrationCandidate { newObf: string; score: number; reason: string; }

interface ReviewRecord {
    key: LabelKeyLite;
    oldObf: string;
    candidates: MigrationCandidate[];
    label: string;
    parentClassMigration?: string;
}

interface AutoRecord {
    key: LabelKeyLite;
    oldObf: string;
    newObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

interface LostRecord {
    key: LabelKeyLite;
    oldObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

interface MigrationResult {
    auto: AutoRecord[];
    review: ReviewRecord[];
    lost: LostRecord[];
}

let _state: MigrationResult = { auto: [], review: [], lost: [] };
let _expandedClasses = new Set<string>();   // newObf of class with breakdown shown
let _lostExpanded = false;
let _showOnlyReviews = false;
let _hostEl: HTMLElement | null = null;

export function mountMigrationsPage(host: HTMLElement): void {
    _hostEl = host;
    host.style.flex = "1";
    void load();
    subscribe("migration-updated", () => { void load(); });
}

async function load(): Promise<void> {
    try {
        const body = await api.getMigrations();
        _state = body.result ?? { auto: [], review: [], lost: [] };
        render();
    } catch (e) {
        if (_hostEl) _hostEl.innerHTML = `<div style="color:var(--danger);padding:14px">${escape(String(e))}</div>`;
    }
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function kindIcon(k: LabelKeyLite["kind"]): string {
    if (k === "class")  return icons.layers(12);
    if (k === "method") return icons.hook(12);
    return icons.note(12);
}

function render(): void {
    if (!_hostEl) return;
    _hostEl.innerHTML = `
        <style>
            .mig-toolbar { display:flex; gap:8px; align-items:center; padding:8px 14px; border-bottom:1px solid var(--border-strong); background:var(--bg-elevated); }
            .mig-zone-title { font-size:11px; color:var(--text-faint); padding:8px 14px; text-transform:uppercase; letter-spacing:0.05em; }
            .mig-row { padding:8px 14px; border-bottom:1px solid var(--border-strong); font-family:var(--font-code); font-size:12px; }
            .mig-row.review { background:rgba(245,158,11,0.04); }
            .mig-row.auto { background:transparent; }
            .mig-row.lost { background:rgba(239,68,68,0.04); }
            .mig-cands { margin-left:24px; margin-top:4px; }
            .mig-cand { padding:2px 0; display:flex; gap:8px; align-items:center; }
            .mig-cand-actions { display:flex; gap:4px; }
            .mig-pill { padding:2px 6px; border-radius:3px; font-size:10px; cursor:pointer; border:1px solid var(--border-strong); background:var(--bg-elevated); color:var(--text-strong); }
            .mig-pill:hover { background:var(--bg-hover); }
            .mig-pill.danger { color:var(--danger); }
            .mig-breakdown { margin-left:24px; padding:6px 0; color:var(--text-faint); }
            .mig-breakdown-row { padding:1px 0; }
            .mig-old { color:var(--text-faint); }
            .mig-arrow { color:var(--text-faint); }
            .mig-label { color:var(--syntax-name); font-weight:600; }
        </style>
        <div class="mig-toolbar">
            <button class="mig-pill" id="mig-accept-all">${icons.check(12)} Accept top candidate for all REVIEWs (${_state.review.length})</button>
            <button class="mig-pill" id="mig-toggle-only-reviews">${_showOnlyReviews ? "Show all" : "Show only REVIEWs"}</button>
            <button class="mig-pill" id="mig-export">${icons.clipboard(12)} Export NDJSON</button>
            <span style="flex:1"></span>
            <span style="color:var(--text-faint);font-size:11px">${_state.auto.length} auto · ${_state.review.length} review · ${_state.lost.length} lost</span>
        </div>
        <div id="mig-body" style="overflow-y:auto"></div>
    `;
    const body = _hostEl.querySelector<HTMLElement>("#mig-body")!;
    body.appendChild(renderReviewZone());
    if (!_showOnlyReviews) {
        body.appendChild(renderAutoZone());
        body.appendChild(renderLostZone());
    }
    bindToolbar();
}

function renderReviewZone(): HTMLElement {
    const wrap = document.createElement("div");
    if (_state.review.length === 0) {
        wrap.innerHTML = `<div class="mig-zone-title">No REVIEWs pending</div>`;
        return wrap;
    }
    wrap.innerHTML = `<div class="mig-zone-title">REVIEWs (${_state.review.length}) — pick a candidate</div>`;
    for (const r of _state.review) {
        const div = document.createElement("div");
        div.className = "mig-row review";
        div.innerHTML = `
            <div>${kindIcon(r.key.kind)} <strong class="mig-label">${escape(r.label)}</strong>
                <span class="mig-old">${escape(r.oldObf)}</span> <span class="mig-arrow">→ ?</span>
                ${r.parentClassMigration ? `<span style="color:var(--text-faint);font-size:10px"> [under class ${escape(r.parentClassMigration)}]</span>` : ""}
            </div>
            <div class="mig-cands"></div>
        `;
        const cands = div.querySelector<HTMLElement>(".mig-cands")!;
        for (const c of r.candidates) {
            const cand = document.createElement("div");
            cand.className = "mig-cand";
            cand.innerHTML = `
                <span style="flex:1"><span class="mig-old">${escape(c.newObf)}</span> <span style="color:var(--text-faint);font-size:10px">(score ${c.score.toFixed(2)} · ${escape(c.reason)})</span></span>
                <div class="mig-cand-actions">
                    <button class="mig-pill" data-action="accept">Accept</button>
                </div>
            `;
            cand.querySelector<HTMLButtonElement>('[data-action="accept"]')!.addEventListener("click", () => {
                void doAccept(r, c);
            });
            cands.appendChild(cand);
        }
        const reject = document.createElement("button");
        reject.className = "mig-pill danger";
        reject.textContent = "Reject all";
        reject.style.marginLeft = "24px";
        reject.style.marginTop = "4px";
        reject.addEventListener("click", () => { void doReject(r); });
        div.appendChild(reject);
        wrap.appendChild(div);
    }
    return wrap;
}

function renderAutoZone(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="mig-zone-title">AUTOs (${_state.auto.length}) — applied automatically</div>`;
    return wrap; // populated by Task 18
}

function renderLostZone(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="mig-zone-title">LOST (${_state.lost.length})</div>`;
    return wrap; // populated by Task 19
}

function bindToolbar(): void {
    if (!_hostEl) return;
    _hostEl.querySelector<HTMLButtonElement>("#mig-accept-all")?.addEventListener("click", () => { void doAcceptAll(); });
    _hostEl.querySelector<HTMLButtonElement>("#mig-toggle-only-reviews")?.addEventListener("click", () => {
        _showOnlyReviews = !_showOnlyReviews;
        render();
    });
    _hostEl.querySelector<HTMLButtonElement>("#mig-export")?.addEventListener("click", () => { void exportNdjson(); });
}

async function doAccept(r: ReviewRecord, c: MigrationCandidate): Promise<void> {
    let key: LabelKeyLite;
    if (r.key.kind === "class") {
        key = { kind: "class", className: c.newObf };
    } else if (r.key.kind === "method") {
        const dot = c.newObf.lastIndexOf(".");
        key = { kind: "method", className: c.newObf.slice(0, dot), methodName: c.newObf.slice(dot + 1) };
    } else {
        const dot = c.newObf.lastIndexOf(".");
        key = { kind: "field", className: c.newObf.slice(0, dot), fieldName: c.newObf.slice(dot + 1) };
    }
    await api.acceptMigration({ key, oldObf: r.oldObf });
    // WS will trigger re-load via subscribe handler.
}

async function doReject(r: ReviewRecord): Promise<void> {
    await api.rejectMigration({ key: r.key, oldObf: r.oldObf });
}

async function doAcceptAll(): Promise<void> {
    if (_state.review.length === 0) return;
    const ok = window.confirm(`This will accept the top candidate for all ${_state.review.length} pending REVIEWs. Continue?`);
    if (!ok) return;
    await api.acceptTopForAllReviews();
}

function exportNdjson(): void {
    const lines = [
        ..._state.auto.map((r) => JSON.stringify({ status: "auto", ...r })),
        ..._state.review.map((r) => JSON.stringify({ status: "review", ...r })),
        ..._state.lost.map((r) => JSON.stringify({ status: "lost", ...r })),
    ];
    const blob = new Blob([lines.join("\n")], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `migration-report-${Date.now()}.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
}
```

- [ ] **Step 3: Build**

Run: `cd app && npx vite build`
Expected: PASS — bundle generated.

- [ ] **Step 4: Manual smoke test (just-in-case)**

Run: `cd app && npm run dev`
Open the Migrations page. Verify the toolbar and REVIEWs zone render even with empty state. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/pages/migrations.ts
git commit -m "feat(deobfusc): UI rewrite — REVIEW zone with per-candidate picker"
```

---

## Task 18: Frontend AUTO zone — rollup by parent class with breakdown

**Files:**
- Modify: `app/frontend/pages/migrations.ts` (replace `renderAutoZone`)

- [ ] **Step 1: Replace renderAutoZone**

In [app/frontend/pages/migrations.ts](app/frontend/pages/migrations.ts), replace the `renderAutoZone` function with:

```typescript
function renderAutoZone(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="mig-zone-title">AUTOs (${_state.auto.length}) — applied automatically</div>`;

    // Group records by parent class. A class record is its own parent.
    // Members (kind=method/field) are grouped under their parentClassMigration.
    const classRecords = _state.auto.filter((r) => r.key.kind === "class");
    const memberRecords = _state.auto.filter((r) => r.key.kind !== "class");

    // For unchanged classes (no class record but with member migrations under them),
    // we synthesize a header row by parentClassMigration.
    const seenParents = new Set(classRecords.map((r) => r.oldObf));
    const orphanParents = new Map<string, AutoRecord[]>();
    for (const m of memberRecords) {
        const parent = m.parentClassMigration ?? "(no class)";
        if (seenParents.has(parent)) continue;
        const list = orphanParents.get(parent) ?? [];
        list.push(m);
        orphanParents.set(parent, list);
    }

    for (const cls of classRecords) {
        const myMembers = memberRecords.filter((m) => m.parentClassMigration === cls.oldObf);
        wrap.appendChild(renderClassRollup(cls.oldObf, cls.newObf, cls.label, cls.reason, myMembers, true));
    }
    for (const [parent, members] of orphanParents) {
        wrap.appendChild(renderClassRollup(parent, parent, "(class unchanged)", "members migrated only", members, false));
    }
    return wrap;
}

function renderClassRollup(
    oldObf: string,
    newObf: string,
    label: string,
    reason: string,
    members: AutoRecord[],
    showClassRow: boolean,
): HTMLElement {
    const div = document.createElement("div");
    div.className = "mig-row auto";

    const methodCount = members.filter((m) => m.key.kind === "method").length;
    const fieldCount = members.filter((m) => m.key.kind === "field").length;
    const expanded = _expandedClasses.has(newObf);

    const header = showClassRow
        ? `<div>${kindIcon("class")} <strong class="mig-label">${escape(label)}</strong>
              <span class="mig-old">${escape(oldObf)}</span> <span class="mig-arrow">→</span> <span>${escape(newObf)}</span>
              <span style="color:var(--text-faint);font-size:10px;margin-left:8px">${escape(reason)}</span>
           </div>`
        : `<div>${kindIcon("class")} <span class="mig-old">${escape(newObf)}</span>
              <span style="color:var(--text-faint);font-size:10px;margin-left:8px">(class unchanged)</span>
           </div>`;

    const summary = members.length > 0
        ? `<div style="margin-top:4px;font-size:11px;color:var(--text-faint)">
             +${methodCount} methods auto · +${fieldCount} fields auto
             <button class="mig-pill" data-action="toggle-breakdown" style="margin-left:8px">${expanded ? "Hide" : "Show"} breakdown</button>
           </div>`
        : "";

    div.innerHTML = header + summary;

    if (members.length > 0 && expanded) {
        const bd = document.createElement("div");
        bd.className = "mig-breakdown";
        for (const m of members) {
            const row = document.createElement("div");
            row.className = "mig-breakdown-row";
            row.innerHTML = `${kindIcon(m.key.kind)} <strong class="mig-label">${escape(m.label)}</strong>
                <span class="mig-old">${escape(m.oldObf)}</span> <span class="mig-arrow">→</span> <span>${escape(m.newObf)}</span>
                <span style="color:var(--text-faint);font-size:10px;margin-left:6px">${escape(m.reason)}</span>`;
            bd.appendChild(row);
        }
        div.appendChild(bd);
    }

    div.querySelector<HTMLButtonElement>('[data-action="toggle-breakdown"]')?.addEventListener("click", () => {
        if (_expandedClasses.has(newObf)) _expandedClasses.delete(newObf);
        else _expandedClasses.add(newObf);
        render();
    });
    return div;
}
```

- [ ] **Step 2: Build**

Run: `cd app && npx vite build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/pages/migrations.ts
git commit -m "feat(deobfusc): UI AUTO zone — rollup by class + inline breakdown"
```

---

## Task 19: Frontend LOST zone — collapsed by default

**Files:**
- Modify: `app/frontend/pages/migrations.ts` (replace `renderLostZone`)

- [ ] **Step 1: Replace renderLostZone**

The `_lostExpanded` state variable was already added at the top of the file in Task 17.

Replace `renderLostZone` with:

```typescript
function renderLostZone(): HTMLElement {
    const wrap = document.createElement("div");
    if (_state.lost.length === 0) {
        wrap.innerHTML = `<div class="mig-zone-title">LOST (0)</div>`;
        return wrap;
    }
    wrap.innerHTML = `<div class="mig-zone-title">LOST (${_state.lost.length})
        <button class="mig-pill" id="mig-lost-toggle" style="margin-left:8px">${_lostExpanded ? "Hide" : "Show"} details</button>
    </div>`;
    if (_lostExpanded) {
        for (const l of _state.lost) {
            const div = document.createElement("div");
            div.className = "mig-row lost";
            div.innerHTML = `${kindIcon(l.key.kind)} <strong class="mig-label">${escape(l.label)}</strong>
                <span class="mig-old">${escape(l.oldObf)}</span>
                <span style="color:var(--text-faint);font-size:11px;margin-left:8px">${escape(l.reason)}</span>`;
            wrap.appendChild(div);
        }
    }
    setTimeout(() => {
        document.getElementById("mig-lost-toggle")?.addEventListener("click", () => {
            _lostExpanded = !_lostExpanded;
            render();
        });
    }, 0);
    return wrap;
}
```

- [ ] **Step 2: Build**

Run: `cd app && npx vite build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/pages/migrations.ts
git commit -m "feat(deobfusc): UI LOST zone — collapsed by default with details toggle"
```

---

## Task 20: Frontend tests — REVIEW renders, accept/reject send right payload

**Files:**
- Test: `app/test/frontend/pages/migrations.test.ts` (create if not exists)

- [ ] **Step 1: Verify frontend test harness**

Check whether `happy-dom` is already a dev dependency:

Run: `grep -E "happy-dom|jsdom" app/package.json`
Expected: either a hit (harness exists) or no output (need to install).

If no harness exists, install one before running tests:

Run: `cd app && npm install --save-dev happy-dom`

Also check that there's a frontend test directory (create the path if not):

Run: `ls app/test/frontend 2>/dev/null || mkdir -p app/test/frontend/components`

- [ ] **Step 2: Write the test file**

Create [app/test/frontend/pages/migrations.test.ts](app/test/frontend/pages/migrations.test.ts):

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountMigrationsPage } from "../../../frontend/pages/migrations";

vi.mock("../../../frontend/core/ws.js", () => ({
    subscribe: () => () => {},
}));

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

beforeEach(() => {
    fetchMock.mockReset();
});

function mockMigrations(result: any): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/migrations" && (!init || init.method === undefined)) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ result }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
}

describe("migrations component", () => {
    it("renders an empty state when nothing to migrate", async () => {
        mockMigrations({ auto: [], review: [], lost: [] });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));
        expect(host.textContent).toContain("No REVIEWs pending");
    });

    it("renders REVIEW rows with candidate buttons", async () => {
        mockMigrations({
            auto: [],
            review: [{
                key: { kind: "class", className: "fzc" },
                oldObf: "fzc",
                label: "Encoder",
                candidates: [
                    { newObf: "abc", score: 0.92, reason: "structural similarity 0.92" },
                    { newObf: "def", score: 0.85, reason: "structural similarity 0.85" },
                ],
            }],
            lost: [],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));
        expect(host.textContent).toContain("Encoder");
        expect(host.textContent).toContain("abc");
        expect(host.querySelectorAll('[data-action="accept"]').length).toBe(2);
    });

    it("clicking Accept sends polymorphic payload to /api/migrations/accept", async () => {
        mockMigrations({
            auto: [],
            review: [{
                key: { kind: "field", className: "newCls", fieldName: "" },
                oldObf: "oldCls.emjv",
                label: "playerId",
                candidates: [{ newObf: "newCls.aaa", score: 0.85, reason: "..." }],
                parentClassMigration: "oldCls",
            }],
            lost: [],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));

        const acceptBtn = host.querySelector<HTMLButtonElement>('[data-action="accept"]')!;
        acceptBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        const acceptCall = fetchMock.mock.calls.find((c) => c[0] === "/api/migrations/accept");
        expect(acceptCall).toBeDefined();
        const body = JSON.parse(acceptCall![1].body);
        expect(body.key).toEqual({ kind: "field", className: "newCls", fieldName: "aaa" });
        expect(body.oldObf).toBe("oldCls.emjv");
    });

    it("Accept-top-all sends to /api/migrations/accept-top-all after confirm", async () => {
        mockMigrations({
            auto: [],
            review: [{
                key: { kind: "class", className: "fzc" },
                oldObf: "fzc",
                label: "Encoder",
                candidates: [{ newObf: "abc", score: 0.92, reason: "..." }],
            }],
            lost: [],
        });
        global.confirm = vi.fn(() => true);
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));

        const btn = host.querySelector<HTMLButtonElement>("#mig-accept-all")!;
        btn.click();
        await new Promise((r) => setTimeout(r, 0));

        const bulkCall = fetchMock.mock.calls.find((c) => c[0] === "/api/migrations/accept-top-all");
        expect(bulkCall).toBeDefined();
    });
});
```

- [ ] **Step 3: Run frontend tests**

Run: `cd app && npx vitest run test/frontend/pages/migrations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/test/frontend/pages/migrations.test.ts app/package.json app/package-lock.json
git commit -m "test(deobfusc): frontend migrations page — render + payload shape"
```

---

## Task 21: Backend test — full pipeline simulation (oldFps → newFps with member labels)

**Files:**
- Test: `app/test/backend/core/migrations.test.ts` (append integration test)

- [ ] **Step 1: Write integration test**

Append to [app/test/backend/core/migrations.test.ts](app/test/backend/core/migrations.test.ts):

```typescript
describe("matchFingerprints — full Dofus-like scenario", () => {
    it("encoder class with method+field labels migrates fully across builds", () => {
        const oldEncoder = cls("fzc", {
            token: "0x2001000",
            methodCount: 3,
            methods: [
                { obfName: "Encode", token: "0x600A001", paramTypes: ["IMessage"], returnType: "void", paramCount: 1, declIndex: 0, isStatic: false },
                { obfName: "Decode", token: "0x600A002", paramTypes: ["byte[]"], returnType: "IMessage", paramCount: 1, declIndex: 1, isStatic: false },
                { obfName: "Reset", token: "0x600A003", paramTypes: [], returnType: "void", paramCount: 0, declIndex: 2, isStatic: false },
            ],
            fields: [
                { obfName: "emjv", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "emkh", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
            ],
        });
        const newEncoder = cls("xyz", {
            token: "0x2001000",
            methodCount: 3,
            methods: [
                { obfName: "a", token: "0x600A001", paramTypes: ["IMessage"], returnType: "void", paramCount: 1, declIndex: 0, isStatic: false },
                { obfName: "b", token: "0x600A002", paramTypes: ["byte[]"], returnType: "IMessage", paramCount: 1, declIndex: 1, isStatic: false },
                { obfName: "c", token: "0x600A003", paramTypes: [], returnType: "void", paramCount: 0, declIndex: 2, isStatic: false },
            ],
            fields: [
                { obfName: "p", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "q", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
            ],
        });

        const result = matchFingerprints({
            oldFps: [oldEncoder],
            newFps: [newEncoder],
            oldLabels: { fzc: "Encoder" },
            oldMethodLabels: { "fzc.Encode": "encode", "fzc.Decode": "decode" },
            oldFieldLabels: { "fzc.emjv": "playerId", "fzc.emkh": "playerName" },
        });

        // 1 class auto + 2 method auto + 2 field auto = 5
        expect(result.auto).toHaveLength(5);
        expect(result.review).toHaveLength(0);
        expect(result.lost).toHaveLength(0);

        // Spot-check each migration
        const cls_ = result.auto.find((r) => r.key.kind === "class")!;
        expect(cls_.newObf).toBe("xyz");
        const playerIdRec = result.auto.find((r) => r.label === "playerId")!;
        expect(playerIdRec.key).toEqual({ kind: "field", className: "xyz", fieldName: "p" });
        const encodeRec = result.auto.find((r) => r.label === "encode")!;
        expect(encodeRec.key).toEqual({ kind: "method", className: "xyz", methodName: "a" });
        expect(encodeRec.reason).toBe("token match");
    });
});
```

- [ ] **Step 2: Run test**

Run: `cd app && npx vitest run test/backend/core/migrations.test.ts -t "Dofus-like"`
Expected: PASS — 1 test green.

- [ ] **Step 3: Run full backend suite to confirm baseline + new tests all green**

Run: `cd app && npx vitest run`
Expected: PASS — ~192 tests green (167 baseline + ~25 new).

- [ ] **Step 4: Commit**

```bash
git add app/test/backend/core/migrations.test.ts
git commit -m "test(deobfusc): full Dofus-like end-to-end migration scenario"
```

---

## Task 22: Final verification + smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run typecheck**

Run: `cd app && npm run typecheck`
Expected: PASS — zero errors.

- [ ] **Step 2: Run vite build**

Run: `cd app && npx vite build`
Expected: PASS — bundle clean.

- [ ] **Step 3: Run all backend + frontend tests**

Run: `cd app && npx vitest run`
Expected: PASS — ~192 tests.

- [ ] **Step 4: Smoke-test on Dofus (manual)**

Run: `cd app && npm run dev`

In the toolkit:
1. Attach to Dofus.
2. Make sure you have a few labels: rename `fzc` → "Encoder", rename a method (`fzc.Encode` → "encode"), rename a field on a Network message (`emjv` → "playerName").
3. Detach.
4. Force a profile refresh: edit `~/.frida-toolkit/profiles/dofus/<buildId>/manifest.json` and set `derivedFrom` to the current `profileId`. Then create a new profile dir manually (or wait for a real Dofus update — whichever).

Alternative smoke (faster): write a tiny script that loads two consecutive `fingerprints.json` from disk and calls `matchFingerprints` directly, asserting the expected migration on a known label.

5. On re-attach (or new profile load), open the Migrations panel.
   - Confirm REVIEW rows have actionable Accept/Reject buttons per candidate.
   - Confirm AUTO rows show class header + "+N methods, +M fields" + breakdown when expanded.
   - Confirm LOST is collapsed and expandable.
   - Click "Accept top candidate for all REVIEWs" and confirm the modal works.
   - Verify the rename persists in Process Explorer + Hook Log + Network views (label-resolver picks them up).

- [ ] **Step 5: No commit needed for verification — branch is ready**

If smoke-test passes, the v1.3 implementation is complete on `toolkit-core-v1`. Use `superpowers:finishing-a-development-branch` to finalize.
