"use strict";
// Pure helpers used by the universal search. Kept vscode-free for vitest.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSearchInput = parseSearchInput;
exports.filterByKind = filterByKind;
const PREFIX_RE = /^:(class|method|field)(?:\s+|$)/;
/** Detects `:class`, `:method`, `:field` prefixes and strips them. */
function parseSearchInput(raw) {
    const m = PREFIX_RE.exec(raw);
    if (!m)
        return { kind: null, query: raw };
    return {
        kind: m[1],
        query: raw.slice(m[0].length),
    };
}
/** Restrict an index to a single kind. */
function filterByKind(items, kind) {
    if (kind === null)
        return items;
    return items.filter((e) => e.kind === kind);
}
//# sourceMappingURL=search-filters.js.map