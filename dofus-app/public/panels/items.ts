// Browser for icons extracted from Picto bundles. Pick a category
// (items, monsters, spells), filter by name or id, click an entry to see
// it large.

interface CatalogItem { id: number; iconId?: number; nameId?: number; name?: string; }
interface CatalogResp { items: CatalogItem[] }

const CATEGORIES: Array<{ id: string; label: string; catalog: string }> = [
    { id: "items",    label: "items",    catalog: "items" },
    { id: "monsters", label: "monsters", catalog: "monsters" },
];

async function loadCatalog(slug: string): Promise<CatalogItem[]> {
    try {
        const r = await fetch(`/api/catalog/${slug}`);
        if (!r.ok) return [];
        const j: CatalogResp = await r.json();
        return j.items;
    } catch { return []; }
}

export async function renderItems(container: HTMLElement): Promise<void> {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; height:100%; padding:var(--s-3); gap:var(--s-3)">
        <div style="display:flex; gap:var(--s-2); align-items:center">
          <select id="ic-cat" style="background:#111; color:#fff; border:1px solid #333; padding:4px; font-family:var(--font-mono); font-size:12px">
            ${CATEGORIES.map(c => `<option value="${c.id}">${c.label}</option>`).join("")}
          </select>
          <input id="ic-q" type="text" placeholder="search by name or id…" style="flex:1; padding:4px 6px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:12px">
          <span id="ic-count" style="font-size:11px; color:var(--c-label)"></span>
        </div>
        <div id="ic-grid" style="flex:1; overflow:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(70px, 1fr)); gap:6px; align-content:start"></div>
      </div>
    `;

    const catEl   = container.querySelector<HTMLSelectElement>("#ic-cat")!;
    const qEl     = container.querySelector<HTMLInputElement>("#ic-q")!;
    const gridEl  = container.querySelector<HTMLDivElement>("#ic-grid")!;
    const countEl = container.querySelector<HTMLSpanElement>("#ic-count")!;

    let allItems: CatalogItem[] = [];

    function render(): void {
        const q = qEl.value.trim().toLowerCase();
        const cat = catEl.value;
        const filtered = q
            ? allItems.filter(i => String(i.id).includes(q) || (i.name ?? "").toLowerCase().includes(q))
            : allItems;
        countEl.textContent = `${filtered.length}/${allItems.length}`;
        // Cap displayed entries to avoid stalling the browser; the user can
        // narrow via search.
        const cap = 600;
        const shown = filtered.slice(0, cap);
        gridEl.innerHTML = shown.map(i => {
            // Items have separate `id` (logical) and `iconId` (texture) — many
            // items share the same icon. Other categories typically use `id`
            // directly (no iconId field on the catalog entry).
            const iconKey = i.iconId ?? i.id;
            return `
            <div class="ic-cell" data-id="${i.id}" data-icon="${iconKey}" data-cat="${cat}" title="${(i.name ?? '').replace(/"/g, '&quot;')} (id ${i.id})"
                 style="display:flex; flex-direction:column; align-items:center; padding:4px; background:#111; border:1px solid #222; border-radius:3px; cursor:pointer; min-height:80px">
              <img src="/icons/${cat}/${iconKey}.png" alt="" loading="lazy"
                   style="width:48px; height:48px; image-rendering:auto"
                   onerror="this.style.opacity=0.2; this.alt='?'">
              <div style="font-size:9px; color:var(--c-label); margin-top:2px; text-align:center; max-width:64px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${i.name ?? '(unnamed)'}</div>
              <div style="font-size:9px; color:#555; font-family:var(--font-mono)">${i.id}</div>
            </div>
        `;
        }).join("");
        if (filtered.length > cap) {
            const more = document.createElement("div");
            more.style.cssText = "grid-column:1/-1; text-align:center; padding:8px; font-size:11px; color:var(--c-label)";
            more.textContent = `(showing ${cap}/${filtered.length} — narrow your search to see more)`;
            gridEl.appendChild(more);
        }
    }

    async function reload(): Promise<void> {
        const cat = catEl.value;
        const slug = CATEGORIES.find(c => c.id === cat)?.catalog ?? cat;
        countEl.textContent = "loading…";
        allItems = await loadCatalog(slug);
        if (!allItems.length) {
            gridEl.innerHTML = `<div style="padding:8px; color:var(--c-label); grid-column:1/-1">no catalog data — click EXTRACT CATALOGS in the world panel first</div>`;
            countEl.textContent = "0";
            return;
        }
        render();
    }

    // Click a tile → big preview overlay.
    gridEl.addEventListener("click", (e) => {
        const cell = (e.target as HTMLElement).closest(".ic-cell") as HTMLElement | null;
        if (!cell) return;
        const id = cell.dataset["id"]!;
        const iconKey = cell.dataset["icon"] ?? id;
        const cat = cell.dataset["cat"]!;
        const item = allItems.find(i => String(i.id) === id);
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed; inset:0; z-index:999; background:rgba(0,0,0,0.85); display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer";
        overlay.innerHTML = `
            <img src="/icons/${cat}/${iconKey}.png" style="width:256px; height:256px; image-rendering:pixelated; background:#111; border:1px solid #333; padding:8px">
            <div style="margin-top:12px; color:#fff; font-family:var(--font-mono); font-size:13px">${item?.name ?? '(unnamed)'} <span style="color:var(--c-label)">· id ${id}${item?.iconId ? ` · icon ${item.iconId}` : ''}</span></div>
            <div style="margin-top:6px; font-size:11px; color:var(--c-label)">click anywhere to close · esc</div>
        `;
        const close = () => overlay.remove();
        overlay.addEventListener("click", close);
        document.addEventListener("keydown", function onKey(ev) {
            if (ev.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
        });
        document.body.appendChild(overlay);
    });

    catEl.addEventListener("change", () => void reload());
    qEl.addEventListener("input", render);
    await reload();
}
