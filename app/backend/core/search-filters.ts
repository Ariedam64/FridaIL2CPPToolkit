// Pure helpers used by the universal search. Kept vscode-free for vitest.

export type SearchKind = "class" | "method" | "field";

export interface IndexEntry {
    kind: SearchKind;
    label: string;
    description: string;
    detail: string;
    target: { command: string; args: unknown[] };
}

export interface ParsedSearchInput {
    kind: SearchKind | null;
    query: string;
}

const PREFIX_RE = /^:(class|method|field)(?:\s+|$)/;

/** Detects `:class`, `:method`, `:field` prefixes and strips them. */
export function parseSearchInput(raw: string): ParsedSearchInput {
    const m = PREFIX_RE.exec(raw);
    if (!m) return { kind: null, query: raw };
    return {
        kind: m[1] as SearchKind,
        query: raw.slice(m[0].length),
    };
}

/** Restrict an index to a single kind. */
export function filterByKind(items: IndexEntry[], kind: SearchKind | null): IndexEntry[] {
    if (kind === null) return items;
    return items.filter((e) => e.kind === kind);
}
