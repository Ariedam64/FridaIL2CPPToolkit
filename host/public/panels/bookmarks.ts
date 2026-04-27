// Bookmarks panel — save/load/delete/export/import presets per game.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";
import { listHooks, listPatches } from "../lib/session.js";
import { onWsEvent } from "../lib/ws.js";

interface BookmarkMeta {
    slug: string;
    name: string;
    processName: string;
    updatedAt: string | null;
}

interface HookEntry { className: string; methodName: string; mode: string; value?: unknown }
interface PatchEntry { kind: string; className: string; field: string; value: unknown }
interface PinEntry { kind: string; className: string; fieldName: string; label: string }

interface Bookmark {
    slug: string;
    name: string;
    processName: string;
    notes: string;
    hooks: HookEntry[];
    patches: PatchEntry[];
    pins: PinEntry[];
    updatedAt: string | null;
}

function slugify(name: string): string {
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "unnamed";
}

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
}

async function fetchList(): Promise<BookmarkMeta[]> {
    return apiFetch<BookmarkMeta[]>("/api/bookmarks");
}

export async function loadBookmark(slug: string): Promise<void> {
    const bm = await apiFetch<Bookmark>(`/api/bookmarks/${slug}`);
    let count = 0;
    for (const h of bm.hooks ?? []) {
        logRpcLine(`[bookmark] hook ${h.className}.${h.methodName} (${h.mode})`);
        const args: unknown[] = [h.className, h.methodName];
        if (h.mode === "forceReturn") args.push(h.value);
        await rpcCall(h.mode, args);
        count++;
    }
    for (const p of bm.patches ?? []) {
        logRpcLine(`[bookmark] patch ${p.className}.${p.field} = ${JSON.stringify(p.value)}`);
        await rpcCall("patchStatic", [p.className, p.field, p.value]);
        count++;
    }
    for (const pin of bm.pins ?? []) {
        logRpcLine(`[bookmark] pin ${pin.className}.${pin.fieldName}`);
        await rpcCall("pinField", [pin.kind, pin.className, pin.fieldName, pin.label]);
        count++;
    }
    logRpcLine(`[bookmark] Loaded ${count} items from "${bm.name}"`);
    showToast(`Loaded ${count} items from "${bm.name}"`, 4000);
}

export async function findByProcess(processName: string): Promise<BookmarkMeta[]> {
    const list = await fetchList();
    return list.filter(bm => bm.processName === processName);
}

// ── Auto-offer toast (Task 5) ────────────────────────────────────────────────
let _autoOfferWired = false;

export function initBookmarkAutoOffer(): void {
    if (_autoOfferWired) return;
    _autoOfferWired = true;
    onWsEvent(async (ev) => {
        if (ev.type !== "attached") return;
        const processName = ev.name;
        // Check sessionStorage to avoid nagging
        const dismissKey = `bm-dismiss-${processName}`;
        if (sessionStorage.getItem(dismissKey)) return;
        try {
            const matches = await findByProcess(processName);
            if (!matches.length) return;
            const first = matches[0]!;
            const extra = matches.length > 1 ? ` (+${matches.length - 1} other presets — see Bookmarks tab)` : "";
            showAutoOfferToast(first, extra, dismissKey);
        } catch { /* ignore */ }
    });
}

function showAutoOfferToast(bm: BookmarkMeta, extra: string, dismissKey: string): void {
    // Remove existing toast
    document.getElementById("bm-auto-offer-toast")?.remove();

    const toast = document.createElement("div");
    toast.id = "bm-auto-offer-toast";
    toast.className = "panel";
    toast.style.cssText = [
        "position:fixed",
        "top:60px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:100",
        "min-width:360px",
        "max-width:560px",
        "padding:0",
        "transition:opacity 300ms",
    ].join(";");

    toast.innerHTML = `
        <div class="section-header" style="display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap">
            <span style="flex:1">▸ preset available for <strong>${bm.processName}</strong> — ${bm.name}${extra}</span>
            <button class="btn primary" id="bm-toast-load">LOAD</button>
            <button class="btn" id="bm-toast-dismiss">DISMISS</button>
        </div>
    `;

    document.body.appendChild(toast);

    let fadeTimer: ReturnType<typeof setTimeout> | null = null;

    function dismiss(): void {
        if (fadeTimer) clearTimeout(fadeTimer);
        sessionStorage.setItem(dismissKey, "1");
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 320);
    }

    toast.querySelector("#bm-toast-load")?.addEventListener("click", async () => {
        dismiss();
        try { await loadBookmark(bm.slug); } catch (e) { logRpcLine(`[bookmark] load error: ${String(e)}`); }
    });
    toast.querySelector("#bm-toast-dismiss")?.addEventListener("click", () => dismiss());

    // Auto-fade after 10s
    fadeTimer = setTimeout(() => dismiss(), 10000);
}

function showToast(msg: string, ms = 3000): void {
    const el = document.createElement("div");
    el.className = "panel";
    el.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:200;padding:var(--s-2) var(--s-3);transition:opacity 300ms";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 320); }, ms);
}

