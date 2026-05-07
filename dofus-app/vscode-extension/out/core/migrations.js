"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchFingerprints = matchFingerprints;
exports.similarity = similarity;
const AUTO_THRESHOLD = 0.95;
const REVIEW_THRESHOLD = 0.60;
function matchFingerprints(input) {
    const { oldFps, newFps, oldLabels } = input;
    const result = { auto: [], review: [], lost: [] };
    const newByToken = new Map();
    for (const fp of newFps) {
        if (fp.token)
            newByToken.set(fp.token, fp);
    }
    for (const oldFp of oldFps) {
        const label = oldLabels[oldFp.obfName];
        if (!label)
            continue;
        const key = { kind: "class", className: oldFp.obfName };
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
        }
        else {
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
function similarity(a, b) {
    const parentScore = jaccard(new Set(a.parents), new Set(b.parents));
    const mcDiff = Math.abs(a.methodCount - b.methodCount);
    const mcMax = Math.max(a.methodCount, b.methodCount, 1);
    const methodCountScore = Math.max(0, 1 - mcDiff / mcMax);
    const sigScore = jaccard(new Set(a.methodSignatures), new Set(b.methodSignatures));
    const fieldScore = jaccard(new Set(a.fieldTypes), new Set(b.fieldTypes));
    return parentScore * 0.20 + methodCountScore * 0.20 + sigScore * 0.30 + fieldScore * 0.30;
}
function jaccard(a, b) {
    if (a.size === 0 && b.size === 0)
        return 1;
    let intersection = 0;
    for (const x of a)
        if (b.has(x))
            intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 1 : intersection / union;
}
//# sourceMappingURL=migrations.js.map