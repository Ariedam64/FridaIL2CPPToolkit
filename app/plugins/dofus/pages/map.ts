import { renderWorldCanvas, type WorldMap, type WorldCanvasResult } from "../lib/world-canvas";
import { renderCellGrid } from "../lib/cell-grid";
import type { PluginPageContext } from "../../../frontend/core/plugin-types";

interface WorldMeta { id: number; name: string; mapCount: number }
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
                <div data-testid="canvas-host" style="flex:1;overflow:auto;padding:12px;background:#0a0a0a;display:flex;justify-content:center;align-items:flex-start">
                    <canvas data-testid="world-canvas" style="image-rendering:pixelated;cursor:crosshair"></canvas>
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

    // Populate worlds
    try {
        const worlds = (await (await fetch("/api/dofus/worlds")).json()) as { worlds: WorldMeta[] };
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
        panel.innerHTML = `<p style="color:#888">Click a map to inspect.</p>`;
        void loadAndRender(canvas);
    });

    canvas.addEventListener("mousemove", (e) => {
        if (!currentHitTest) return;
        const rect = canvas.getBoundingClientRect();
        const hit = currentHitTest.hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit !== currentHover) {
            currentHover = hit;
            reRender(canvas);
            const hovered = currentMaps.find((m) => m.mapId === hit);
            hoverInfo.textContent = hovered ? `(${hovered.posX}, ${hovered.posY}) ${hovered.name}` : "";
        }
    });

    canvas.addEventListener("mouseleave", () => {
        if (currentHover !== null) {
            currentHover = null;
            reRender(canvas);
            hoverInfo.textContent = "";
        }
    });

    canvas.addEventListener("click", (e) => {
        if (!currentHitTest) return;
        const rect = canvas.getBoundingClientRect();
        const hit = currentHitTest.hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit === null) return;
        currentSelected = hit;
        reRender(canvas);
        void loadCellGrid(panel, hit);
    });

    await loadAndRender(canvas);
}

async function loadAndRender(canvas: HTMLCanvasElement): Promise<void> {
    const worldAtStart = currentWorld;
    try {
        const resp = (await (await fetch(`/api/dofus/maps/list?world=${worldAtStart}`)).json()) as { maps: WorldMap[] };
        // Bail if the user switched worlds while the fetch was in flight.
        if (currentWorld !== worldAtStart) return;
        currentMaps = resp.maps;
        reRender(canvas);
    } catch (err) {
        if (currentWorld !== worldAtStart) return;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = "#f87171"; ctx.font = "14px sans-serif";
            ctx.fillText("Failed to load maps: " + String(err), 10, 20);
        }
    }
}

function reRender(canvas: HTMLCanvasElement): void {
    currentHitTest = renderWorldCanvas(canvas, {
        maps: currentMaps,
        selectedMapId: currentSelected,
        hoveredMapId: currentHover,
    });
}

async function loadCellGrid(panel: HTMLDivElement, mapId: number): Promise<void> {
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
    } catch (err) {
        panel.innerHTML = `<p style="color:#f87171">Failed to load: ${escapeHtml(String(err))}</p>`;
    }
}
