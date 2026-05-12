// Items sub-tab. Browses the pre-built static catalogs (items, monsters,
// jobs, skills, types, collectables) served at /api/dofus/catalog/<name>.
// Each tab fetches its catalog once on first open, caches it in memory, and
// filters client-side by name or id. Icons come from /api/dofus/items|monsters/icon/<iconId>.png.

import type { PluginPageContext } from "../../../frontend/core/plugin-types";

const TABS = [
    { id: "items",        label: "Items",      iconKind: "items"    as const },
    { id: "monsters",     label: "Monstres",   iconKind: "monsters" as const },
    { id: "jobs",         label: "Métiers",    iconKind: "none"     as const },
    { id: "skills",       label: "Skills",     iconKind: "none"     as const },
    { id: "itemtypes",    label: "Types",      iconKind: "none"     as const },
    { id: "collectables", label: "Collectables",iconKind: "none"    as const },
] as const;
type TabId = typeof TABS[number]["id"];
const TAB_BY_ID = new Map(TABS.map((t) => [t.id, t]));

interface CatalogEntry {
    id?: number;
    entityId?: number;
    name?: string;
    iconId?: number;
    gfxId?: number;
    typeId?: number;
    raceId?: number;
    level?: number;
    parentJobId?: number;
    superTypeId?: number;
    categoryId?: number;
    gatheredResourceItem?: number;
    elementActionId?: number;
    levelMin?: number;
}

interface CatalogFile {
    name: string;
    count: number;
    items: CatalogEntry[];
}

const catalogCache: Partial<Record<TabId, CatalogFile>> = {};
const PAGE_STEP = 60;

interface TabState { query: string; visible: number }
const tabState: Record<TabId, TabState> = {
    items:        { query: "", visible: PAGE_STEP },
    monsters:     { query: "", visible: PAGE_STEP },
    jobs:         { query: "", visible: PAGE_STEP },
    skills:       { query: "", visible: PAGE_STEP },
    itemtypes:    { query: "", visible: PAGE_STEP },
    collectables: { query: "", visible: PAGE_STEP },
};
let currentTab: TabId = "items";

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
}

async function loadCatalog(tab: TabId): Promise<CatalogFile> {
    const cached = catalogCache[tab];
    if (cached) return cached;
    const r = await fetch(`/api/dofus/catalog/${tab}`);
    if (!r.ok) throw new Error(`catalog ${tab}: HTTP ${r.status}`);
    const data = await r.json() as CatalogFile;
    catalogCache[tab] = data;
    return data;
}

function iconHtml(tab: TabId, e: CatalogEntry): string {
    const kind = TAB_BY_ID.get(tab)?.iconKind;
    if (kind === "items" && e.iconId !== undefined) {
        return `<img src="/api/dofus/items/icon/${e.iconId}.png" loading="lazy" style="width:40px;height:40px;object-fit:contain;background:#1a1a1a;border-radius:4px" onerror="this.style.opacity='0.2'">`;
    }
    if (kind === "monsters" && e.iconId !== undefined) {
        return `<img src="/api/dofus/monsters/icon/${e.iconId}.png" loading="lazy" style="width:40px;height:40px;object-fit:contain;background:#1a1a1a;border-radius:4px" onerror="this.style.opacity='0.2'">`;
    }
    // Placeholder: id badge.
    const idLabel = String(e.id ?? e.entityId ?? "?").slice(0, 4);
    return `<div style="width:40px;height:40px;background:#1a1a1a;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#444;font:bold 11px monospace">${escapeHtml(idLabel)}</div>`;
}

function metaLine(tab: TabId, e: CatalogEntry): string {
    const parts: string[] = [];
    if (tab === "items" && e.level !== undefined)               parts.push(`niv ${e.level}`);
    if (tab === "items" && e.typeId !== undefined)              parts.push(`type ${e.typeId}`);
    if (tab === "monsters" && e.raceId !== undefined)           parts.push(`race ${e.raceId}`);
    if (tab === "skills"   && e.parentJobId !== undefined)      parts.push(`job ${e.parentJobId}`);
    if (tab === "skills"   && e.levelMin !== undefined)         parts.push(`niv min ${e.levelMin}`);
    if (tab === "skills"   && e.gatheredResourceItem !== undefined && e.gatheredResourceItem > 0) parts.push(`item ${e.gatheredResourceItem}`);
    if (tab === "itemtypes" && e.superTypeId !== undefined)     parts.push(`super ${e.superTypeId}`);
    if (tab === "itemtypes" && e.categoryId !== undefined)      parts.push(`cat ${e.categoryId}`);
    return parts.join(" · ");
}

function renderEntry(tab: TabId, e: CatalogEntry): string {
    const id = e.id ?? e.entityId ?? "?";
    const name = e.name ?? `#${id}`;
    const meta = metaLine(tab, e);
    return `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;background:#0f0f0f;border:1px solid #1f1f1f;border-radius:6px;font-size:12px">
            ${iconHtml(tab, e)}
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
                <div style="color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div style="color:#666;font-size:10px;display:flex;gap:8px;flex-wrap:wrap">
                    <code style="color:#9bd">#${id}</code>
                    ${meta ? `<span>${escapeHtml(meta)}</span>` : ""}
                </div>
            </div>
        </div>
    `;
}

