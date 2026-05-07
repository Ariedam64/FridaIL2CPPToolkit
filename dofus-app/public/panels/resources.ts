// Resources browser — built offline from build-resources.py.
// Lists every known interactive type that's been mapped to a gathering item,
// grouped by job (Bûcheron, Mineur, Pêcheur…) and sorted by count. Click a
// resource → popup with the list of maps where it appears.

interface ResourceEntry {
    typeId: number;
    name: string;
    sampleGfxId: number;
    sampleIconId: number;
    isResource: boolean;
    jobId: number;
    jobName: string;
    levelMin: number;
    itemId: number;
    itemName: string;
    itemTypeId: number;
    itemTypeName: string;
    count: number;
    mapCount: number;
}

interface ResourcesData { items: ResourceEntry[] }

interface MapInfo { id: number; posX: number; posY: number; worldMap: number; subAreaId: number; name?: string; }
interface SubArea { id: number; name: string; }

let mapsCatalog: MapInfo[] | null = null;
let subareasCatalog: SubArea[] | null = null;

async function loadMaps(): Promise<MapInfo[]> {
    if (mapsCatalog) return mapsCatalog;
    try {
        const r = await fetch(`/api/catalog/maps`);
        if (!r.ok) return [];
        const j = await r.json();
        mapsCatalog = j.items || [];
        return mapsCatalog!;
    } catch { return []; }
}

async function loadSubareas(): Promise<SubArea[]> {
    if (subareasCatalog) return subareasCatalog;
    try {
        const r = await fetch(`/api/catalog/subareas`);
        if (!r.ok) return [];
        const j = await r.json();
        subareasCatalog = j.items || [];
        return subareasCatalog!;
    } catch { return []; }
}

async function loadResources(): Promise<ResourceEntry[]> {
    try {
        const r = await fetch(`/api/resources`);
        if (!r.ok) return [];
        const j: ResourcesData = await r.json();
        return j.items || [];
    } catch { return []; }
}

async function loadResourceMaps(typeId: number): Promise<Array<[number, number]>> {
    try {
        const r = await fetch(`/api/resource-maps/${typeId}`);
        if (!r.ok) return [];
        const j = await r.json();
        // New format: [[mapId, count], ...]. Old format (pre build-resources rerun):
        // [mapId, ...] — coerce to count=1 so the popup still renders.
        if (Array.isArray(j) && j.length && typeof j[0] === "number") {
            return (j as number[]).map(id => [id, 1] as [number, number]);
        }
        return j as Array<[number, number]>;
    } catch { return []; }
}

function iconUrl(entry: ResourceEntry): string {
    // Resource items have a real iconId → use the item icon. Non-resources fall
    // back to the sprite extracted from mapgfx bundles (raw in-world art).
    if (entry.isResource && entry.sampleIconId > 0) return `/icons/items/${entry.sampleIconId}.png`;
    return `/sprite/${entry.sampleGfxId}.png`;
}

