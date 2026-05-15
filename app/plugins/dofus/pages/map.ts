import { renderWorldCanvas, type WorldMap, type WorldCanvasResult } from "../lib/ui/world-canvas";
import type { WorldMapDims, MappedTile } from "../lib/movement/world-dims";
import type { PluginPageContext } from "../../../frontend/core/plugin-types";
import { subscribe } from "../../../frontend/core/ws";

interface StatsResponse {
    mapCount: number;
    gfxRegistrySize: number;
    interactiveTypeCount: number;
    skills: Array<{ skillId: number; skillName: string; gatheredItem?: { itemId: number; name: string } }>;
    recentMaps: Array<{ mapId: number; lastSeenAt: number; interactivesCount: number }>;
}

const STATS_REFRESH_TRIGGER = new Set(["itx", "iet", "ieu"]);
const STATS_REFRESH_DEBOUNCE_MS = 250;

interface WorldMeta { id: number; name: string; mapCount: number; dims?: WorldMapDims }
interface MapDetail {
    mapId: number; name: string;
    posX: number; posY: number;
    subAreaId: number; areaId: number;
    neighbours: number[];
    cells: Array<[number, number, number, number, number]>;
    interactives: Array<[number, number, number]>;
}

// Module-level state — mirrors the existing pages pattern (instances.ts, etc.)
let currentWorld = 1;
let currentMaps: WorldMap[] = [];
let currentSelected: number | null = null;
let currentHover: number | null = null;
let currentPlayerMapId: number | null = null;
let currentHitTest: WorldCanvasResult | null = null;
let allWorlds: WorldMeta[] = [];
let currentDims: WorldMapDims | undefined = undefined;
let currentTiles: MappedTile[] = [];