function filterEntries(entries: CatalogEntry[], query: string): CatalogEntry[] {
    const q = query.toLowerCase().trim();
    if (!q) return entries;
    // Search by name (substring) or by id (exact prefix match on the integer).
    const idMatch = /^\d+$/.test(q);
    return entries.filter((e) => {
        const idStr = String(e.id ?? e.entityId ?? "");
        if (idMatch && idStr.startsWith(q)) return true;
        const name = (e.name ?? "").toLowerCase();
        return name.includes(q);
    });
}

async function refresh(host: HTMLElement): Promise<void> {
    const grid = host.querySelector<HTMLElement>("[data-region='catalog-grid']");
    const status = host.querySelector<HTMLElement>("[data-region='catalog-status']");
    const loadMore = host.querySelector<HTMLButtonElement>("[data-action='load-more']");
    if (!grid || !status || !loadMore) return;

    grid.innerHTML = `<div style="grid-column:1/-1;color:#666;font-style:italic;padding:24px;text-align:center">Loading ${currentTab}…</div>`;
    status.textContent = "";
    loadMore.style.display = "none";

    let data: CatalogFile;
    try {
        data = await loadCatalog(currentTab);
    } catch (e) {
        grid.innerHTML = `<div style="grid-column:1/-1;color:#f87171;padding:16px">Erreur: ${escapeHtml(String(e))}</div>`;
        return;
    }

    const state = tabState[currentTab];
    const filtered = filterEntries(data.items, state.query);
    const visible = filtered.slice(0, state.visible);

    grid.innerHTML = visible.length === 0
        ? `<div style="grid-column:1/-1;color:#666;font-style:italic;padding:24px;text-align:center">Rien à afficher</div>`
        : visible.map((e) => renderEntry(currentTab, e)).join("");
    status.textContent = `${visible.length} / ${filtered.length}${state.query ? " (filtré)" : ""} sur ${data.count}`;
    loadMore.style.display = filtered.length > visible.length ? "" : "none";
}

function updateTabStyles(host: HTMLElement): void {
    host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
        const sel = b.dataset.tab === currentTab;
        b.style.background = sel ? "#1e3a8a" : "transparent";
        b.style.color = sel ? "#fff" : "#888";
    });
}

export async function mountItems(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    // Modify individual properties (do NOT use cssText which would wipe out
    // the host's parent-applied overflow/flex styles → break scroll).
    host.style.padding = "14px";
    host.style.color = "#ccc";
    host.style.fontFamily = "system-ui,sans-serif";
    host.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:14px">
            <div data-region="tabs" style="display:flex;gap:6px;border-bottom:1px solid #2a2a2a;padding-bottom:6px;flex-wrap:wrap">
                ${TABS.map((t) => `<button data-tab="${t.id}" style="padding:5px 14px;background:transparent;color:#888;border:1px solid #333;border-radius:4px;cursor:pointer;font-size:12px">${t.label}</button>`).join("")}
            </div>
            <div style="display:flex;gap:10px;align-items:center">
                <input data-region="search" type="text" placeholder="Rechercher par nom ou id…" style="flex:1;padding:7px 12px;background:#0a0a0a;color:#ccc;border:1px solid #2a2a2a;border-radius:4px;font-size:12px">
                <span data-region="catalog-status" style="color:#666;font-size:11px;white-space:nowrap"></span>
            </div>
            <div data-region="catalog-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px"></div>
            <button data-action="load-more" style="padding:6px 14px;background:#1a1a1a;color:#9bd;border:1px solid #2a2a2a;border-radius:4px;cursor:pointer;align-self:center;font-size:12px;display:none">Charger plus (+${PAGE_STEP})</button>
        </div>
    `;

    updateTabStyles(host);

    // Tab buttons.
    host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const t = btn.dataset.tab as TabId | undefined;
            if (!t || t === currentTab) return;
            currentTab = t;
            updateTabStyles(host);
            // Restore query state per tab in the search box.
            const search = host.querySelector<HTMLInputElement>("[data-region='search']");
            if (search) search.value = tabState[currentTab].query;
            void refresh(host);
        });
    });

    // Search input — 150ms debounce, restores per-tab.
    const search = host.querySelector<HTMLInputElement>("[data-region='search']")!;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    search.addEventListener("input", () => {
        const q = search.value;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            tabState[currentTab].query = q;
            tabState[currentTab].visible = PAGE_STEP;
            void refresh(host);
        }, 150);
    });

    // Load-more button.
    host.querySelector<HTMLButtonElement>("[data-action='load-more']")!.addEventListener("click", () => {
        tabState[currentTab].visible += PAGE_STEP;
        void refresh(host);
    });

    await refresh(host);
}
