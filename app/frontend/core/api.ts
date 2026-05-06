// app/frontend/core/api.ts — fetch wrapper for /api/*

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? `${res.status} ${res.statusText}`);
    }
    return await res.json() as T;
}

export const api = {
    rpc<T = unknown>(method: string, args: unknown[] = []): Promise<{ result: T }> {
        return call("POST", "/api/call", { method, args });
    },
    getProfile() { return call<{ profile: import("./types.js").ProfileLite | null }>("GET", "/api/profile"); },
    listProcesses() { return call<{ processes: import("./types.js").ProcessInfo[] }>("GET", "/api/profile/processes"); },
    attach(pid: number) { return call("POST", "/api/profile/attach", { pid }); },
    detach() { return call("POST", "/api/profile/detach"); },

    getLabels() { return call<any>("GET", "/api/labels"); },
    setLabel(kind: "class" | "method" | "field", key: any, label: string) {
        return call("POST", `/api/labels/${kind}`, { key, label });
    },
    removeLabel(kind: "class" | "method" | "field", key: any) {
        return call("POST", `/api/labels/${kind}`, { key, remove: true });
    },
    undoLabel() { return call("POST", "/api/labels/undo"); },
    redoLabel() { return call("POST", "/api/labels/redo"); },

    getAnnotations() { return call<{ bookmarks: any[]; notes: any[] }>("GET", "/api/annotations"); },
    toggleBookmark(key: any) { return call("POST", "/api/annotations/bookmark", { key }); },
    setNote(key: any, markdown: string) { return call("POST", "/api/annotations/note", { key, markdown }); },
    removeNote(key: any) { return call("POST", "/api/annotations/note", { key, remove: true }); },

    getHooks() { return call<{ hooks: import("./types.js").StoredHook[] }>("GET", "/api/hooks"); },
    addHook(spec: import("./types.js").HookSpec) { return call<{ stored: import("./types.js").StoredHook }>("POST", "/api/hooks/add", { spec }); },
    installHook(id: string) { return call("POST", "/api/hooks/install", { id }); },
    uninstallHook(id: string) { return call("POST", "/api/hooks/uninstall", { id }); },
    updateHook(id: string, spec: import("./types.js").HookSpec) { return call("POST", "/api/hooks/update", { id, spec }); },
    removeHook(id: string) { return call("POST", "/api/hooks/remove", { id }); },
    clearAllHooks() { return call<{ count: number }>("POST", "/api/hooks/clear-all"); },

    getMigrations() { return call<any>("GET", "/api/migrations"); },
    acceptMigration(oldObf: string, newObf: string) { return call("POST", "/api/migrations/accept", { oldObf, newObf }); },
    rejectMigration(oldObf: string) { return call("POST", "/api/migrations/reject", { oldObf }); },
};
