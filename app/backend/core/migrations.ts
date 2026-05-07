// Migration engine: given old + new fingerprints and a label map, decide
// which labels migrate automatically, which need user review, which are lost.
//
// Algorithm:
//   1. Build index of new fingerprints by token (when present)
//   2. For each labeled OLD class:
//      a. Token match → AUTO (highest confidence)
//      b. Otherwise compute structural similarity vs every NEW class
//      c. Best score >= 0.95 AND unique → AUTO
//         Best score >= 0.60 → REVIEW with all candidates above 0.60
//         Else → LOST

import type {
    ClassFingerprint,
    FieldFingerprint,
    LabelKey,
    MigrationAutoRecord,
    MigrationLostRecord,
    MigrationResult,
    MigrationReviewRecord,
} from "./types";

export interface MatchInput {
    oldFps: ClassFingerprint[];
    newFps: ClassFingerprint[];
    oldLabels: Record<string, string>;
}

const AUTO_THRESHOLD = 0.95;
const REVIEW_THRESHOLD = 0.60;

export function matchFingerprints(input: MatchInput): MigrationResult {
    const { oldFps, newFps, oldLabels } = input;
    const result: MigrationResult = { auto: [], review: [], lost: [] };

    const newByToken = new Map<string, ClassFingerprint>();
    for (const fp of newFps) {
        if (fp.token) newByToken.set(fp.token, fp);
    }

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
        }
    }

    return result;
}

/**
 * Composite similarity score in [0, 1]:
 *   - 0.20 weight: parents Jaccard
 *   - 0.20 weight: methodCount proximity (1 if equal, decays linearly)
 *   - 0.30 weight: methodSignatures Jaccard
 *   - 0.30 weight: fieldTypes Jaccard
 */
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

function jaccard<T>(a: Set<T>, b: Set<T>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const x of a) if (b.has(x)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 1 : intersection / union;
}

// ---------------------------------------------------------------------------
// matchClassMembers — pure function (Task 6: fields STRICT, Task 7: methods)
// ---------------------------------------------------------------------------

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

        const oldsOfType = oldByType.get(oldField.typeName) ?? [];
        const newsOfType = newByType.get(oldField.typeName) ?? [];

        // Rule 1: type unique on both sides → AUTO
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

        // Rule 2: type N×N with same position-within-type-group → AUTO (type+ordinal)
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

        // Rule 3: type disappeared → LOST
        if (newsOfType.length === 0) {
            out.lost.push({
                key: { kind: "field", className: newCls.obfName, fieldName: "" },
                oldObf: compoundKey,
                label,
                reason: `type ${oldField.typeName} disappeared`,
                parentClassMigration: oldCls.obfName,
            });
            continue;
        }

        // Rule 4: type count changed (N != M) → REVIEW with candidates sorted by |declIndex diff|
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
                score: 1 - Math.abs(f.declIndex - oldField.declIndex) /
                    Math.max(oldCls.fields.length, newCls.fields.length, 1),
                reason: `type ${oldField.typeName} count changed (old=${oldsOfType.length}, new=${newsOfType.length})`,
            }));
        out.review.push({
            key: { kind: "field", className: newCls.obfName, fieldName: "" },
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
    // Filled in Task 7. Empty stub — all params prefixed with _ to satisfy noUnusedParameters.
}