// ── Panel render ─────────────────────────────────────────────────────────────

export function renderBookmarks(container: HTMLElement): void {
    container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:var(--s-3);padding:var(--s-3)">
            <div class="section-header" style="display:flex;align-items:center;gap:var(--s-2)">
                bookmarks
                <button class="btn primary" id="bm-save" style="margin-left:auto">SAVE CURRENT</button>
                <button class="btn" id="bm-export">EXPORT</button>
                <label class="btn" style="cursor:pointer">IMPORT<input type="file" id="bm-import" accept=".json" style="display:none"></label>
            </div>
            <div id="bm-list" style="display:flex;flex-direction:column;gap:var(--s-2)"></div>
        </div>
    `;

    const listEl = container.querySelector<HTMLElement>("#bm-list")!;

    async function refresh(): Promise<void> {
        const items = await fetchList().catch(() => [] as BookmarkMeta[]);
        listEl.innerHTML = "";
        if (!items.length) {
            listEl.innerHTML = `<div style="color:var(--ink-disabled);font-size:12px;padding:var(--s-2)">no bookmarks yet</div>`;
            return;
        }
        for (const bm of items) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2);background:var(--surface-2,#1a1a1a);font-family:var(--font-mono);font-size:12px";
            const date = bm.updatedAt ? new Date(bm.updatedAt).toLocaleDateString() : "—";
            row.innerHTML = `
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${bm.name}">${bm.name}</span>
                <span class="tag">${bm.processName || "?"}</span>
                <span style="color:var(--ink-disabled);font-size:11px">${date}</span>
                <button class="btn primary" data-slug="${bm.slug}" data-action="load">LOAD</button>
                <button class="btn" data-slug="${bm.slug}" data-action="delete">DEL</button>
            `;
            listEl.appendChild(row);
        }
    }

    void refresh();

    // ── SAVE CURRENT
    container.querySelector("#bm-save")?.addEventListener("click", async () => {
        // Determine attached process name from status
        let processName = "";
        try {
            const st = await fetch("/api/status").then(r => r.json()) as { attached: boolean; info: { name: string } | null };
            processName = st.info?.name ?? "";
        } catch { /* ignore */ }

        const today = new Date().toISOString().slice(0, 10);
        const prefill = processName ? `${processName} (auto-saved ${today})` : `bookmark ${today}`;
        const name = window.prompt("Bookmark name:", prefill);
        if (!name || !name.trim()) return;

        let pins: PinEntry[] = [];
        try {
            const raw = await rpcCall<Array<{ id?: unknown; kind: string; className: string; fieldName: string; label: string }>>("listPins");
            pins = (raw ?? []).map(({ kind, className, fieldName, label }) => ({ kind, className, fieldName, label }));
        } catch { /* not attached or no pins */ }

        const body = {
            name: name.trim(),
            processName,
            notes: "",
            hooks: listHooks(),
            patches: listPatches(),
            pins,
        };

        const slug = slugify(name.trim());
        try {
            await fetch(`/api/bookmarks/${slug}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            logRpcLine(`[bookmark] saved "${name.trim()}" (${slug})`);
            await refresh();
        } catch (e) {
            logRpcLine(`[bookmark] save error: ${String(e)}`);
        }
    });

    // ── EXPORT
    container.querySelector("#bm-export")?.addEventListener("click", async () => {
        const items = await fetchList().catch(() => [] as BookmarkMeta[]);
        const full: Bookmark[] = [];
        for (const bm of items) {
            try { full.push(await apiFetch<Bookmark>(`/api/bookmarks/${bm.slug}`)); } catch { /* skip */ }
        }
        const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // ── IMPORT
    container.querySelector<HTMLInputElement>("#bm-import")?.addEventListener("change", async (ev) => {
        const file = (ev.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text) as unknown;
            const list: Bookmark[] = Array.isArray(parsed) ? parsed as Bookmark[] : [parsed as Bookmark];
            let imported = 0;
            for (const bm of list) {
                if (!bm.name) continue;
                const slug = slugify(bm.name);
                await fetch(`/api/bookmarks/${slug}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(bm),
                });
                imported++;
            }
            logRpcLine(`[bookmark] imported ${imported} bookmark(s)`);
            await refresh();
        } catch (e) {
            logRpcLine(`[bookmark] import error: ${String(e)}`);
        }
        (ev.target as HTMLInputElement).value = "";
    });

    // ── LOAD / DELETE row actions
    listEl.addEventListener("click", async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
        if (!btn) return;
        const slug = btn.dataset["slug"] ?? "";
        const action = btn.dataset["action"];
        if (action === "load") {
            try { await loadBookmark(slug); } catch (err) { logRpcLine(`[bookmark] load error: ${String(err)}`); }
        } else if (action === "delete") {
            if (!window.confirm(`Delete bookmark "${slug}"?`)) return;
            try {
                await fetch(`/api/bookmarks/${slug}`, { method: "DELETE" });
                logRpcLine(`[bookmark] deleted "${slug}"`);
                await refresh();
            } catch (err) { logRpcLine(`[bookmark] delete error: ${String(err)}`); }
        }
    });
}
