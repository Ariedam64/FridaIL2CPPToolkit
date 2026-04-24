// World map panel — explorable canvas of the entire Dofus world, driven by
// the static catalogs dumped by the agent to .toolkit-data/catalog/*.
// Click a tile → details panel. Use "CAPTURE HERE" to append the current
// map's live interactives to the per-map cache at .toolkit-data/maps/*.

import { rpcCall } from "../lib/rpc.js";
import { onWsEvent } from "../lib/ws.js";
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

// Two formats coexist under .toolkit-data/maps/<mapId>.json:
//   static  (from extract-mapdata-bundles.py) → { n, a, ie, c }
//   runtime (from CAPTURE HERE)               → { updatedAt, interactives: [...] }
// Both may be merged into a single file over time; treat missing fields as absent.
interface MapData {
    mapId: number;
    // static (bundle-extracted)
    n?: [number, number, number, number];                          // neighbors [top,bot,left,right]
    a?: [number[], number[], number[], number[]];                  // arrow cells per side
    ie?: Array<[number, number, number]>;                          // [cellId, interactionId, gfxId] per interactive
    c?: Array<[number, number, number, number, number]>;           // [flags, speed, mcd, mz, lz]
    // runtime (capture-here) — adds per-instance names/typeId that only the server knows
    updatedAt?: string;
    interactives?: Array<{ elementId: string; cell: number; typeId: number; name: string }>;
}

const GRID_COLS = 14, GRID_ROWS = 40, CELL_W = 20, CELL_H = 10;

// Flags bitfield (see extract-mapdata-bundles.py):
//   bit 0 mov, 1 los, 2 nonWalkableDuringFight, 3 nonWalkableDuringRP,
//   4 farmCell, 5 visible, 6 havenbagCell
function cellColor(flags: number, mcd: number): string | null {
    if (!((flags >> 5) & 1)) return null;          // !visible
    const mov = flags & 1;
    const los = (flags >> 1) & 1;
    const nrp = (flags >> 3) & 1;
    const farm = (flags >> 4) & 1;
    const hb = (flags >> 6) & 1;
    if (!mov) return los ? "#4a4030" : "#2a2520"; // blocker (see-through vs wall)
    if (nrp) return null;                         // not walkable in RP
    if (mcd) return "#ff9d00";                    // map-change edge
    if (farm) return "#d9b02c";
    if (hb) return "#3cd";
    return "#3a7b3a";                             // walkable
}

function renderCellGrid(cells: Array<[number, number, number, number, number]>, canvas: HTMLCanvasElement, hlCells: Set<number> | null): void {
    const w = (GRID_COLS + 0.5) * CELL_W + 2;
    const h = GRID_ROWS * (CELL_H / 2) + CELL_H + 2;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i] || [0, 0, 0, 0, 0];
        const flags = cell[0] | 0, mcd = cell[2] | 0;
        const col = i % GRID_COLS;
        const row = Math.floor(i / GRID_COLS);
        const cx = col * CELL_W + (row % 2) * (CELL_W / 2) + CELL_W / 2 + 1;
        const cy = row * (CELL_H / 2) + CELL_H / 2 + 1;

        const highlighted = hlCells?.has(i);
        const base = cellColor(flags, mcd);
        if (!base && !highlighted) continue;

        ctx.fillStyle = highlighted ? "#6cf" : base!;
        ctx.beginPath();
        ctx.moveTo(cx, cy - CELL_H / 2);
        ctx.lineTo(cx + CELL_W / 2, cy);
        ctx.lineTo(cx, cy + CELL_H / 2);
        ctx.lineTo(cx - CELL_W / 2, cy);
        ctx.closePath();
        ctx.fill();
        if (highlighted) {
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
        }
    }
}

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

async function loadGfxRegistry(): Promise<Map<number, { typeId: number; name: string }>> {
    try {
        const r = await fetch("/api/gfx-to-type");
        if (!r.ok) return new Map();
        const data = await r.json();
        const out = new Map<number, { typeId: number; name: string }>();
        for (const [k, v] of Object.entries(data)) out.set(Number(k), v as { typeId: number; name: string });
        return out;
    } catch { return new Map(); }
}

