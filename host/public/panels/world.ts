// World map panel — explorable canvas of the entire Dofus world, driven by
// the static catalogs dumped by the agent to .toolkit-data/catalog/*.
// Click a tile → details panel. Use "CAPTURE HERE" to append the current
// map's live interactives to the per-map cache at .toolkit-data/maps/*.

import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";

interface MapEntry { id: number; posX: number; posY: number; subAreaId: number; worldMap: number; nameId: number; name: string; }
interface SubArea { id: number; areaId: number; name: string; level?: number; }
interface Area { id: number; name: string; }
interface Catalogs {
    maps: MapEntry[];
    subareas: Map<number, SubArea>;
    areas: Map<number, Area>;
    interactives: Map<number, string>;   // typeId → name
}

interface MapCache { mapId: number; updatedAt: string; interactives: Array<{ elementId: string; cell: number; typeId: number; name: string }>; }

// Small color palette — cycled by areaId so neighbouring areas are
// distinguishable. HSL so adjusting is easy if we want to shade.
function areaColor(areaId: number): string {
    const h = (areaId * 137) % 360;
    return `hsl(${h}, 55%, 45%)`;
}

async function loadCatalog(slug: string): Promise<any> {
    const res = await fetch(`/api/catalog/${slug}`);
    if (!res.ok) return null;
    return res.json();
}

async function loadAllCatalogs(): Promise<Catalogs | null> {
    const [maps, subareas, areas, interactives] = await Promise.all([
        loadCatalog("maps"),
        loadCatalog("subareas"),
        loadCatalog("areas"),
        loadCatalog("interactives"),
    ]);
    if (!maps || !subareas || !areas) return null;
    const saMap = new Map<number, SubArea>();
    for (const s of subareas.items) saMap.set(s.id, s);
    const aMap = new Map<number, Area>();
    for (const a of areas.items) aMap.set(a.id, a);
    const iMap = new Map<number, string>();
    if (interactives) for (const i of interactives.items) iMap.set(i.id, i.name);
    return { maps: maps.items, subareas: saMap, areas: aMap, interactives: iMap };
}

async function loadMapCache(mapId: number): Promise<MapCache | null> {
    const res = await fetch(`/api/maps/${mapId}`);
    if (!res.ok) return null;
    return res.json();
}

async function loadCachedMapIds(): Promise<Set<number>> {
    try {
        const res = await fetch(`/api/maps`);
        if (!res.ok) return new Set();
        const ids = await res.json();
        return new Set(ids);
    } catch { return new Set(); }
}

