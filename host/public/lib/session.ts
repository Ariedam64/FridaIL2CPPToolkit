// Session tracker — accumulates hooks and patches applied in the current session.
// Cleared on detach. Not persisted to localStorage (in-memory only).

export interface HookEntry {
    className: string;
    methodName: string;
    mode: "hook" | "replaceNoop" | "forceReturn";
    value?: unknown;
}

export interface PatchEntry {
    kind: "static";
    className: string;
    field: string;
    value: unknown;
}

const hooks: HookEntry[] = [];
const patches: PatchEntry[] = [];

/** Record a hook/noop/forceReturn. Dedupes by className+methodName (last write wins). */
export function recordHook(e: HookEntry): void {
    const idx = hooks.findIndex(h => h.className === e.className && h.methodName === e.methodName);
    if (idx >= 0) hooks[idx] = e;
    else hooks.push(e);
}

/** Record a static patch. Dedupes by className+field (last write wins). */
export function recordPatch(e: PatchEntry): void {
    const idx = patches.findIndex(p => p.className === e.className && p.field === e.field);
    if (idx >= 0) patches[idx] = e;
    else patches.push(e);
}

export function listHooks(): HookEntry[] { return [...hooks]; }
export function listPatches(): PatchEntry[] { return [...patches]; }

/** Called on detach — wipes both arrays. */
export function clearSession(): void {
    hooks.length = 0;
    patches.length = 0;
}
