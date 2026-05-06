// app/frontend/components/command-palette.ts
import { api } from "../core/api.js";
import { icons } from "../core/icons.js";

interface PaletteItem {
    label: string;
    meta?: string;
    icon?: string;
    action: () => void;
}

let _open = false;
let _overlay: HTMLDivElement | null = null;

export function bindPaletteShortcut(): void {
    document.addEventListener("keydown", (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
            ev.preventDefault();
            if (!_open) void open();
        } else if (ev.key === "Escape" && _open) {
            close();
        }
    });
}

async function open(): Promise<void> {
    _open = true;
    _overlay = document.createElement("div");
    _overlay.className = "cmdk-overlay";
    _overlay.innerHTML = `
        <div class="cmdk">
            <input class="cmdk-input" id="cmdk-input" placeholder="Search classes / methods / fields, or type a command…" autofocus>
            <div class="cmdk-results" id="cmdk-results">Type to search…</div>
        </div>
    `;
    _overlay.addEventListener("click", (ev) => { if (ev.target === _overlay) close(); });
    document.body.appendChild(_overlay);
    const input = _overlay.querySelector<HTMLInputElement>("#cmdk-input")!;
    const results = _overlay.querySelector<HTMLElement>("#cmdk-results")!;
    let activeIdx = 0;
    let items: PaletteItem[] = [];

    const commands: PaletteItem[] = [
        { label: "Open Hooks", icon: icons.hook(), action: () => { location.hash = "#/hooks"; } },
        { label: "Open Bookmarks", icon: icons.star(), action: () => { location.hash = "#/bookmarks"; } },
        { label: "Open Migrations", icon: icons.refresh(), action: () => { location.hash = "#/migrations"; } },
        { label: "Open Process Explorer", icon: icons.box(), action: () => { location.hash = "#/explorer"; } },
        { label: "Detach", icon: icons.eject(), action: async () => { await api.detach(); } },
    ];

    let labelsCache: any = null;

    async function rebuild(query: string): Promise<void> {
        const q = query.trim().toLowerCase();
        if (!q) {
            items = commands;
            activeIdx = 0;
            renderItems();
            return;
        }
        // Commands matching
        const cmdMatches = commands.filter((c) => c.label.toLowerCase().includes(q));
        // Class search via labels (cheap)
        if (!labelsCache) {
            try { labelsCache = await api.getLabels(); }
            catch { labelsCache = { classes: {}, methods: {}, fields: {} }; }
        }
        const classMatches: PaletteItem[] = [];
        for (const [obf, entry] of Object.entries<any>(labelsCache.classes ?? {})) {
            if (classMatches.length >= 50) break;
            if (entry.label.toLowerCase().includes(q) || obf.toLowerCase().includes(q)) {
                classMatches.push({
                    label: entry.label,
                    meta: obf,
                    icon: icons.layers(),
                    action: () => {
                        location.hash = "#/explorer";
                        setTimeout(() => window.dispatchEvent(new CustomEvent("frida:open-class", { detail: obf })), 100);
                    },
                });
            }
        }
        items = [...cmdMatches, ...classMatches];
        activeIdx = 0;
        renderItems();
    }

    function renderItems(): void {
        if (items.length === 0) { results.innerHTML = `<div style="padding:1em;color:var(--text-faint)">No matches.</div>`; return; }
        results.innerHTML = items.map((it, i) => `
            <div class="cmdk-row${i === activeIdx ? " active" : ""}" data-idx="${i}">
                <span class="icon">${it.icon ?? "·"}</span>
                <span class="label">${escape(it.label)}</span>
                ${it.meta ? `<span class="meta">${escape(it.meta)}</span>` : ""}
            </div>
        `).join("");
        results.querySelectorAll<HTMLElement>(".cmdk-row").forEach((r) => {
            r.addEventListener("click", () => { runItem(parseInt(r.dataset.idx!, 10)); });
        });
    }

    function runItem(i: number): void {
        const it = items[i];
        if (!it) return;
        close();
        it.action();
    }

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    input.addEventListener("input", () => { void rebuild(input.value); });
    input.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowDown") { activeIdx = Math.min(items.length - 1, activeIdx + 1); renderItems(); ev.preventDefault(); }
        else if (ev.key === "ArrowUp") { activeIdx = Math.max(0, activeIdx - 1); renderItems(); ev.preventDefault(); }
        else if (ev.key === "Enter") { runItem(activeIdx); ev.preventDefault(); }
    });

    void rebuild("");
}

function close(): void {
    if (_overlay) { document.body.removeChild(_overlay); _overlay = null; }
    _open = false;
}
