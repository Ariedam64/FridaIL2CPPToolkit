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
    LabelKey,
    MigrationResult,
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