export async function renderResources(container: HTMLElement): Promise<void> {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; height:100%; padding:var(--s-3); gap:var(--s-3); min-height:0">
        <div style="display:flex; gap:var(--s-2); align-items:center; flex-wrap:wrap">
          <select id="rs-job" style="background:#111; color:#fff; border:1px solid #333; padding:4px; font-family:var(--font-mono); font-size:12px">
            <option value="">all jobs</option>
          </select>
          <input id="rs-q" type="text" placeholder="search name…" style="flex:1; min-width:120px; padding:4px 6px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:12px">
          <select id="rs-sort" style="background:#111; color:#fff; border:1px solid #333; padding:4px; font-family:var(--font-mono); font-size:12px">
            <option value="count">sort: count</option>
            <option value="level">sort: level</option>
            <option value="name">sort: name</option>
            <option value="job">sort: job + level</option>
          </select>
          <label style="font-size:11px; color:var(--c-label); display:flex; gap:4px; align-items:center">
            <input id="rs-only-resources" type="checkbox" checked> resources only
          </label>
          <span id="rs-count" style="font-size:11px; color:var(--c-label)"></span>
        </div>
        <div id="rs-grid" style="flex:1; overflow:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; align-content:start; padding-bottom:8px"></div>
      </div>
    `;

    const jobEl   = container.querySelector<HTMLSelectElement>("#rs-job")!;
    const qEl     = container.querySelector<HTMLInputElement>("#rs-q")!;
    const sortEl  = container.querySelector<HTMLSelectElement>("#rs-sort")!;
    const onlyEl  = container.querySelector<HTMLInputElement>("#rs-only-resources")!;
    const gridEl  = container.querySelector<HTMLDivElement>("#rs-grid")!;
    const countEl = container.querySelector<HTMLSpanElement>("#rs-count")!;

    countEl.textContent = "loading…";
    const [resources] = await Promise.all([loadResources(), loadMaps(), loadSubareas()]);
    if (!resources.length) {
        gridEl.innerHTML = `<div style="padding:8px; color:var(--c-label); grid-column:1/-1">no resources data — run <code>python dofus-app/scripts/build-resources.py</code></div>`;
        countEl.textContent = "0";
        return;
    }

    // Populate job dropdown.
    const jobs = [...new Set(resources.filter(r => r.jobName).map(r => r.jobName))].sort();
    jobEl.innerHTML = `<option value="">all jobs (${resources.filter(r => r.jobName).length})</option>` +
        jobs.map(j => {
            const c = resources.filter(r => r.jobName === j).length;
            return `<option value="${j}">${j} (${c})</option>`;
        }).join("");

    function render(): void {
        const job = jobEl.value;
        const q = qEl.value.trim().toLowerCase();
        const sort = sortEl.value;
        const onlyRes = onlyEl.checked;

        let filtered = resources;
        if (onlyRes) filtered = filtered.filter(r => r.isResource);
        if (job) filtered = filtered.filter(r => r.jobName === job);
        if (q) filtered = filtered.filter(r =>
            r.name.toLowerCase().includes(q) || r.itemName.toLowerCase().includes(q));

        const sorted = filtered.slice();
        if (sort === "count") sorted.sort((a, b) => b.count - a.count);
        else if (sort === "level") sorted.sort((a, b) => a.levelMin - b.levelMin || b.count - a.count);
        else if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
        else if (sort === "job") sorted.sort((a, b) =>
            (a.jobName || "zzz").localeCompare(b.jobName || "zzz") || a.levelMin - b.levelMin);

        countEl.textContent = `${sorted.length}/${resources.length}`;

        gridEl.innerHTML = sorted.map(r => {
            const job = r.jobName ? `<span style="color:var(--c-accent)">${r.jobName}</span>${r.levelMin ? ` <span style="color:var(--c-label)">lvl ${r.levelMin}</span>` : ""}` : `<span style="color:#555">interactif</span>`;
            const cat = r.itemTypeName ? `<span style="color:var(--c-label)">${r.itemTypeName}</span>` : "";
            return `
            <div class="rs-cell" data-tid="${r.typeId}" title="${r.name} · typeId ${r.typeId}${r.itemName ? ` · ${r.itemName}` : ''}"
                 style="display:flex; flex-direction:column; align-items:center; padding:8px 6px; background:#111; border:1px solid #222; border-radius:3px; cursor:pointer; gap:3px">
              <img src="${iconUrl(r)}" alt="" loading="lazy"
                   style="width:48px; height:48px; image-rendering:auto; object-fit:contain"
                   onerror="this.style.opacity=0.2; this.alt='?'">
              <div style="font-size:11px; color:#ddd; text-align:center; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${r.name}</div>
              <div style="font-size:10px; text-align:center">${job}</div>
              ${cat ? `<div style="font-size:10px; text-align:center">${cat}</div>` : ""}
              <div style="font-size:10px; color:#555; font-family:var(--font-mono)">${r.count} · ${r.mapCount} maps</div>
            </div>
        `;
        }).join("");
    }

    gridEl.addEventListener("click", (e) => {
        const cell = (e.target as HTMLElement).closest(".rs-cell") as HTMLElement | null;
        if (!cell) return;
        const tid = Number(cell.dataset["tid"]);
        const r = resources.find(x => x.typeId === tid);
        if (r) void openMapsPopup(r);
    });

    jobEl.addEventListener("change", render);
    qEl.addEventListener("input", render);
    sortEl.addEventListener("change", render);
    onlyEl.addEventListener("change", render);

    render();
}

async function openMapsPopup(r: ResourceEntry): Promise<void> {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed; inset:0; z-index:999; background:rgba(0,0,0,0.85); display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px";
    overlay.innerHTML = `
      <div style="width:min(900px, 100%); max-height:90vh; background:#0a0a0a; border:1px solid #333; border-radius:4px; display:flex; flex-direction:column; min-height:0">
        <div style="display:flex; gap:12px; align-items:center; padding:14px; border-bottom:1px solid #222">
          <img src="${iconUrl(r)}" style="width:56px; height:56px; image-rendering:auto; background:#111; border:1px solid #222; padding:4px" onerror="this.style.opacity=0.2">
          <div style="flex:1">
            <div style="font-size:15px; color:#fff">${r.name}</div>
            <div style="font-size:11px; color:var(--c-label); margin-top:2px">
              ${r.isResource ? `${r.jobName} · lvl ${r.levelMin} · ${r.itemTypeName} · drops <span style="color:#aaa">${r.itemName}</span>` : "interactif (non-collectable)"}
            </div>
            <div style="font-size:11px; color:var(--c-label); margin-top:2px">
              <strong style="color:#aaa">${r.count}</strong> instances on <strong style="color:#aaa">${r.mapCount}</strong> maps · typeId ${r.typeId}
            </div>
          </div>
          <button id="rs-close" class="btn">close · esc</button>
        </div>
        <div id="rs-maplist" style="flex:1; overflow:auto; padding:6px; min-height:0">loading map list…</div>
      </div>
    `;
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    function onKey(ev: KeyboardEvent) { if (ev.key === "Escape") close(); }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector<HTMLButtonElement>("#rs-close")!.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);

    const [mapEntries, maps, subareas] = await Promise.all([loadResourceMaps(r.typeId), loadMaps(), loadSubareas()]);
    const mapById = new Map(maps.map(m => [m.id, m]));
    const subById = new Map(subareas.map(s => [s.id, s.name]));

    // Group by subarea name, sort within by (per-map count desc, then coords).
    const grouped = new Map<string, Array<{ id: number; posX: number; posY: number; worldMap: number; count: number }>>();
    for (const [id, count] of mapEntries) {
        const m = mapById.get(id);
        if (!m) continue;
        const sub = subById.get(m.subAreaId) || `subarea ${m.subAreaId}`;
        const arr = grouped.get(sub) ?? [];
        arr.push({ id, posX: m.posX, posY: m.posY, worldMap: m.worldMap, count });
        grouped.set(sub, arr);
    }
    const sortedGroups = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);

    const listEl = overlay.querySelector<HTMLDivElement>("#rs-maplist")!;
    if (!mapEntries.length) {
        listEl.innerHTML = `<div style="padding:12px; color:var(--c-label)">no maps recorded for this typeId</div>`;
        return;
    }

    listEl.innerHTML = sortedGroups.map(([sub, items]) => {
        items.sort((a, b) => b.count - a.count || a.worldMap - b.worldMap || a.posY - b.posY || a.posX - b.posX);
        const tiles = items.map(it => `
            <div class="rs-map-tile" data-mid="${it.id}" data-px="${it.posX}" data-py="${it.posY}" data-wm="${it.worldMap}"
                 title="map ${it.id} · (${it.posX}, ${it.posY}) · wm ${it.worldMap} · ${it.count} instance${it.count > 1 ? 's' : ''}"
                 style="position:relative; display:flex; flex-direction:column; align-items:center; padding:4px; background:#111; border:1px solid #222; border-radius:3px; cursor:pointer">
              <img src="/map-preview/${it.id}.png" loading="lazy" style="width:80px; height:auto; aspect-ratio:1204/860; object-fit:cover; image-rendering:auto" onerror="this.style.opacity=0.15">
              <div style="position:absolute; top:2px; right:2px; background:rgba(255,200,0,0.92); color:#000; font-weight:bold; font-size:10px; font-family:var(--font-mono); padding:1px 4px; border-radius:8px; min-width:14px; text-align:center; box-shadow:0 0 0 1px rgba(0,0,0,0.6)">${it.count}</div>
              <div style="font-size:9px; color:var(--c-label); font-family:var(--font-mono); margin-top:2px">${it.posX},${it.posY}</div>
            </div>
        `).join("");
        return `
        <div style="margin-bottom:10px">
          <div style="font-size:11px; color:#aaa; padding:4px 6px; background:#080808; border-bottom:1px solid #1a1a1a">${sub} <span style="color:var(--c-label)">· ${items.length}</span></div>
          <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(90px, 1fr)); gap:4px; padding:4px">${tiles}</div>
        </div>`;
    }).join("");

    // Click a tile → switch to world panel (best-effort: emit a custom event).
    listEl.addEventListener("click", (e) => {
        const tile = (e.target as HTMLElement).closest(".rs-map-tile") as HTMLElement | null;
        if (!tile) return;
        const mid = Number(tile.dataset["mid"]);
        const wm = Number(tile.dataset["wm"]);
        const px = Number(tile.dataset["px"]);
        const py = Number(tile.dataset["py"]);
        document.dispatchEvent(new CustomEvent("jump-to-map", { detail: { mapId: mid, worldMap: wm, posX: px, posY: py } }));
        close();
    });
}