async function loadMapData(mapId: number): Promise<MapData | null> {
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
            <button id="wm-autocap" class="btn">AUTO-CAPTURE: OFF</button>
            <button id="wm-reload" class="btn">↻</button>
          </div>
          <div style="display:flex; gap:var(--s-2); flex-wrap:wrap">
            <button id="wm-runplan" class="btn">RUN COVERAGE PLAN</button>
          </div>
          <div id="wm-autocap-status" style="font-size:10px; color:var(--c-label)"></div>
          <div id="wm-plan-status" style="font-size:10px; color:var(--c-label); font-family:var(--font-mono)"></div>
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
          <canvas id="wm-cell-canvas" style="display:none; background:#0a0a0a; border:1px solid #222; image-rendering:pixelated; width:100%; max-width:300px"></canvas>
          <div id="wm-cell-legend" style="display:none; font-size:10px; color:var(--c-label); line-height:1.6"></div>
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
    const cellCanvas = side.querySelector<HTMLCanvasElement>("#wm-cell-canvas")!;
    const cellLegend = side.querySelector<HTMLDivElement>("#wm-cell-legend")!;
    const canvas = container.querySelector<HTMLCanvasElement>("#wm-canvas")!;
    const ctx = canvas.getContext("2d")!;

    let catalogs: Catalogs | null = null;
    let gfxRegistry: Map<number, { typeId: number; name: string }> = new Map();
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
        }

        // Selected outline.
        if (selected) {
            const { x, y } = worldToCanvasXY(selected.posX, selected.posY);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, y - 1, cellSize + 1, cellSize + 1);
        }
    }

    function renderDetail(): void {
        if (!selected || !catalogs) {
            detail.textContent = "click a tile to inspect";
            cellCanvas.style.display = "none";
            cellLegend.style.display = "none";
            return;
        }
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
        detail.textContent = lines.join("\n") + "loading…";
        cellCanvas.style.display = "none";
        cellLegend.style.display = "none";

        loadMapData(m.id).then(data => {
            if (!data) {
                detail.textContent = lines.join("\n") + "no map data (run extract-mapdata-bundles.py)";
                return;
            }

            // Static grid (bundle-extracted)
            if (Array.isArray(data.c) && data.c.length > 0) {
                // Interactive cell positions come from the bundle (static, always available).
                // Names/typeIds come only from runtime capture (data.interactives) since the
                // element type is server-sent — merge both when we have them.
                const interactiveCells = new Set<number>();
                const runtimeByCell = new Map<number, { name: string; typeId: number }>();
                if (Array.isArray(data.ie)) {
                    for (const [cell] of data.ie) if (typeof cell === "number") interactiveCells.add(cell);
                }
                const gfxByCell = new Map<number, number>();
                if (Array.isArray(data.ie)) {
                    for (const [cell, , gfxId] of data.ie) if (typeof cell === "number") gfxByCell.set(cell, gfxId || 0);
                }
                if (Array.isArray(data.interactives)) {
                    for (const it of data.interactives) {
                        if (typeof it.cell === "number") {
                            interactiveCells.add(it.cell);
                            runtimeByCell.set(it.cell, { name: it.name, typeId: it.typeId });
                        }
                    }
                }
                renderCellGrid(data.c, cellCanvas, interactiveCells.size ? interactiveCells : null);
                cellCanvas.style.display = "block";

                let walkable = 0, blocked = 0, farm = 0, hb = 0, mcd = 0;
                for (const cell of data.c) {
                    const f = cell[0] | 0;
                    if (!((f >> 5) & 1)) continue;
                    const mov = f & 1, nrp = (f >> 3) & 1;
                    if (mov && !nrp) walkable++;
                    if (!mov) blocked++;
                    if ((f >> 4) & 1) farm++;
                    if ((f >> 6) & 1) hb++;
                    if (cell[2]) mcd++;
                }
                cellLegend.innerHTML = `
                    <div style="display:grid; grid-template-columns:auto 1fr; gap:2px 8px; align-items:center; margin-top:var(--s-1)">
                      <span style="display:inline-block; width:10px; height:10px; background:#3a7b3a"></span><span>walkable (${walkable})</span>
                      ${farm ? `<span style="display:inline-block; width:10px; height:10px; background:#d9b02c"></span><span>farm (${farm})</span>` : ""}
                      ${mcd ? `<span style="display:inline-block; width:10px; height:10px; background:#ff9d00"></span><span>map-change (${mcd})</span>` : ""}
                      <span style="display:inline-block; width:10px; height:10px; background:#2a2520"></span><span>blocked (${blocked})</span>
                      ${hb ? `<span style="display:inline-block; width:10px; height:10px; background:#3cd"></span><span>havenbag (${hb})</span>` : ""}
                      ${interactiveCells.size ? `<span style="display:inline-block; width:10px; height:10px; background:#6cf"></span><span>interactive (${interactiveCells.size})</span>` : ""}
                    </div>`;
                cellLegend.style.display = "block";

                if (data.n) {
                    lines.push(`neighbors: N=${data.n[0]}  S=${data.n[1]}  W=${data.n[2]}  E=${data.n[3]}`);
                }
                if (Array.isArray(data.ie) && data.ie.length) {
                    lines.push(``);
                    lines.push(`interactives (${data.ie.length}):`);
                    for (const [cell, iid, gfxId] of data.ie) {
                        const runtime = runtimeByCell.get(cell);
                        const learned = gfxRegistry.get(gfxId);
                        let label: string;
                        if (runtime?.name) label = runtime.name;
                        else if (learned?.name) label = `${learned.name} (inferred via gfxId)`;
                        else label = "(type unknown — CAPTURE HERE for name)";
                        lines.push(`  cell ${String(cell).padStart(3)}  ${label}  (iid=${iid}, gfx=${gfxId})`);
                    }
                }
            }

            if (data.updatedAt) {
                lines.push(``);
                lines.push(`last captured: ${data.updatedAt}`);
            }
            if (!data.c?.length && !data.interactives?.length) {
                lines.push(`(empty — extract bundles or CAPTURE HERE)`);
            }

            detail.textContent = lines.join("\n");
        }).catch((e) => {
            detail.textContent = lines.join("\n") + `(fetch err: ${String(e).slice(0, 80)})`;
        });
    }

    function updateForWorldMap(): void {
        if (!catalogs) return;
        maps = catalogs.maps.filter(m => m.worldMap === currentWorldMap);
        computeBounds();
        statsEl.textContent = `${maps.length} maps on wm=${currentWorldMap}  •  ${cachedMapIds.size} with cell data`;
        selected = null;
        renderDetail();
        render();
    }

    async function refresh(): Promise<void> {
        statsEl.textContent = "loading catalogs…";
        catalogs = await loadAllCatalogs();
        if (!catalogs) { statsEl.textContent = "missing catalogs — click EXTRACT CATALOGS"; return; }
        gfxRegistry = await loadGfxRegistry();
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

    async function captureCurrent(): Promise<{ mapId: number; count: number } | null> {
        const [mid, ints] = await Promise.all([
            rpcCall<number>("getCurrentMapId", []),
            rpcCall<any>("getInteractivesOnMap", []),
        ]);
        if (!mid) return null;
        const res = await fetch(`/api/maps/${mid}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interactives: ints }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cachedMapIds.add(mid);
        return { mapId: mid, count: ints.length };
    }

    side.querySelector<HTMLButtonElement>("#wm-capture")!.addEventListener("click", async () => {
        try {
            const r = await captureCurrent();
            if (!r) { logRpcLine("[world] not on a map"); return; }
            logRpcLine(`[world] cached mapId ${r.mapId} (${r.count} interactives)`);
            render();
            if (selected && selected.id === r.mapId) renderDetail();
        } catch (err) { logRpcLine(`[world] capture err: ${String(err)}`); }
    });

    // Auto-capture: poll getMapState every 2s. On mapId change, capture once.
    // Skip if the map is already in cachedMapIds (already has runtime data).
    const autocapBtn = side.querySelector<HTMLButtonElement>("#wm-autocap")!;
    const autocapStatus = side.querySelector<HTMLDivElement>("#wm-autocap-status")!;
    let autocapTimer: ReturnType<typeof setInterval> | null = null;
    let autocapLastMapId = 0;
    let autocapSeenSession = new Set<number>();
    async function autocapTick(): Promise<void> {
        try {
            const st = await rpcCall<any>("getMapState", []);
            if (!st) return;
            if (st.mapId === autocapLastMapId) return;
            autocapLastMapId = st.mapId;
            if (autocapSeenSession.has(st.mapId)) return;
            autocapSeenSession.add(st.mapId);
            const r = await captureCurrent();
            if (r) {
                autocapStatus.textContent = `auto-cap: ${r.count} ints on mapId ${r.mapId} (session total: ${autocapSeenSession.size})`;
                if (selected && selected.id === r.mapId) renderDetail();
                render();
            }
        } catch (e) {
            autocapStatus.textContent = `auto-cap err: ${String(e).slice(0, 60)}`;
        }
    }
    autocapBtn.addEventListener("click", () => {
        if (autocapTimer) {
            clearInterval(autocapTimer);
            autocapTimer = null;
            autocapBtn.textContent = "AUTO-CAPTURE: OFF";
            autocapBtn.className = "btn";
            autocapStatus.textContent = "";
        } else {
            autocapTimer = setInterval(autocapTick, 2000);
            autocapBtn.textContent = "AUTO-CAPTURE: ON";
            autocapBtn.className = "btn primary";
            autocapStatus.textContent = "polling every 2s — walk on maps to auto-capture";
            autocapTick();
        }
    });

    // -------- Coverage plan orchestrator -----------------------------------
    // Walks through coverage-plan.json: for each target map, fire autopilot,
    // wait until the player arrives (via WS `jmw` event or polling), capture,
    // continue. Auto-reload the Frida agent if bbd gets wedged (after ~10-30
    // calls IL2CPP throws "system error" until the agent is reloaded fresh).
    const planBtn = side.querySelector<HTMLButtonElement>("#wm-runplan")!;
    const planStatus = side.querySelector<HTMLDivElement>("#wm-plan-status")!;
    let planRunning = false;
    let planAbort = false;

    // Resolves true on arrival (WS event or poll match), false on:
    //   "no-start" — bbd silently accepted the request but the player never moved
    //   "stall"    — player stopped moving for stallMs but never reached target
    //   "abort"    — user clicked STOP
    function waitArrival(targetMapId: number, stallMs: number = 60000): Promise<boolean> {
        return new Promise((resolve) => {
            let done = false, lastMid = 0, seenAnyMovement = false, lastProgress = Date.now();
            const started = Date.now();
            const finish = (ok: boolean, via: string) => {
                if (done) return; done = true;
                unsub(); clearInterval(pollTimer); clearInterval(stallCheck); clearInterval(abortPoll);
                logRpcLine(ok
                    ? `[plan] arrived on ${targetMapId} via ${via}`
                    : `[plan] stopped on ${targetMapId} (${via}, last=${lastMid})`);
                resolve(ok);
            };
            const unsub = onWsEvent((ev) => {
                if (ev.type !== "message") return;
                const m = ev.message as any;
                if (m?.type !== "socket" || m.cls !== "jmw") return;
                const mid = Number(m.fields?.ekry);
                lastProgress = Date.now(); seenAnyMovement = true;
                if (mid === targetMapId) finish(true, "jmw");
            });
            const pollTimer = setInterval(async () => {
                try {
                    const mid = await rpcCall<number>("getCurrentMapId", []);
                    if (!mid) return;
                    if (mid !== lastMid) {
                        if (lastMid !== 0) seenAnyMovement = true;
                        lastMid = mid; lastProgress = Date.now();
                    }
                    if (mid === targetMapId) finish(true, "poll");
                } catch {}
            }, 1000);
            const stallCheck = setInterval(() => {
                const now = Date.now();
                if (!seenAnyMovement && now - started > 10000) finish(false, "no-start");
                else if (now - lastProgress > stallMs) finish(false, "stall");
            }, 1000);
            const abortPoll = setInterval(() => { if (planAbort) finish(false, "abort"); }, 300);
        });
    }

    async function reloadAgent(): Promise<void> {
        try { await fetch("/api/reload", { method: "POST" }); } catch {}
        await new Promise(r => setTimeout(r, 3000));
        try { await rpcCall<any>("hookAutopilotDone", []); } catch {}
    }

    interface PlanEntry { mapId: number; posX: number; posY: number; worldMap: number; subArea: string; name: string; }

    // Returns: "done" (captured), "skip" (already had runtime data), "fail" (couldn't reach).
    async function processOneMap(p: PlanEntry): Promise<"done" | "skip" | "fail"> {
        // Already captured? (file has updatedAt)
        try {
            const existing = await loadMapData(p.mapId);
            if (existing?.updatedAt) return "skip";
        } catch {}

        // Already on target (leftover from previous run)? Skip the travel step.
        let arrived = false;
        try { arrived = (await rpcCall<number>("getCurrentMapId", [])) === p.mapId; } catch {}

        if (!arrived) {
            let tkcOk = false;
            try {
                const r = await rpcCall<any>("autoTravelInstant", [p.mapId]);
                tkcOk = !!r?.ok;
                if (!tkcOk) logRpcLine(`[plan] bbd(${p.mapId}) failed: ${r?.reason?.slice(0, 80)}`);
            } catch {}
            if (tkcOk) arrived = await waitArrival(p.mapId);
        }

        // Grace for dvi to populate after server-side arrival, then verify.
        await new Promise(r => setTimeout(r, 500));
        let actualMid = 0;
        try { actualMid = (await rpcCall<number>("getCurrentMapId", [])) || 0; } catch {}
        if (actualMid !== p.mapId) {
            logRpcLine(`[plan] not on target ${p.mapId} (current=${actualMid})`);
            return "fail";
        }

        try {
            const cap = await captureCurrent();
            if (!cap) return "fail";
            render();
            if (selected && selected.id === p.mapId) renderDetail();
            if (!arrived) logRpcLine(`[plan] saved ${p.mapId} despite arrival miss`);
            return "done";
        } catch (e) {
            logRpcLine(`[plan] cap err on ${p.mapId}: ${String(e).slice(0, 100)}`);
            return "fail";
        }
    }

    async function runPlan(): Promise<void> {
        planAbort = false;
        planStatus.textContent = "loading plan…";
        try { await rpcCall<any>("hookAutopilotDone", []); } catch {}
        let plan: any;
        try {
            const r = await fetch("/api/coverage-plan");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            plan = await r.json();
        } catch (e) { planStatus.textContent = `plan err: ${String(e).slice(0, 80)}`; return; }
        const list: PlanEntry[] = plan.maps || [];
        if (!list.length) { planStatus.textContent = "empty plan"; return; }

        let done = 0, skipped = 0, failed = 0, consecutiveFails = 0;
        for (let i = 0; i < list.length; i++) {
            if (planAbort) { planStatus.textContent += "  · aborted"; break; }
            const p = list[i];
            planStatus.textContent = `${i + 1}/${list.length}  (${p.posX},${p.posY}) wm=${p.worldMap} — ${p.subArea}  · done=${done} skip=${skipped} fail=${failed}`;

            const result = await processOneMap(p);
            if (result === "done") { done++; consecutiveFails = 0; }
            else if (result === "skip") { skipped++; }
            else {
                failed++; consecutiveFails++;
                if (consecutiveFails >= 3) {
                    logRpcLine(`[plan] 3 consecutive fails — auto-reloading agent`);
                    await reloadAgent();
                    consecutiveFails = 0;
                }
                await new Promise(r => setTimeout(r, 800));
                continue;
            }
            // Wait for the arrival cleanup "mini freeze" before next bbd.
            await new Promise(r => setTimeout(r, 2000));
        }
        planStatus.textContent = `plan finished — done=${done} skip=${skipped} fail=${failed}`;
    }

    planBtn.addEventListener("click", () => {
        if (planRunning) { planAbort = true; return; }
        planRunning = true;
        planBtn.textContent = "STOP";
        runPlan().finally(() => {
            planRunning = false;
            planBtn.textContent = "RUN COVERAGE PLAN";
        });
    });

    await refresh();
}
