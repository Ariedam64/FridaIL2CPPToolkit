// app/frontend/core/api.ts — fetch wrapper for /api/*

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
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

    getNetworkFrames(opts: { limit?: number; sinceId?: string; filter?: string; direction?: "in" | "out" } = {}) {
        const q = new URLSearchParams();
        if (opts.limit !== undefined) q.set("limit", String(opts.limit));
        if (opts.sinceId) q.set("sinceId", opts.sinceId);
        if (opts.filter) q.set("filter", opts.filter);
        if (opts.direction) q.set("direction", opts.direction);
        const qs = q.toString();
        return call<{ frames: import("./types.js").NetFrame[] }>("GET", `/api/network/frames${qs ? "?" + qs : ""}`);
    },
    getNetworkTypes() {
        return call<{ types: import("./types.js").NetMessageType[] }>("GET", "/api/network/types");
    },
    getNetworkInstances(typeKey: import("./types.js").NetTypeKey, limit = 50) {
        const enc = encodeURIComponent(`${typeKey.ns ?? ""}~${typeKey.className}`);
        return call<{ type: import("./types.js").NetMessageType; frames: import("./types.js").NetFrame[] }>(
            "GET", `/api/network/types/${enc}/instances?limit=${limit}`,
        );
    },
    clearNetworkFrames() {
        return call("DELETE", "/api/network/frames");
    },
    getSerializerConfig() {
        return call<{ config: import("./types.js").NetSerializerConfig }>("GET", "/api/network/serializer-config");
    },
    putSerializerConfig(entries: import("./types.js").NetSerializerEntry[]) {
        return call("PUT", "/api/network/serializer-config", { entries });
    },
    startNetworkCapture() {
        return call<{ installed: number; failed: import("./types.js").NetSerializerEntry[] }>("POST", "/api/network/start");
    },
    stopNetworkCapture() {
        return call<{ reverted: number }>("POST", "/api/network/stop");
    },

    // ---- v1.4 Instances ----
    listInstances() {
        return call<{ instances: import("./types.js").CapturedInstanceLite[] }>("GET", "/api/instances/list");
    },
    captureInstance(payload: import("./types.js").InstanceRecipeStep) {
        return call<{ key: string; summary: string }>("POST", "/api/instances/capture", payload);
    },
    deleteInstance(key: string) {
        return call<{ ok: boolean }>("DELETE", `/api/instances/${encodeURIComponent(key)}`);
    },
    readInstanceFields(key: string) {
        return call<{ alive: boolean; fields: import("./types.js").FieldReadLite[]; error?: string }>(
            "POST", `/api/instances/${encodeURIComponent(key)}/read-fields`,
        );
    },
    writeInstanceField(key: string, fieldName: string, value: unknown) {
        return call<{ before: string; after: string }>(
            "POST", `/api/instances/${encodeURIComponent(key)}/write-field`, { fieldName, value },
        );
    },
    callInstanceMethod(key: string, methodName: string, args: unknown[]) {
        return call<{ result: string }>(
            "POST", `/api/instances/${encodeURIComponent(key)}/call`, { methodName, args },
        );
    },
    getInstancesReadOnly() {
        return call<{ enabled: boolean }>("GET", "/api/instances/read-only");
    },
    setInstancesReadOnly(enabled: boolean) {
        return call<{ enabled: boolean }>("POST", "/api/instances/read-only", { enabled });
    },
    listRecipes() {
        return call<{ recipes: import("./types.js").InstanceRecipe[] }>("GET", "/api/instances/recipes");
    },
    addRecipe(name: string, steps: import("./types.js").InstanceRecipeStep[], description?: string) {
        return call<{ recipe: import("./types.js").InstanceRecipe }>(
            "POST", "/api/instances/recipes", { name, steps, description },
        );
    },
    updateRecipe(id: string, patch: Partial<import("./types.js").InstanceRecipe>) {
        return call<{ recipe: import("./types.js").InstanceRecipe }>(
            "PUT", `/api/instances/recipes/${encodeURIComponent(id)}`, patch,
        );
    },
    deleteRecipe(id: string) {
        return call<{ ok: boolean }>("DELETE", `/api/instances/recipes/${encodeURIComponent(id)}`);
    },
    replayRecipe(id: string) {
        return call<import("./types.js").InstanceRecipeReplayResult>(
            "POST", `/api/instances/recipes/${encodeURIComponent(id)}/replay`,
        );
    },
    getInstanceHistory() {
        return call<{ entries: import("./types.js").InstanceHistoryEntry[] }>("GET", "/api/instances/history");
    },
    clearInstanceHistory() {
        return call<{ ok: boolean }>("DELETE", "/api/instances/history");
    },
    previewInstance(className: string, index: number, maxFields = 10) {
        return call<{ fields: import("./types.js").FieldReadLite[] }>(
            "POST", "/api/instances/preview", { className, index, maxFields },
        );
    },
    scanStart(value: string | number | boolean, options: { classFilter?: string; maxMatches?: number } = {}) {
        return call<{ matches: import("./types.js").ScanMatchLite[] }>(
            "POST", "/api/instances/scan/start", { value, ...options },
        );
    },
    scanRefine(value: string | number | boolean) {
        return call<{ matches: import("./types.js").ScanMatchLite[] }>(
            "POST", "/api/instances/scan/refine", { value },
        );
    },
    scanReset() {
        return call<{ ok: boolean }>("POST", "/api/instances/scan/reset", {});
    },
    getScan() {
        return call<{ matches: import("./types.js").ScanMatchLite[] }>("GET", "/api/instances/scan");
    },
    captureFromScan(matchIndex: number, asKey: string) {
        return call<{ key: string; summary: string }>(
            "POST", "/api/instances/scan/capture", { matchIndex, asKey },
        );
    },
};