export async function renderWorld(container: HTMLElement): Promise<void> {
    container.innerHTML = `
      <div style="display:flex; height:100%; min-height:600px">
        <div id="wm-side" style="width:320px; border-right:1px solid #333; padding:var(--s-3); overflow:auto; display:flex; flex-direction:column; gap:var(--s-3)">
          <div style="display:flex; gap:var(--s-2); flex-wrap:wrap">
            <button id="wm-extract" class="btn">EXTRACT CATALOGS</button>
            <button id="wm-capture" class="btn primary">CAPTURE HERE</button>
            <button id="wm-reload" class="btn">↻</button>
          </div>
          <div style="font-size:11px; color:var(--c-label)">
            <span id="wm-stats">loading…</span>
          </div>
          <label style="font-size:11px; color:var(--c-label)">world map
            <select id="wm-wm" style="background:#111; color:#fff; border:1px solid #333; padding:2px; font-family:var(--font-mono); margin-left:var(--s-2)"></select>
          </label>
          <label style="font-size:11px; color:var(--c-label)">filter subarea
            <input id="wm-search" type="text" placeholder="name…" style="width:100%; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px; margin-top:var(--s-1)">
          </label>
          <hr style="border-color:#333; width:100%">
          <div id="wm-detail" style="font-family:var(--font-mono); font-size:11px; white-space:pre-wrap; color:var(--c-label)">click a tile to inspect</div>
        </div>
        <div id="wm-canvas-wrap" style="flex:1; overflow:auto; background:#0a0a0a; position:relative">
          <canvas id="wm-canvas" style="display:block; image-rendering:pixelated"></canvas>
        </div>
      </div>
    `;

    const side = container.querySelector<HTMLDivElement>("#wm-side")!;
    const statsEl = side.querySelector<HTMLSpanElement>("#wm-stats")!;
    const wmSelect = side.querySelector<HTMLSelectElement>("#wm-wm")!;
    const searchEl = side.querySelector<HTMLInputElement>("#wm-search")!;
    const detail = side.querySelector<HTMLDivElement>("#wm-detail")!;
    const canvas = container.querySelector<HTMLCanvasElement>("#wm-canvas")!;
    const ctx = canvas.getContext("2d")!;

    let catalogs: Catalogs | null = null;
    let cachedMapIds: Set<number> = new Set();
    let currentWorldMap = 1;
    let cellSize = 8;
    let maps: MapEntry[] = [];
    let bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let selected: MapEntry | null = null;
    let highlightedSet: Set<number> | null = null;

    function computeBounds(): void {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const m of maps) {
            if (m.posX < minX) minX = m.posX;
            if (m.posX > maxX) maxX = m.posX;
            if (m.posY < minY) minY = m.posY;
            if (m.posY > maxY) maxY = m.posY;
        }
        if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }
        bounds = { minX, maxX, minY, maxY };
    }

    function worldToCanvasXY(posX: number, posY: number): { x: number; y: number } {
        return { x: (posX - bounds.minX) * cellSize, y: (posY - bounds.minY) * cellSize };
    }

    function render(): void {
        if (!catalogs) return;
        const w = (bounds.maxX - bounds.minX + 1) * cellSize;
        const h = (bounds.maxY - bounds.minY + 1) * cellSize;
        canvas.width = w; canvas.height = h;
        ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);

        // Group maps by (posX, posY) to draw a single cell even if multiple
        // maps share coords (indoor variants, etc.). Prefer the one whose
        // subArea matches the filter, else the first.
        const byCoord = new Map<string, MapEntry>();
        for (const m of maps) {
            const k = `${m.posX},${m.posY}`;
            if (!byCoord.has(k)) byCoord.set(k, m);
            else if (highlightedSet && highlightedSet.has(m.subAreaId)) byCoord.set(k, m);
        }

        for (const [, m] of byCoord) {
            const sa = catalogs.subareas.get(m.subAreaId);
            const areaId = sa?.areaId ?? 0;
            const dim = highlightedSet && !highlightedSet.has(m.subAreaId);
            ctx.fillStyle = dim ? "#222" : areaColor(areaId);
            const { x, y } = worldToCanvasXY(m.posX, m.posY);
            ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
            // Ring overlay if this map has a cached dump (visited).
            if (cachedMapIds.has(m.id)) {
                ctx.strokeStyle = "#ffcc00";
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 0.5, y + 0.5, cellSize - 2, cellSize - 2);
            }
        }

        // Selected outline.
        if (selected) {
            const { x, y } = worldToCanvasXY(selected.posX, selected.posY);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, y - 1, cellSize + 1, cellSize + 1);
        }
    }

    function renderDetail(): void {
        if (!selected || !catalogs) { detail.textContent = "click a tile to inspect"; return; }
        const m = selected;
        const sa = catalogs.subareas.get(m.subAreaId);
        const area = sa ? catalogs.areas.get(sa.areaId) : null;
        const lines: string[] = [
            `mapId:     ${m.id}`,
            `coords:    (${m.posX}, ${m.posY})  wm=${m.worldMap}`,
            `mapName:   ${m.name || "(unnamed)"}`,
            `subarea:   ${sa?.name ?? "?"}  (id=${m.subAreaId}, level=${sa?.level ?? "?"})`,
            `area:      ${area?.name ?? "?"}  (id=${sa?.areaId ?? "?"})`,
            ``,
        ];
        loadMapCache(m.id).then(cache => {
            if (!cache) {
                detail.textContent = lines.join("\n") + "interactives: (not cached — stand on this map + click CAPTURE HERE)";
                return;
            }
            lines.push(`cached at ${cache.updatedAt}`);
            lines.push(`interactives (${cache.interactives.length}):`);
            for (const i of cache.interactives) {
                lines.push(`  cell ${String(i.cell).padStart(3)}  ${i.name || "?"} (typeId=${i.typeId}, elementId=${i.elementId})`);
            }
            detail.textContent = lines.join("\n");
        }).catch(() => {
            detail.textContent = lines.join("\n") + "(error loading cached data)";
        });
    }

    function updateForWorldMap(): void {
        if (!catalogs) return;
        maps = catalogs.maps.filter(m => m.worldMap === currentWorldMap);
        computeBounds();
        statsEl.textContent = `${maps.length} maps on wm=${currentWorldMap}  •  ${cachedMapIds.size} cached in total`;
        selected = null;
        renderDetail();
        render();
    }

    async function refresh(): Promise<void> {
        statsEl.textContent = "loading catalogs…";
        catalogs = await loadAllCatalogs();
        if (!catalogs) { statsEl.textContent = "missing catalogs — click EXTRACT CATALOGS"; return; }
        cachedMapIds = await loadCachedMapIds();
        // Populate worldmap dropdown.
        const wms = new Map<number, number>(); // wm → count
        for (const m of catalogs.maps) wms.set(m.worldMap, (wms.get(m.worldMap) ?? 0) + 1);
        wmSelect.innerHTML = "";
        for (const [wm, n] of [...wms.entries()].sort((a, b) => b[1] - a[1])) {
            const opt = document.createElement("option");
            opt.value = String(wm); opt.textContent = `wm=${wm}  (${n} maps)`;
            wmSelect.appendChild(opt);
        }
        wmSelect.value = String(currentWorldMap);
        updateForWorldMap();
    }

    wmSelect.addEventListener("change", () => {
        currentWorldMap = parseInt(wmSelect.value, 10);
        updateForWorldMap();
    });

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim().toLowerCase();
        if (!q) { highlightedSet = null; render(); return; }
        if (!catalogs) return;
        highlightedSet = new Set();
        for (const [id, sa] of catalogs.subareas) {
            if (sa.name.toLowerCase().includes(q)) highlightedSet.add(id);
        }
        render();
    });

    canvas.addEventListener("click", (ev) => {
        if (!catalogs) return;
        const rect = canvas.getBoundingClientRect();
        const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
        const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
        const wx = Math.floor(px / cellSize) + bounds.minX;
        const wy = Math.floor(py / cellSize) + bounds.minY;
        const hits = maps.filter(m => m.posX === wx && m.posY === wy);
        if (!hits.length) { selected = null; renderDetail(); render(); return; }
        selected = hits[0];
        renderDetail();
        render();
    });

    side.querySelector<HTMLButtonElement>("#wm-reload")!.addEventListener("click", () => refresh());

    side.querySelector<HTMLButtonElement>("#wm-extract")!.addEventListener("click", async () => {
        statsEl.textContent = "extracting catalogs (≈15s)…";
        try {
            const r = await rpcCall<any>("extractAllCatalogs", []);
            logRpcLine(`[world] catalogs: ${JSON.stringify(r.counts)}`);
            // Re-run the standalone persistence (agent fires send events but
            // legacy server may not have the handler until restart — we also
            // write via per-catalog calls on the host side as fallback).
            await refresh();
        } catch (err) {
            statsEl.textContent = `extract err: ${String(err).slice(0, 80)}`;
        }
    });

    side.querySelector<HTMLButtonElement>("#wm-capture")!.addEventListener("click", async () => {
        try {
            const [st, ints] = await Promise.all([
                rpcCall<any>("getMapState", []),
                rpcCall<any>("getInteractivesOnMap", []),
            ]);
            if (!st) { logRpcLine("[world] not on a map"); return; }
            // Push to the host to persist — if the host's message handler
            // understands map-cache we also flag via that channel. Direct
            // HTTP save is robust regardless.
            const res = await fetch(`/api/maps/${st.mapId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ interactives: ints }),
            });
            if (res.ok) {
                cachedMapIds.add(st.mapId);
                logRpcLine(`[world] cached mapId ${st.mapId} (${ints.length} interactives)`);
                render();
                if (selected && selected.id === st.mapId) renderDetail();
            } else {
                logRpcLine(`[world] save failed: HTTP ${res.status}`);
            }
        } catch (err) { logRpcLine(`[world] capture err: ${String(err)}`); }
    });

    await refresh();
}
