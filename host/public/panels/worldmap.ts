// World map panel — shows every Dofus map in the DataCenter as a dot at its
// (posX, posY), colored by subArea. Supports worldMap switching, zoom, pan,
// click-to-inspect, and highlight of the currently-loaded map.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";

interface WorldMapDump {
    count: number;
    ids: number[];
    posX: number[];
    posY: number[];
    subAreaId: number[];
    worldMap: number[];
}

// Deterministic HSL palette seeded by subAreaId so each zone gets a stable color.
function subAreaColor(id: number): string {
    // Multiply by golden-ratio-ish odd to scatter similar IDs to different hues.
    const h = (id * 97) % 360;
    const s = 55 + ((id * 13) % 25);   // 55–80%
    const l = 45 + ((id * 7) % 15);    // 45–60%
    return `hsl(${h},${s}%,${l}%)`;
}

const DOT = 6;                        // base dot size at 1× zoom
const PAD = 20;                       // canvas padding around the bounding box

interface WorldView {
    zoom: number;
    panX: number;
    panY: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function coordToCanvas(x: number, y: number, v: WorldView): [number, number] {
    // Logical: posX → canvas x ; posY (Dofus convention: negative Y = north) → canvas y inverted
    const rangeX = (v.maxX - v.minX) || 1;
    const rangeY = (v.maxY - v.minY) || 1;
    const nx = (x - v.minX) / rangeX;
    const ny = (y - v.minY) / rangeY;
    const cx = PAD + nx * (1000 - 2 * PAD);
    const cy = PAD + ny * (900 - 2 * PAD);
    return [(cx + v.panX) * v.zoom, (cy + v.panY) * v.zoom];
}

function canvasToCoord(cxPx: number, cyPx: number, v: WorldView): [number, number] {
    const cx = cxPx / v.zoom - v.panX;
    const cy = cyPx / v.zoom - v.panY;
    const rangeX = (v.maxX - v.minX) || 1;
    const rangeY = (v.maxY - v.minY) || 1;
    const nx = (cx - PAD) / (1000 - 2 * PAD);
    const ny = (cy - PAD) / (900 - 2 * PAD);
    return [nx * rangeX + v.minX, ny * rangeY + v.minY];
}

export function renderWorldMap(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; gap:var(--s-3); padding:var(--s-3); height:100%; box-sizing:border-box">
        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:var(--s-2)">
          <div style="display:flex; gap:var(--s-2); align-items:center; flex-wrap:wrap">
            <button id="wm-refresh" class="btn primary">↻ LOAD</button>
            <label style="display:flex; flex-direction:column; gap:2px; font-size:10px; color:var(--c-label)">
              world
              <select id="wm-world" class="input" style="min-width:90px"></select>
            </label>
            <label style="display:flex; flex-direction:column; gap:2px; font-size:10px; color:var(--c-label); flex:1; min-width:120px">
              search mapId
              <input id="wm-search" class="input" placeholder="191104004" style="width:100%">
            </label>
            <button id="wm-reset-view" class="btn" title="reset zoom + pan">fit</button>
            <span id="wm-header" style="font-size:11px; color:var(--c-label); flex:1">not loaded — click LOAD</span>
          </div>
          <canvas id="wm-canvas" style="background:#0a0a0a; border:1px solid #222; cursor:crosshair; flex:1; min-height:0"></canvas>
          <div style="font-size:10px; color:var(--c-label)">scroll = zoom · drag = pan · click = inspect · double-click = fit</div>
        </div>
        <aside style="width:280px; flex-shrink:0; display:flex; flex-direction:column; gap:var(--s-2); font-size:11px">
          <div class="section-header">selected map</div>
          <div id="wm-info" style="background:#111; border:1px solid #222; padding:var(--s-2); min-height:120px">click a map</div>
          <div class="section-header">stats</div>
          <div id="wm-stats" style="background:#111; border:1px solid #222; padding:var(--s-2); font-size:11px">—</div>
        </aside>
      </div>
    `;

    const canvas   = container.querySelector<HTMLCanvasElement>("#wm-canvas")!;
    const ctx      = canvas.getContext("2d")!;
    const header   = container.querySelector<HTMLElement>("#wm-header")!;
    const info     = container.querySelector<HTMLElement>("#wm-info")!;
    const stats    = container.querySelector<HTMLElement>("#wm-stats")!;
    const refresh  = container.querySelector<HTMLButtonElement>("#wm-refresh")!;
    const worldSel = container.querySelector<HTMLSelectElement>("#wm-world")!;
    const searchEl = container.querySelector<HTMLInputElement>("#wm-search")!;
    const resetBtn = container.querySelector<HTMLButtonElement>("#wm-reset-view")!;

    let dump: WorldMapDump | null = null;
    let filteredIdx: number[] = [];          // indexes into dump that match current world filter
    let currentMapId: number | null = null;
    let selected: number | null = null;      // index in dump
    let highlighted: number | null = null;   // from search

    const view: WorldView = { zoom: 1, panX: 0, panY: 0, minX: 0, minY: 0, maxX: 1, maxY: 1 };

    function resize(): void {
        const w = Math.max(400, canvas.clientWidth | 0);
        const h = Math.max(300, canvas.clientHeight | 0);
        canvas.width = w;
        canvas.height = h;
    }

    function fit(): void {
        if (!dump || !filteredIdx.length) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const i of filteredIdx) {
            const x = dump.posX[i], y = dump.posY[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        view.minX = minX; view.maxX = maxX;
        view.minY = minY; view.maxY = maxY;
        // Compute zoom so canvas height fits.
        const rangeX = (maxX - minX) || 1;
        const rangeY = (maxY - minY) || 1;
        const canvasAspect = canvas.width / canvas.height;
        const dataAspect = rangeX / rangeY;
        view.zoom = dataAspect > canvasAspect
            ? canvas.width / 1000
            : canvas.height / 900;
        view.panX = 0; view.panY = 0;
        render();
    }

    function applyWorldFilter(): void {
        if (!dump) { filteredIdx = []; return; }
        const w = parseInt(worldSel.value, 10);
        filteredIdx = [];
        for (let i = 0; i < dump.count; i++) {
            if (Number.isFinite(w) && dump.worldMap[i] === w) filteredIdx.push(i);
        }
    }

    function render(): void {
        resize();
        ctx.fillStyle = "#080808";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!dump || !filteredIdx.length) {
            ctx.fillStyle = "#666";
            ctx.font = "12px monospace";
            ctx.fillText("no maps — click LOAD", 20, 40);
            return;
        }

        // Group by (posX,posY) so stacked maps at the same coord visually share one dot.
        const bucket = new Map<string, number[]>();
        for (const i of filteredIdx) {
            const key = `${dump.posX[i]},${dump.posY[i]}`;
            const arr = bucket.get(key);
            if (arr) arr.push(i); else bucket.set(key, [i]);
        }

        // Pick color from the first entry in the bucket (representative).
        const r = DOT * Math.min(2.5, Math.max(0.6, view.zoom));
        for (const [, idxs] of bucket) {
            const first = idxs[0];
            const [cx, cy] = coordToCanvas(dump.posX[first], dump.posY[first], view);
            ctx.fillStyle = subAreaColor(dump.subAreaId[first]);
            ctx.fillRect(cx - r / 2, cy - r / 2, r, r);
            if (idxs.length > 1) {
                // Small corner notch for stacked coords
                ctx.fillStyle = "#fff";
                ctx.fillRect(cx + r / 2 - 1, cy - r / 2, 1, 1);
            }
        }

        // Current map highlight (always visible, pulsing outline)
        if (currentMapId !== null) {
            const idx = dump.ids.indexOf(currentMapId);
            if (idx >= 0 && filteredIdx.includes(idx)) {
                const [cx, cy] = coordToCanvas(dump.posX[idx], dump.posY[idx], view);
                const R = r + 6;
                ctx.strokeStyle = "#f4e05a";
                ctx.lineWidth = 2;
                ctx.strokeRect(cx - R / 2, cy - R / 2, R, R);
            }
        }

        // Search highlight
        if (highlighted !== null && filteredIdx.includes(highlighted)) {
            const [cx, cy] = coordToCanvas(dump.posX[highlighted], dump.posY[highlighted], view);
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Selection
        if (selected !== null && filteredIdx.includes(selected)) {
            const [cx, cy] = coordToCanvas(dump.posX[selected], dump.posY[selected], view);
            ctx.strokeStyle = "#eb4a7c";
            ctx.lineWidth = 2;
            ctx.strokeRect(cx - r / 2 - 2, cy - r / 2 - 2, r + 4, r + 4);
        }
    }

    function pickMap(cxPx: number, cyPx: number): number | null {
        if (!dump) return null;
        // Find closest map by squared canvas distance.
        let best = -1, bestD2 = 400; // threshold ~20px
        for (const i of filteredIdx) {
            const [mx, my] = coordToCanvas(dump.posX[i], dump.posY[i], view);
            const dx = cxPx - mx, dy = cyPx - my;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
        return best >= 0 ? best : null;
    }

    function showMapDetails(idx: number): void {
        if (!dump) return;
        const mapId = dump.ids[idx];
        const sameCoord = filteredIdx.filter(j =>
            dump!.posX[j] === dump!.posX[idx] && dump!.posY[j] === dump!.posY[idx]
        );
        info.innerHTML = `
          <b>${mapId}</b><br>
          <span style="color:var(--c-label)">(${dump.posX[idx]}, ${dump.posY[idx]}) · subArea ${dump.subAreaId[idx]} · world ${dump.worldMap[idx]}</span>
          ${sameCoord.length > 1 ? `<br><span style="color:#888">${sameCoord.length - 1} other map(s) at this coord</span>` : ""}
          <div style="margin-top:8px">
            <button class="btn wm-lookup" data-id="${mapId}" style="font-size:10px">lookup details</button>
          </div>
          <div id="wm-details-${mapId}" style="margin-top:6px; font-family:var(--font-mono); font-size:10px; color:var(--c-label)"></div>
        `;
        const btn = info.querySelector<HTMLButtonElement>(".wm-lookup")!;
        btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = "loading…";
            try {
                const d = await rpcCall<any>("getMapInfo", [mapId]);
                const tgt = info.querySelector<HTMLElement>(`#wm-details-${mapId}`)!;
                tgt.innerHTML = d ? `
                    name: ${d.name || "—"}<br>
                    nameId: ${d.nameId}<br>
                    subAreaId: ${d.subAreaId} · worldMap: ${d.worldMap}
                ` : "<i>no data</i>";
            } catch (e) {
                logRpcLine(`[worldmap] getMapInfo failed: ${e}`);
            } finally {
                btn.disabled = false;
                btn.textContent = "lookup details";
            }
        });
    }

    function updateStats(): void {
        if (!dump) { stats.textContent = "—"; return; }
        const subs = new Set<number>();
        for (const i of filteredIdx) subs.add(dump.subAreaId[i]);
        const bucket = new Map<string, number>();
        for (const i of filteredIdx) {
            const k = `${dump.posX[i]},${dump.posY[i]}`;
            bucket.set(k, (bucket.get(k) || 0) + 1);
        }
        stats.innerHTML = `
          visible: ${filteredIdx.length} maps<br>
          unique coords: ${bucket.size}<br>
          sub-areas: ${subs.size}<br>
          total loaded: ${dump.count}
        `;
    }

    async function load(): Promise<void> {
        refresh.disabled = true;
        header.textContent = "loading…";
        try {
            const r = await rpcCall<WorldMapDump>("dumpWorldMap", []);
            dump = r;
            // Populate world select (sorted by count desc)
            const counts = new Map<number, number>();
            for (let i = 0; i < r.count; i++) counts.set(r.worldMap[i], (counts.get(r.worldMap[i]) || 0) + 1);
            const worlds = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            worldSel.innerHTML = worlds.map(([w, n]) => `<option value="${w}">world ${w} (${n})</option>`).join("");
            // Also fetch current map id so we can highlight.
            try {
                const s = await rpcCall<any>("getMapState", []);
                if (s?.mapId) {
                    const cm = Number(s.mapId);
                    currentMapId = cm;
                    const idx = r.ids.indexOf(cm);
                    if (idx >= 0) worldSel.value = String(r.worldMap[idx]);
                }
            } catch {}
            applyWorldFilter();
            fit();
            updateStats();
            header.textContent = `${r.count} maps · ${worlds.length} worlds · click a dot`;
        } catch (err) {
            header.textContent = `error: ${String(err)}`;
            logRpcLine(`[worldmap] dumpWorldMap failed: ${String(err)}`);
        } finally {
            refresh.disabled = false;
        }
    }

    // Interactions
    let dragging = false, dragX = 0, dragY = 0, downPanX = 0, downPanY = 0;
    canvas.addEventListener("mousedown", (e) => {
        dragging = true;
        dragX = e.clientX; dragY = e.clientY;
        downPanX = view.panX; downPanY = view.panY;
    });
    canvas.addEventListener("mouseup", () => { dragging = false; });
    canvas.addEventListener("mouseleave", () => { dragging = false; });
    canvas.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const dx = (e.clientX - dragX) / view.zoom;
        const dy = (e.clientY - dragY) / view.zoom;
        view.panX = downPanX + dx;
        view.panY = downPanY + dy;
        render();
    });
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
        const my = (e.clientY - rect.top)  * (canvas.height / rect.height);
        const [worldX, worldY] = canvasToCoord(mx, my, view);
        const factor = e.deltaY < 0 ? 1.25 : 0.8;
        view.zoom = Math.max(0.1, Math.min(20, view.zoom * factor));
        // Re-center so the point under the cursor stays under the cursor.
        const [newCx, newCy] = coordToCanvas(worldX, worldY, view);
        view.panX += (mx - newCx) / view.zoom;
        view.panY += (my - newCy) / view.zoom;
        render();
    }, { passive: false });
    canvas.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
        const my = (e.clientY - rect.top)  * (canvas.height / rect.height);
        const idx = pickMap(mx, my);
        if (idx !== null) { selected = idx; showMapDetails(idx); render(); }
    });
    canvas.addEventListener("dblclick", () => { fit(); });

    worldSel.addEventListener("change", () => { applyWorldFilter(); fit(); updateStats(); });
    refresh.addEventListener("click", () => { void load(); });
    resetBtn.addEventListener("click", () => { fit(); });

    searchEl.addEventListener("input", () => {
        highlighted = null;
        if (!dump) return;
        const q = parseInt(searchEl.value.trim(), 10);
        if (!Number.isFinite(q)) { render(); return; }
        const idx = dump.ids.indexOf(q);
        if (idx >= 0) {
            highlighted = idx;
            // Switch world + center on it.
            if (worldSel.value !== String(dump.worldMap[idx])) {
                worldSel.value = String(dump.worldMap[idx]);
                applyWorldFilter();
            }
            selected = idx;
            showMapDetails(idx);
        }
        render();
    });

    // Re-render on container resize via ResizeObserver.
    const ro = new ResizeObserver(() => render());
    ro.observe(canvas);

    // Cleanup when the tab panel gets replaced.
    const mo = new MutationObserver(() => {
        if (!document.body.contains(container)) {
            ro.disconnect();
            mo.disconnect();
        }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Auto-load on mount
    void load();
}
