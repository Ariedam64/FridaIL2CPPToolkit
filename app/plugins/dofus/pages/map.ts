import { renderWorldCanvas, type WorldMap, type WorldCanvasResult } from "../lib/world-canvas";
import { renderCellGrid } from "../lib/cell-grid";
import type { WorldMapDims, MappedTile } from "../lib/world-dims";
import type { PluginPageContext } from "../../../frontend/core/plugin-types";

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
                        <canvas data-testid="world-canvas" style="image-rendering:pixelated;display:block"></canvas>
                    </div>
                </div>
            </div>
            <div data-testid="cell-grid-panel" style="width:380px;padding:12px;overflow:auto">
                <p style="color:#888">Click a map to inspect.</p>
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

    await loadAndRender(canvas);
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
        dims: currentDims,
        tiles: currentTiles,
    });
    const resolved = result instanceof Promise ? await result : result;
    if (currentWorld !== worldAtStart) return;
    currentHitTest = resolved;
}

function renderNeighbours(panel: HTMLDivElement, data: MapDetail, onClick: (mapId: number) => void): void {
    const [n, e, s, w] = data.neighbours.length === 4 ? data.neighbours : [0, 0, 0, 0];
    const isValid = (id: number) => id !== 0 && id !== -1;
    const labelN = isValid(n) ? `↑ N (${data.posX}, ${data.posY - 1})` : "↑ N —";
    const labelE = isValid(e) ? `→ E (${data.posX + 1}, ${data.posY})` : "→ E —";
    const labelS = isValid(s) ? `↓ S (${data.posX}, ${data.posY + 1})` : "↓ S —";
    const labelW = isValid(w) ? `← W (${data.posX - 1}, ${data.posY})` : "← W —";

    const navHtml = `
        <div data-testid="neighbours-nav" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-top:12px;font-size:11px">
            <div></div>
            <button data-dir="n" data-mapid="${n}" ${isValid(n) ? "" : "disabled"} style="padding:4px 6px">${labelN}</button>
            <div></div>
            <button data-dir="w" data-mapid="${w}" ${isValid(w) ? "" : "disabled"} style="padding:4px 6px">${labelW}</button>
            <div></div>
            <button data-dir="e" data-mapid="${e}" ${isValid(e) ? "" : "disabled"} style="padding:4px 6px">${labelE}</button>
            <div></div>
            <button data-dir="s" data-mapid="${s}" ${isValid(s) ? "" : "disabled"} style="padding:4px 6px">${labelS}</button>
            <div></div>
        </div>
    `;
    panel.insertAdjacentHTML("beforeend", navHtml);

    panel.querySelectorAll<HTMLButtonElement>("[data-testid='neighbours-nav'] button[data-dir]").forEach((btn) => {
        if (btn.disabled) return;
        btn.addEventListener("click", () => {
            const id = parseInt(btn.dataset.mapid!, 10);
            if (isValid(id)) onClick(id);
        });
    });
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

async function loadCellGrid(panel: HTMLDivElement, canvas: HTMLCanvasElement, mapId: number): Promise<void> {
    panel.innerHTML = `<p style="color:#888">Loading…</p>`;
    try {
        const data = (await (await fetch(`/api/dofus/maps/${mapId}`)).json()) as MapDetail;
        panel.innerHTML = `
            <h3 style="margin-top:0">${escapeHtml(data.name || `Map ${data.mapId}`)}</h3>
            <p style="color:#888;font-size:12px">(${data.posX}, ${data.posY}) — area ${data.areaId}</p>
            <canvas data-testid="cell-grid-canvas" style="image-rendering:pixelated"></canvas>
        `;
        const gridCanvas = panel.querySelector<HTMLCanvasElement>("[data-testid='cell-grid-canvas']")!;
        renderCellGrid(gridCanvas, { cells: data.cells, interactives: data.interactives });
        renderNeighbours(panel, data, (neighbourId) => {
            currentSelected = neighbourId;
            void reRender(canvas);
            void loadCellGrid(panel, canvas, neighbourId);
        });
    } catch (err) {
        panel.innerHTML = `<p style="color:#f87171">Failed to load: ${escapeHtml(String(err))}</p>`;
    }
}
