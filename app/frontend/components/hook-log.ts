// app/frontend/components/hook-log.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { HookEvent, StoredHook } from "../core/types.js";

const RING_LIMIT = 10_000;

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHookLog(host: HTMLElement): void {
    host.className = "hook-log-panel";
    host.innerHTML = `
        <div class="right-tabs">
            <div class="right-tab active" data-tab="stream"><span class="live-dot"></span>Stream</div>
            <div class="right-tab" data-tab="summary">Summary <span class="count-pill" id="hl-count-summary">0</span></div>
            <div class="right-tab" data-tab="hooks">Hooks <span class="count-pill" id="hl-count-hooks">0</span></div>
        </div>
        <div class="log-toolbar">
            <input class="filter-mini" id="hl-filter" placeholder="Filter events…">
            <button class="icon-btn-mini" id="hl-pause">⏸</button>
            <button class="icon-btn-mini" id="hl-clear">🗑</button>
            <button class="icon-btn-mini" id="hl-export">⬇</button>
        </div>
        <div id="hl-content" class="events"><div style="padding:1em;color:var(--text-faint)">No hits yet.</div></div>
    `;

    const ring: HookEvent[] = [];
    const hooksMap = new Map<string, StoredHook>(); // installedHookId -> stored
    let activeTab: "stream" | "summary" | "hooks" = "stream";
    let paused = false;
    let filter = "";

    const content = host.querySelector<HTMLDivElement>("#hl-content")!;

    function refreshHooks(): void {
        void api.getHooks().then(({ hooks }) => {
            hooksMap.clear();
            for (const h of hooks) {
                if (h.installedHookId) hooksMap.set(h.installedHookId, h);
            }
            host.querySelector("#hl-count-hooks")!.textContent = String(hooks.length);
            if (activeTab === "hooks") renderHooksTab();
        });
    }

    function passesFilter(e: HookEvent): boolean {
        if (!filter) return true;
        const spec = hooksMap.get(e.hookId)?.spec;
        const hay = `${spec?.className ?? ""} ${spec?.methodName ?? ""} ${e.args.join(" ")} ${e.retval ?? ""} ${e.error ?? ""}`.toLowerCase();
        return hay.includes(filter);
    }

    function fmtRow(e: HookEvent): string {
        const spec = hooksMap.get(e.hookId)?.spec;
        const cls = spec ? spec.className : e.hookId;
        const m = spec ? spec.methodName : "?";
        const ts = new Date(e.ts).toISOString().slice(11, 23);
        const ret = e.error
            ? `<span class="event-ret">throw ${escape(e.error)}</span>`
            : `<span class="event-ret">${escape(e.retval ?? "void")}</span>`;
        const stack = e.stackFrames?.length
            ? `<div class="event-args" style="opacity:0.7">${e.stackFrames.map(escape).join("<br>")}</div>`
            : "";
        return `
            <div class="event${e.error ? " error" : ""}">
                <div class="event-head">
                    <span class="event-time">${ts}</span>
                    <span class="event-name">${escape(cls)}.${escape(m)}</span>
                </div>
                <div class="event-args">(${escape(e.args.join(", "))}) → ${ret}</div>
                ${stack}
            </div>
        `;
    }

    function renderStream(): void {
        const visible = ring.filter(passesFilter);
        if (visible.length === 0) {
            content.innerHTML = `<div style="padding:1em;color:var(--text-faint)">No hits${filter ? " matching filter" : ""}.</div>`;
            return;
        }
        content.innerHTML = visible.slice(-200).map(fmtRow).join("");
        content.scrollTop = content.scrollHeight;
    }

    function renderSummary(): void {
        const counts = new Map<string, { hookId: string; hits: number; lastTs: number; lastRet: string | null; lastErr: string | null }>();
        for (const e of ring) {
            const key = e.hookId;
            let s = counts.get(key);
            if (!s) { s = { hookId: key, hits: 0, lastTs: 0, lastRet: null, lastErr: null }; counts.set(key, s); }
            s.hits++; s.lastTs = e.ts; s.lastRet = e.retval; s.lastErr = e.error ?? null;
        }
        const rows = [...counts.values()].sort((a, b) => b.hits - a.hits);
        host.querySelector("#hl-count-summary")!.textContent = String(rows.length);
        content.innerHTML = rows.length === 0
            ? `<div style="padding:1em;color:var(--text-faint)">No data.</div>`
            : rows.map((s) => {
                const spec = hooksMap.get(s.hookId)?.spec;
                const name = spec ? `${spec.className}.${spec.methodName}` : s.hookId;
                return `
                    <div class="event">
                        <div class="event-head">
                            <span class="event-name">${escape(name)}</span>
                            <span style="margin-left:auto;color:var(--indigo-hover);font-weight:600">${s.hits} hits</span>
                        </div>
                        <div class="event-args">last: ${s.lastErr ? `<span class="event-ret">throw ${escape(s.lastErr)}</span>` : `<span class="event-ret">${escape(s.lastRet ?? "void")}</span>`}</div>
                    </div>
                `;
            }).join("");
    }

    function renderHooksTab(): void {
        const hooks = [...hooksMap.values()];
        if (hooks.length === 0) {
            content.innerHTML = `<div style="padding:1em;color:var(--text-faint)">No installed hooks.</div>`;
            return;
        }
        content.innerHTML = hooks.map((h) => `
            <div class="event">
                <div class="event-head">
                    <span class="event-name">${escape(h.spec.className)}.${escape(h.spec.methodName)}</span>
                    <span style="margin-left:auto;color:var(--text-faint);font-size:9px">[${h.spec.template}]</span>
                </div>
                <div class="event-args">
                    <button class="icon-btn-mini" data-hook-uninstall="${h.id}">⏸ Uninstall</button>
                    <button class="icon-btn-mini" data-hook-remove="${h.id}">🗑 Delete</button>
                </div>
            </div>
        `).join("");
        content.querySelectorAll<HTMLButtonElement>("[data-hook-uninstall]").forEach((b) => {
            b.addEventListener("click", () => api.uninstallHook(b.dataset.hookUninstall!));
        });
        content.querySelectorAll<HTMLButtonElement>("[data-hook-remove]").forEach((b) => {
            b.addEventListener("click", () => api.removeHook(b.dataset.hookRemove!));
        });
    }

    function rerender(): void {
        if (activeTab === "stream") renderStream();
        else if (activeTab === "summary") renderSummary();
        else renderHooksTab();
    }

    host.querySelectorAll<HTMLElement>(".right-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            activeTab = tab.dataset.tab as typeof activeTab;
            host.querySelectorAll<HTMLElement>(".right-tab").forEach((t) => t.classList.toggle("active", t === tab));
            rerender();
        });
    });

    host.querySelector<HTMLInputElement>("#hl-filter")!.addEventListener("input", (ev) => {
        filter = (ev.target as HTMLInputElement).value.toLowerCase();
        rerender();
    });
    host.querySelector<HTMLButtonElement>("#hl-pause")!.addEventListener("click", (ev) => {
        paused = !paused;
        (ev.target as HTMLButtonElement).textContent = paused ? "▶" : "⏸";
    });
    host.querySelector<HTMLButtonElement>("#hl-clear")!.addEventListener("click", () => {
        ring.length = 0; rerender();
    });
    host.querySelector<HTMLButtonElement>("#hl-export")!.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(ring, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `hook-log-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    subscribe("hook-event", (e: HookEvent) => {
        ring.push(e);
        if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
        if (!paused) rerender();
    });
    subscribe("hook-auto-revert", (e: any) => {
        // Synthesize a HookEvent-shaped row so the Stream tab shows the revert.
        const synthetic: HookEvent = {
            type: "hook-event",
            hookId: e.hookId,
            ts: e.ts,
            self: null,
            args: [],
            retval: null,
            error: `auto-reverted (${e.reason})${e.detail ? ": " + e.detail : ""}`,
            stackFrames: undefined,
        };
        ring.push(synthetic);
        if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
        if (!paused) rerender();
        // Console hint for the user
        console.warn(`[hook-auto-revert] hookId=${e.hookId} reason=${e.reason}`, e.detail);
    });
    subscribe("hook-store-change", () => refreshHooks());
    subscribe("profile-attached", () => { ring.length = 0; refreshHooks(); rerender(); });
    subscribe("profile-detached", () => { ring.length = 0; hooksMap.clear(); rerender(); });

    refreshHooks();
}