let zoom = 1;
let panX = 0;
let panY = 0;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.1;
const DRAG_THRESHOLD_PX = 5;

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function mountMap(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    // Make host fill its parent flex container so the inner flex chain has a height to expand into.
    host.style.flex = "1";
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.minHeight = "0";
    host.innerHTML = `
        <div style="display:flex;flex:1;min-height:0">
            <div style="flex:1;display:flex;flex-direction:column;border-right:1px solid #333;min-width:0">
                <div style="padding:8px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center">
                    <label style="font-size:12px;color:#888">World:</label>
                    <select data-testid="world-select" style="padding:4px 8px"></select>
                    <span data-testid="hover-info" style="margin-left:auto;font-size:12px;color:#888"></span>
                </div>
                <div data-testid="canvas-host" style="flex:1;min-height:0;overflow:hidden;background:#0a0a0a;position:relative;cursor:grab">
                    <div data-testid="canvas-viewport" style="position:absolute;top:0;left:0;transform:translate(0px,0px) scale(1);transform-origin:0 0;will-change:transform">
                        <canvas data-testid="world-canvas" style="display:block"></canvas>
                    </div>
                </div>
            </div>
            <div style="width:520px;display:flex;flex-direction:column;min-height:0">
                <div data-testid="stats-panel" style="padding:10px;border-bottom:1px solid #333;flex:0 0 auto;font-size:11px;color:#888">
                    Loading stats…
                </div>
                <div data-testid="cell-grid-panel" style="padding:12px;overflow:auto;flex:1;min-height:0">
                    <p style="color:#888">Click a map to inspect.</p>
                </div>
            </div>
        </div>
    `;

    const select = host.querySelector<HTMLSelectElement>("[data-testid='world-select']")!;
    const canvas = host.querySelector<HTMLCanvasElement>("[data-testid='world-canvas']")!;
    const hoverInfo = host.querySelector<HTMLSpanElement>("[data-testid='hover-info']")!;
    const panel = host.querySelector<HTMLDivElement>("[data-testid='cell-grid-panel']")!;

    // Drag state — hoisted so the canvas mousemove closure can reference `dragging`
    let dragging = false;
    let dragMoved = false;
    let dragStart: { x: number; y: number; panX: number; panY: number } | null = null;

    // Populate worlds
    try {
        const worlds = (await (await fetch("/api/dofus/worlds")).json()) as { worlds: WorldMeta[] };
        allWorlds = worlds.worlds;
        select.innerHTML = worlds.worlds.map((w) =>
            `<option value="${w.id}" ${w.id === currentWorld ? "selected" : ""}>${escapeHtml(w.name)} (${w.mapCount})</option>`,
        ).join("");
        // Pick the FIRST world if currentWorld isn't in the list
        if (!worlds.worlds.find((w) => w.id === currentWorld) && worlds.worlds.length > 0) {
            currentWorld = worlds.worlds[0].id;
            select.value = String(currentWorld);
        }
    } catch (err) {
        panel.innerHTML = `<p style="color:#f87171">Failed to load worlds: ${escapeHtml(String(err))}</p>`;
        return;
    }

    select.addEventListener("change", () => {
        currentWorld = parseInt(select.value, 10);
        currentSelected = null;
        currentHover = null;
        zoom = 1; panX = 0; panY = 0;
        panel.innerHTML = `<p style="color:#888">Click a map to inspect.</p>`;
        void loadAndRender(canvas);
    });

    canvas.addEventListener("mousemove", (e) => {
        if (!currentHitTest) return;
        // Skip hover update while dragging — the drag handler owns the cursor
        if (dragging) return;
        // Use hostEl.rect (not canvas.rect) so we explicitly subtract panX/panY before
        // dividing by zoom — symmetric with the click path in the mouseup handler.
        const rect = hostEl.getBoundingClientRect();
        const canvasX = ((e.clientX - rect.left) - panX) / zoom;
        const canvasY = ((e.clientY - rect.top) - panY) / zoom;
        const hit = currentHitTest.hitTest(canvasX, canvasY);
        if (hit !== currentHover) {
            currentHover = hit;
            void reRender(canvas);
            const hovered = currentMaps.find((m) => m.mapId === hit);
            hoverInfo.textContent = hovered ? `(${hovered.posX}, ${hovered.posY}) ${hovered.name}` : "";
        }
    });

    canvas.addEventListener("mouseleave", () => {
        if (currentHover !== null) {
            currentHover = null;
            void reRender(canvas);
            hoverInfo.textContent = "";
        }
    });

    const hostEl = host.querySelector<HTMLElement>("[data-testid='canvas-host']")!;
    const viewport = host.querySelector<HTMLElement>("[data-testid='canvas-viewport']")!;

    hostEl.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = hostEl.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const zoomDelta = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * zoomDelta));
        if (newZoom === zoom) return;
        // Keep the canvas point under the cursor fixed:
        //   canvasPoint = (mouse - pan) / zoom (constant before/after)
        //   newPan = mouse - canvasPoint * newZoom
        panX = mx - ((mx - panX) / zoom) * newZoom;
        panY = my - ((my - panY) / zoom) * newZoom;
        zoom = newZoom;
        clampPan(hostEl, canvas);
        applyTransform(viewport);
    }, { passive: false });

    hostEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        dragging = true;
        dragMoved = false;
        dragStart = { x: e.clientX, y: e.clientY, panX, panY };
        hostEl.style.cursor = "grabbing";
    });

    const win = host.ownerDocument!.defaultView!;
    win.addEventListener("mousemove", (e) => {
        if (!dragging || !dragStart) return;
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        if (!dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
            dragMoved = true;
        }
        if (dragMoved) {
            panX = dragStart.panX + dx;
            panY = dragStart.panY + dy;
            clampPan(hostEl, canvas);
            applyTransform(viewport);
        }
    });

    win.addEventListener("mouseup", () => {
        if (!dragging || !dragStart) return;
        const wasClick = !dragMoved;
        const startScreenX = dragStart.x;
        const startScreenY = dragStart.y;
        dragging = false;
        dragStart = null;
        hostEl.style.cursor = "grab";
        if (wasClick && currentHitTest) {
            const rect = hostEl.getBoundingClientRect();
            const mx = startScreenX - rect.left;
            const my = startScreenY - rect.top;
            const canvasX = (mx - panX) / zoom;
            const canvasY = (my - panY) / zoom;
            const hit = currentHitTest.hitTest(canvasX, canvasY);
            if (hit !== null) {
                currentSelected = hit;
                void reRender(canvas);
                void loadCellGrid(panel, canvas, hit);
            }
        }
    });

    // Stats panel — counter + skills, refreshed on every itx/iet/ieu and on
    // mount. Independent of the world / map selection; persists across them.
    const statsPanel = host.querySelector<HTMLElement>("[data-testid='stats-panel']")!;
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshStats = async (): Promise<void> => {
        if (!host.isConnected) return;
        try {
            const r = await fetch("/api/dofus/stats");
            if (r.status === 503) {
                statsPanel.innerHTML = `<span style="color:#666">stats unavailable — attach Frida</span>`;
                return;
            }
            if (!r.ok) return;
            const stats = await r.json() as StatsResponse;
            statsPanel.innerHTML = renderStats(stats);
        } catch { /* silent */ }
    };
    const scheduleStatsRefresh = (): void => {
        if (statsTimer) return;
        statsTimer = setTimeout(() => { statsTimer = null; void refreshStats(); }, STATS_REFRESH_DEBOUNCE_MS);
    };
    const unsubStats = subscribe("network-frame-added", (msg: { frame?: { typeKey?: { className?: string } } }) => {
        const cn = msg?.frame?.typeKey?.className;
        if (cn && STATS_REFRESH_TRIGGER.has(cn)) scheduleStatsRefresh();
    });
    void refreshStats();

    // Player marker — listen to PlayerStore updates so the yellow disc
    // follows the player across maps without a refresh.
    const unsubPlayer = subscribe(
        "dofus-player-state-changed",
        (msg: { state?: { currentMapId?: number | null } }) => {
            const next = msg?.state?.currentMapId ?? null;
            if (next !== currentPlayerMapId) {
                currentPlayerMapId = next;
                void reRender(canvas);
            }
        },
    );
    // Initial fetch so the marker shows up even before the player moves.
    fetch("/api/dofus/player/state")
        .then((r) => r.json())
        .then((s: { currentMapId?: number | null }) => {
            if (typeof s?.currentMapId === "number") {
                currentPlayerMapId = s.currentMapId;
                void reRender(canvas);
            }
        })
        .catch(() => { /* not attached yet — marker stays hidden */ });

    // Best-effort cleanup on host disconnect — the WS subscriptions leak
    // otherwise across mount/unmount cycles.
    const obs = new MutationObserver(() => {
        if (!host.isConnected) { unsubStats(); unsubPlayer(); obs.disconnect(); }
    });
    if (host.parentNode) obs.observe(host.parentNode, { childList: true, subtree: true });

    await loadAndRender(canvas);
}

function fmtAgeShort(ts: number): string {
    const ageS = Math.floor((Date.now() - ts) / 1000);
    if (ageS < 60) return `${ageS}s`;
    if (ageS < 3600) return `${Math.floor(ageS / 60)}m`;
    if (ageS < 86400) return `${Math.floor(ageS / 3600)}h`;
    return `${Math.floor(ageS / 86400)}d`;
}

function renderStats(s: StatsResponse): string {
    const recents = s.recentMaps.slice(0, 5).map((m) =>
        `<span style="color:#9bd;font-family:monospace">${m.mapId}</span><span style="color:#666"> ${fmtAgeShort(m.lastSeenAt)}</span>`,
    ).join(" · ");

    const skillRows = s.skills.map((sk) => {
        const itemTail = sk.gatheredItem
            ? ` → <span style="color:#facc15">${escapeHtml(sk.gatheredItem.name)}</span>`
            : "";
        return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0">
            <span><code style="color:#666;margin-right:6px">${sk.skillId}</code>${escapeHtml(sk.skillName)}${itemTail}</span>
        </div>`;
    }).join("");

    return `
        <div style="display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;gap:10px;font-size:11px;flex-wrap:wrap">
                <span><strong style="color:#eee">${s.mapCount}</strong> <span style="color:#666">maps</span></span>
                <span><strong style="color:#eee">${s.gfxRegistrySize}</strong> <span style="color:#666">gfx</span></span>
                <span><strong style="color:#eee">${s.interactiveTypeCount}</strong> <span style="color:#666">types</span></span>
                <span><strong style="color:#eee">${s.skills.length}</strong> <span style="color:#666">skills</span></span>
            </div>
            ${recents ? `<div style="font-size:10px;color:#666">recent: ${recents}</div>` : ""}
            <details style="margin-top:2px">
                <summary style="font-size:10px;color:#9bd;cursor:pointer;list-style:none;text-transform:uppercase;letter-spacing:1px">${s.skills.length} known skills ▾</summary>
                <div style="margin-top:4px;max-height:160px;overflow:auto;border:1px solid #1a1a1a;border-radius:4px;padding:4px 8px;background:#080808">
                    ${skillRows || "<span style='color:#666;font-size:11px'>none</span>"}
                </div>
            </details>
        </div>
    `;
}

async function loadAndRender(canvas: HTMLCanvasElement): Promise<void> {
    const worldAtStart = currentWorld;
    try {
        const [mapsResp, tilesResp] = await Promise.all([
            fetch(`/api/dofus/maps/list?world=${worldAtStart}`).then((r) => r.json()) as Promise<{ maps: WorldMap[] }>,
            fetch(`/api/dofus/tile-mapping?world=${worldAtStart}`).then((r) => r.json()) as Promise<{ tiles: MappedTile[] }>,
        ]);
        if (currentWorld !== worldAtStart) return;
        currentMaps = mapsResp.maps;
        currentTiles = tilesResp.tiles ?? [];
        currentDims = allWorlds.find((w) => w.id === worldAtStart)?.dims;
        await reRender(canvas);
        const host = canvas.closest<HTMLElement>("[data-testid='canvas-host']")!;
        const viewport = canvas.closest<HTMLElement>("[data-testid='canvas-viewport']")!;
        fitToHost(host, canvas);
        applyTransform(viewport);
    } catch (err) {
        if (currentWorld !== worldAtStart) return;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = "#f87171"; ctx.font = "14px sans-serif";
            ctx.fillText("Failed to load maps: " + String(err), 10, 20);
        }
    }
}

async function reRender(canvas: HTMLCanvasElement): Promise<void> {
    const worldAtStart = currentWorld;
    const result = renderWorldCanvas(canvas, {
        maps: currentMaps,
        selectedMapId: currentSelected,
        hoveredMapId: currentHover,
        playerMapId: currentPlayerMapId,
        dims: currentDims,
        tiles: currentTiles,
    });
    const resolved = result instanceof Promise ? await result : result;
    if (currentWorld !== worldAtStart) return;
    currentHitTest = resolved;
}

interface RuntimeSkill {
    skillId: number;
    skillName: string;
    gatheredItem?: { itemId: number; name: string };
}
interface RuntimeInteractiveDto {
    cell: number; elementId: number; gfxId: number;
    typeId: number | null; typeName: string | null;
    skills: RuntimeSkill[];
    source: "live" | "gfx-registry" | "unknown";
}
interface RuntimeMapDto { mapId: number; interactives: RuntimeInteractiveDto[]; lastSeenAt: number | null }

function fmtAge(ts: number | null): string {
    if (!ts) return "—";
    const ageS = Math.floor((Date.now() - ts) / 1000);
    if (ageS < 60) return `${ageS}s ago`;
    if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
    if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
    return `${Math.floor(ageS / 86400)}d ago`;
}

async function loadInteractives(panel: HTMLDivElement, mapId: number): Promise<void> {
    const data = await fetchRuntime(mapId);
    if (!data) return;

    const SOURCE_DOT: Record<RuntimeInteractiveDto["source"], string> = {
        live: "#4ade80", "gfx-registry": "#facc15", unknown: "#666",
    };
    const lastSeen = data.lastSeenAt ? `seen ${fmtAge(data.lastSeenAt)}` : "static only";
    const rows = data.interactives.map((i) => {
        const dot = SOURCE_DOT[i.source];
        const name = i.typeName ?? `Unknown (gfx ${i.gfxId})`;
        const skillTags = i.skills.map((s) => {
            const item = s.gatheredItem ? ` → <span style="color:#facc15">${escapeHtml(s.gatheredItem.name)}</span>` : "";
            return `<span style="color:#9bd">${escapeHtml(s.skillName)}</span>${item}`;
        }).join(", ");
        return `
            <div style="display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;border-top:1px solid #1a1a1a">
                <span title="${i.source}" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dot};flex:0 0 auto"></span>
                <span style="color:#666;font-variant-numeric:tabular-nums;flex:0 0 36px">[${i.cell}]</span>
                <span style="color:#eee;flex:0 1 auto">${escapeHtml(name)}</span>
                ${skillTags ? `<span style="color:#666;font-size:10px;flex:1 1 auto;text-align:right">${skillTags}</span>` : ""}
            </div>
        `;
    }).join("");

    const html = `
        <div data-testid="interactives-list" style="margin-top:12px;border-top:1px solid #333;padding-top:8px">
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
                <strong style="color:#9bd">Interactives (${data.interactives.length})</strong>
                <span style="color:#666">${lastSeen}</span>
            </div>
            ${rows || `<span style="color:#666;font-size:11px">— none</span>`}
        </div>
    `;
    panel.insertAdjacentHTML("beforeend", html);
}


function applyTransform(viewport: HTMLElement): void {
    viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function fitToHost(host: HTMLElement, canvas: HTMLCanvasElement): void {
    const hostW = host.clientWidth;
    const hostH = host.clientHeight;
    if (canvas.width === 0 || canvas.height === 0 || hostW === 0 || hostH === 0) {
        zoom = 1; panX = 0; panY = 0; return;
    }
    zoom = Math.min(hostW / canvas.width, hostH / canvas.height, 1);
    panX = (hostW - canvas.width * zoom) / 2;
    panY = (hostH - canvas.height * zoom) / 2;
}

function clampPan(host: HTMLElement, canvas: HTMLCanvasElement): void {
    const hostW = host.clientWidth;
    const hostH = host.clientHeight;
    const canvasW = canvas.width * zoom;
    const canvasH = canvas.height * zoom;
    if (canvasW <= hostW) {
        panX = (hostW - canvasW) / 2;
    } else {
        panX = Math.max(hostW - canvasW, Math.min(0, panX));
    }
    if (canvasH <= hostH) {
        panY = (hostH - canvasH) / 2;
    } else {
        panY = Math.max(hostH - canvasH, Math.min(0, panY));
    }
}

async function loadCellGrid(panel: HTMLDivElement, _canvas: HTMLCanvasElement, mapId: number): Promise<void> {
    panel.innerHTML = `<p style="color:#888">Loading…</p>`;
    try {
        const data = (await (await fetch(`/api/dofus/maps/${mapId}`)).json()) as MapDetail;
        const runtimeData = await fetchRuntime(mapId);
        panel.innerHTML = `
            <h3 style="margin-top:0">${escapeHtml(data.name || `Map ${data.mapId}`)}</h3>
            <p style="color:#888;font-size:12px">mapId <code style="color:#9bd">${data.mapId}</code> · (${data.posX}, ${data.posY}) · area ${data.areaId}</p>
            <canvas data-testid="cell-grid-canvas" style="display:block;background:#000;border:1px solid #1a1a1a"></canvas>
            <div style="display:flex;gap:12px;font-size:10px;color:#666;margin-top:6px;flex-wrap:wrap">
                <span><span style="display:inline-block;width:10px;height:10px;background:#3a7b3a;vertical-align:middle"></span> walkable</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#5a1a1a;vertical-align:middle"></span> obstacle</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#fde047;vertical-align:middle"></span> map change</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#3b82f6;vertical-align:middle"></span> interactive</span>
            </div>
        `;
        const gridCanvas = panel.querySelector<HTMLCanvasElement>("[data-testid='cell-grid-canvas']")!;
        renderColoredCellGrid(gridCanvas, data, runtimeData);
        await loadInteractives(panel, mapId);
    } catch (err) {
        panel.innerHTML = `<p style="color:#f87171">Failed to load: ${escapeHtml(String(err))}</p>`;
    }
}

async function fetchRuntime(mapId: number): Promise<RuntimeMapDto | null> {
    try {
        const r = await fetch(`/api/dofus/maps/${mapId}/runtime`);
        if (!r.ok) return null;
        return await r.json() as RuntimeMapDto;
    } catch { return null; }
}

const COLS = 14;
const ROWS = 40;
const CELL_SIZE = 28;
const HALF_V = CELL_SIZE / 4;

function cellCenter(cellId: number): { cx: number; cy: number } {
    const row = Math.floor(cellId / COLS);
    const col = cellId % COLS;
    const cx = col * CELL_SIZE + (row & 1 ? CELL_SIZE / 2 : 0) + CELL_SIZE / 2;
    const cy = row * HALF_V + HALF_V;
    return { cx, cy };
}

function renderColoredCellGrid(canvas: HTMLCanvasElement, detail: MapDetail, runtime: RuntimeMapDto | null): void {
    canvas.width = (COLS + 0.5) * CELL_SIZE;
    canvas.height = (ROWS + 1) * HALF_V;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";

    // Status of each interactive cell: "available" / "cooldown" / "static"
    // Static `ie` is the only source post-slim. Runtime data carries
    // identification but no state — we just mark every interactive cell.
    const interactiveStatus = new Set<number>();
    for (const [cellIdx] of detail.interactives) {
        if (cellIdx >= 0 && cellIdx < COLS * ROWS) interactiveStatus.add(cellIdx);
    }
    if (runtime) {
        for (const i of runtime.interactives) {
            if (i.cell < 0 || i.cell >= COLS * ROWS) continue;
            interactiveStatus.add(i.cell);
        }
    }

    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const idx = row * COLS + col;
            const cell = detail.cells[idx];
            if (!cell) continue;
            const flags = cell[0];
            const mcd = cell[2];
            const visible = !!(flags & 32);
            if (!visible) continue;
            const walkable = !!(flags & 1) && !(flags & 8);
            const { cx, cy } = cellCenter(idx);

            let fill: string;
            if (interactiveStatus.has(idx)) fill = "#60a5fa";
            else if (!walkable) fill = "#5a1a1a";
            else if (mcd) fill = "#fde047";
            else if (flags & 16) fill = "#d9b02c";
            else fill = "#3a7b3a";

            ctx.beginPath();
            ctx.moveTo(cx, cy - HALF_V);
            ctx.lineTo(cx + CELL_SIZE / 2, cy);
            ctx.lineTo(cx, cy + HALF_V);
            ctx.lineTo(cx - CELL_SIZE / 2, cy);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.stroke();
        }
    }

    // Cell labels — cellId on walkable & interactive cells.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const idx = row * COLS + col;
            const cell = detail.cells[idx];
            if (!cell) continue;
            const flags = cell[0];
            if ((flags & 32) === 0) continue;
            const walkable = !!(flags & 1) && !(flags & 8);
            const isInteractive = interactiveStatus.has(idx);
            if (!walkable && !isInteractive) continue;
            const { cx, cy } = cellCenter(idx);
            if (isInteractive) {
                ctx.font = "bold 9px monospace";
                ctx.fillStyle = "rgba(0,0,0,0.95)";
            } else {
                ctx.font = "8px monospace";
                ctx.fillStyle = "rgba(255,255,255,0.55)";
            }
            ctx.fillText(String(idx), cx, cy);
        }
    }
}
