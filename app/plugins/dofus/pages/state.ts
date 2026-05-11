// State sub-tab. Three persistent regions built once at mount and refreshed
// independently:
//   - Header: current map name / mapId / pos. Updated on each refresh.
//   - Move panel: clickable cell grid + path test buttons. NEVER wiped — the
//     selected from/to/path persist across refreshes (used to be cleared every
//     poll which made the test surface unusable).
//   - Grid: per-type interactive cards. The only region with frequent churn.
//
// Refreshes are triggered by WS network-frame-added events for itx/iet/ieu
// (see REFRESH_TRIGGER_CLASSES) plus a slow 10s poll fallback.

import type { PluginPageContext } from "../../../frontend/core/plugin-types";
import { subscribe } from "../../../frontend/core/ws";

interface RuntimeSkill {
    skillId: number; skillName: string; skillInstanceUid: number; active: boolean;
    gatheredItem?: { itemId: number; name: string };
}
interface HarvestState { state: number; onCurrentMap: boolean }
interface RuntimeInteractive {
    cell: number; elementId: number; gfxId: number;
    typeId: number | null; typeName: string | null;
    skills: RuntimeSkill[];
    harvestState?: HarvestState;
    source: "live" | "gfx-registry" | "unknown";
}
interface RuntimeMap {
    mapId: number;
    interactives: RuntimeInteractive[];
    lastSeenAt: number | null;
}
interface MapMeta { mapId: number; name: string; posX: number; posY: number; subAreaId: number; areaId: number }
interface MapDetail extends MapMeta {
    cells: Array<[number, number, number, number, number]>;
    interactives: Array<[number, number, number]>;
}

const REFRESH_TRIGGER_CLASSES = new Set(["itx", "iet", "ieu"]);
const REFRESH_DEBOUNCE_MS = 150;

// Cell grid layout matches cell-grid.ts (used by the map sub-tab):
// north at top, east at right, south at bottom, west at left.
const COLS = 14;
const ROWS = 40;
const CELL_SIZE = 30;
const HALF_V = CELL_SIZE / 4;

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
}

function fmtAge(ts: number | null): string {
    if (!ts) return "—";
    const ageS = Math.floor((Date.now() - ts) / 1000);
    if (ageS < 60) return `${ageS}s ago`;
    if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
    if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
    return `${Math.floor(ageS / 86400)}d ago`;
}

async function getCurrentMapId(): Promise<{ mapId: number } | { error: string; status: number }> {
    const r = await fetch("/api/dofus/map/current");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: data?.error ?? `HTTP ${r.status}`, status: r.status };
    return { mapId: data.mapId };
}

// =============================================================================
// PlayerStore mirror — fed by the WS "dofus-player-state-changed" event.
// Used to draw a player-position marker on the move-panel canvas and to
// surface position/isMoving in the header. We don't poll: each move-related
// WS frame triggers a backend refresh, which pushes the new state here.
// =============================================================================

interface PlayerState {
    currentCellId: number | null;
    targetCellId: number | null;
    cellPath: number[];
    isMoving: boolean;
    characterId: string | null;
}
const playerState: PlayerState = {
    currentCellId: null, targetCellId: null,
    cellPath: [], isMoving: false, characterId: null,
};

interface MapEntitySnapshot {
    entityId: string;
    cellId: number | null;
    name: string | null;
    level: number | null;
}
interface MapState {
    mapId: number | null;
    entities: MapEntitySnapshot[];
}
const mapState: MapState = { mapId: null, entities: [] };

async function fetchInitialPlayerState(): Promise<void> {
    try {
        const r = await fetch("/api/dofus/player/state");
        if (!r.ok) return;
        const s = await r.json() as Partial<PlayerState>;
        playerState.currentCellId = s.currentCellId ?? null;
        playerState.targetCellId = s.targetCellId ?? null;
        playerState.cellPath = Array.isArray(s.cellPath) ? s.cellPath : [];
        playerState.isMoving = !!s.isMoving;
        playerState.characterId = s.characterId ?? null;
    } catch { /* keep zeros */ }
}

async function fetchInitialMapState(): Promise<void> {
    try {
        const r = await fetch("/api/dofus/map/state");
        if (!r.ok) return;
        const s = await r.json() as Partial<MapState>;
        mapState.mapId = s.mapId ?? null;
        mapState.entities = Array.isArray(s.entities) ? s.entities : [];
    } catch { /* keep zeros */ }
}

async function getMapDetail(mapId: number): Promise<MapDetail | null> {
    try {
        const r = await fetch(`/api/dofus/maps/${mapId}`);
        if (!r.ok) return null;
        return await r.json() as MapDetail;
    } catch { return null; }
}

async function getMapRuntime(mapId: number): Promise<RuntimeMap | null> {
    try {
        const r = await fetch(`/api/dofus/maps/${mapId}/runtime`);
        if (!r.ok) return null;
        return await r.json() as RuntimeMap;
    } catch { return null; }
}

interface GroupedType {
    typeId: number | null;
    typeName: string;
    items: RuntimeInteractive[];
    harvestable: boolean;
    availableCount: number;
}

function isAvailable(i: RuntimeInteractive): boolean {
    if (i.harvestState) return i.harvestState.state === 0;
    return i.skills.some((s) => s.active);
}

function groupByType(interactives: RuntimeInteractive[]): GroupedType[] {
    const map = new Map<string, GroupedType>();
    for (const i of interactives) {
        const key = `${i.typeId ?? -1}-${i.typeName ?? ""}`;
        let g = map.get(key);
        if (!g) {
            g = { typeId: i.typeId, typeName: i.typeName ?? `Unknown (gfx ${i.gfxId})`, items: [], harvestable: false, availableCount: 0 };
            map.set(key, g);
        }
        g.items.push(i);
        if (i.skills.some((s) => s.gatheredItem)) g.harvestable = true;
        if (isAvailable(i)) g.availableCount++;
    }
    return [...map.values()].sort((a, b) => {
        if (a.harvestable !== b.harvestable) return a.harvestable ? -1 : 1;
        return a.typeName.localeCompare(b.typeName);
    });
}

function renderCard(group: GroupedType): string {
    const total = group.items.length;
    const stateBadge = group.harvestable
        ? `<span style="font-size:11px;color:${group.availableCount > 0 ? "#4ade80" : "#888"}">${group.availableCount}/${total} dispo</span>`
        : `<span style="font-size:11px;color:#888">${total}× sur la map</span>`;

    const firstHarvest = group.items[0]?.skills.find((s) => s.gatheredItem);
    const harvestHeadline = firstHarvest?.gatheredItem
        ? `<div style="font-size:12px;color:#facc15;margin-top:2px">→ ${escapeHtml(firstHarvest.gatheredItem.name)}</div>`
        : "";

    const nonHarvestSkills = group.items[0]?.skills.filter((s) => !s.gatheredItem).map((s) => s.skillName) ?? [];
    const skillLabels = nonHarvestSkills.length > 0
        ? `<div style="font-size:11px;color:#9bd;margin-top:2px">${nonHarvestSkills.map(escapeHtml).join(" · ")}</div>`
        : "";

    const chips = group.items.map((i) => {
        const isHarvestable = i.skills.some((s) => s.gatheredItem);
        const hasActive = i.skills.some((s) => s.active);
        const cellLabel = i.cell >= 0 ? String(i.cell) : "?";
        let bg: string, fg: string, border: string, tip: string;
        if (isHarvestable) {
            const avail = isAvailable(i);
            bg = avail ? "#0d3a1f" : "#1a1a1a";
            fg = avail ? "#4ade80" : "#666";
            border = avail ? "#16a34a" : "#333";
            tip = `cell ${i.cell}, state=${i.harvestState?.state ?? "?"}, ${avail ? "dispo — clic pour récolter" : "cooldown"}`;
        } else if (hasActive) {
            bg = "#0e2238"; fg = "#9bd"; border = "#2563eb";
            tip = `cell ${i.cell} — clic pour interagir`;
        } else {
            bg = "#1a1a1a"; fg = "#666"; border = "#333";
            tip = `cell ${i.cell} — pas d'action disponible`;
        }
        const disabled = !hasActive || (isHarvestable && !isAvailable(i));
        return `<button data-action="use" data-elementid="${i.elementId}" ${disabled ? "disabled" : ""}
            title="${tip}"
            style="font:11px monospace;padding:2px 8px;border-radius:4px;background:${bg};color:${fg};border:1px solid ${border};cursor:${disabled ? "default" : "pointer"};min-width:32px">${cellLabel}</button>`;
    }).join("");

    return `
        <div style="background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
                <strong style="color:#eee;font-size:13px">${escapeHtml(group.typeName)}</strong>
                ${stateBadge}
            </div>
            ${harvestHeadline}
            ${skillLabels}
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${chips}</div>
        </div>
    `;
}

// =============================================================================
// Move panel — persistent state held outside the DOM so refreshes don't wipe it
// =============================================================================

interface MoveState {
    mapId: number | null;
    detail: MapDetail | null;
    /** Last seen runtime data for the current map — used to shade interactive
     *  cells by their live availability (harvest cooldown, etc.) on the canvas. */
    runtime: RuntimeMap | null;
    fromCell: number | null;
    toCell: number | null;
    /** Set form for fast `has` lookup during redraw. */
    pathCells: Set<number>;
    /** Ordered list of cells in path, index = step number. */
    pathSequence: number[];
}

const moveState: MoveState = {
    mapId: null,
    detail: null,
    runtime: null,
    fromCell: null,
    toCell: null,
    pathCells: new Set(),
    pathSequence: [],
};

function buildMovePanel(host: HTMLElement): void {
    host.innerHTML = `
        <div data-testid="move-panel" style="background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:12px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="color:#888;text-transform:uppercase;font-size:10px;letter-spacing:1px">Path test</span>
                <span data-move="status" style="color:#9bd;font-family:monospace">click on map to set from</span>
                <span style="flex:1"></span>
                <button data-move="reset" style="padding:3px 10px;background:#1a1a1a;color:#888;border:1px solid #333;border-radius:4px;cursor:pointer">Reset</button>
                <button data-move="compute" style="padding:3px 10px;background:#1a2a4a;color:#9bd;border:1px solid #2563eb;border-radius:4px;cursor:pointer">Compute</button>
                <button data-move="send" style="padding:3px 10px;background:#0d3a1f;color:#4ade80;border:1px solid #16a34a;border-radius:4px;cursor:pointer">Send isa</button>
            </div>
            <div style="display:flex;gap:14px;align-items:flex-start">
                <canvas data-move="canvas" style="background:#000;border:1px solid #1a1a1a;cursor:crosshair;flex:0 0 auto"></canvas>
                <div data-move="result" style="flex:1;color:#666;font-family:monospace;font-size:11px;align-self:stretch;min-height:60px;white-space:pre-wrap"></div>
            </div>
            <div style="display:flex;gap:14px;font-size:10px;color:#666;align-items:center;flex-wrap:wrap">
                <span><span style="display:inline-block;width:10px;height:10px;background:#3a7b3a;vertical-align:middle"></span> walkable</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#5a1a1a;vertical-align:middle"></span> obstacle</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#fde047;vertical-align:middle"></span> map change</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#3b82f6;vertical-align:middle"></span> dispo</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#1e3a8a;vertical-align:middle"></span> cooldown</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#60a5fa;vertical-align:middle"></span> sans live</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#22c55e;vertical-align:middle"></span> from</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#ef4444;vertical-align:middle"></span> to</span>
                <span><span style="display:inline-block;width:10px;height:10px;background:#facc15;vertical-align:middle"></span> path</span>
                <span style="margin-left:auto">click cells to set from→to · 3rd click resets</span>
            </div>
        </div>
    `;
}

async function ensureMapDetailFor(mapId: number, host: HTMLElement): Promise<void> {
    if (moveState.mapId === mapId && moveState.detail) return;
    moveState.detail = await getMapDetail(mapId);
    moveState.mapId = mapId;
    // Clear the selection AND the runtime on map change — old cells aren't
    // valid and stale runtime would mislabel cells until the next refresh.
    moveState.runtime = null;
    moveState.fromCell = null;
    moveState.toCell = null;
    moveState.pathCells.clear();
    moveState.pathSequence = [];
    redrawMoveCanvas(host);
    updateMoveStatus(host);
}

function cellCenter(cellId: number): { cx: number; cy: number } {
    const row = Math.floor(cellId / COLS);
    const col = cellId % COLS;
    const cx = col * CELL_SIZE + (row & 1 ? CELL_SIZE / 2 : 0) + CELL_SIZE / 2;
    const cy = row * HALF_V + HALF_V;
    return { cx, cy };
}

function pickCellAt(mx: number, my: number, cells: ReadonlyArray<readonly [number, number, number, number, number] | undefined>): number | null {
    // Brute-force iterate (560 cells × 4 ops = trivial). Rhombus hit test:
    // |dx|/(w/2) + |dy|/(h/2) ≤ 1 where w = CELL_SIZE and h = 2*HALF_V.
    // Skip non-visible cells so a click on the white margin returns null
    // instead of grabbing a hidden cell underneath.
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const cellId = row * COLS + col;
            const cell = cells[cellId];
            if (!cell) continue;
            if ((cell[0] & 32) === 0) continue; // not visible
            const { cx, cy } = cellCenter(cellId);
            const dx = mx - cx, dy = my - cy;
            if (Math.abs(dx) / (CELL_SIZE / 2) + Math.abs(dy) / HALF_V <= 1) return cellId;
        }
    }
    return null;
}

function redrawMoveCanvas(host: HTMLElement): void {
    const canvas = host.querySelector<HTMLCanvasElement>("canvas[data-move='canvas']");
    if (!canvas) return;
    canvas.width = (COLS + 0.5) * CELL_SIZE;
    canvas.height = (ROWS + 1) * HALF_V;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const detail = moveState.detail;
    if (!detail) {
        ctx.fillStyle = "#666";
        ctx.font = "12px sans-serif";
        ctx.fillText("(loading map…)", 10, 20);
        return;
    }

    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";

    // Build a status map cellId → "available" | "cooldown" | "static" for
    // every cell hosting an interactive. "static" means we know it's there
    // from the dump but haven't seen a live frame yet (typically just after
    // attaching, before stepping on the map). "available" / "cooldown" only
    // come from runtime data.
    const interactiveStatus = new Map<number, "available" | "cooldown" | "static">();
    for (const [cellIdx] of detail.interactives) {
        if (cellIdx >= 0 && cellIdx < COLS * ROWS) interactiveStatus.set(cellIdx, "static");
    }
    if (moveState.runtime) {
        for (const i of moveState.runtime.interactives) {
            if (i.cell < 0 || i.cell >= COLS * ROWS) continue;
            const available = i.harvestState
                ? i.harvestState.state === 0
                : i.skills.some((s) => s.active);
            interactiveStatus.set(i.cell, available ? "available" : "cooldown");
        }
    }

    // Cells — visible only.
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const idx = row * COLS + col;
            const cell = detail.cells[idx];
            if (!cell) continue;
            const flags = cell[0];
            // Index 2 is mapChangeData (bitmap of which neighbour-map a step
            // transitions to: 1=N, 2=NE, 4=E, 8=SE, 16=S, 32=SW, 64=W, 128=NW).
            // Index 1 is always 0 in observed map dumps — cell-grid.ts had it
            // wrong; we read index 2 directly.
            const mcd = cell[2];
            const visible = !!(flags & 32);
            if (!visible) continue;
            const mov = !!(flags & 1);
            const nonRP = !!(flags & 8);
            const walkable = mov && !nonRP;

            const { cx, cy } = cellCenter(idx);

            const intStatus = interactiveStatus.get(idx);
            let fill: string;
            if (idx === moveState.fromCell) fill = "#22c55e";
            else if (idx === moveState.toCell) fill = "#ef4444";
            else if (moveState.pathCells.has(idx)) fill = "#facc15";
            else if (intStatus === "available") fill = "#3b82f6"; // bright blue — usable now
            else if (intStatus === "cooldown") fill = "#1e3a8a"; // dark blue — just gathered / depleted
            else if (intStatus === "static") fill = "#60a5fa"; // light blue — no live data yet
            else if (!walkable) fill = "#5a1a1a"; // dark red — visible obstacle
            else if (mcd) fill = "#fde047"; // map-change cell — bright yellow
            else if (flags & 16) fill = "#d9b02c"; // farm cell
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

    // Player markers. Two layers when the player is in motion:
    //   - Yellow filled disc on `currentCellId` = "you are physically here"
    //   - Orange ring on `targetCellId` = "you're heading there"
    // When stationary, target == current, only the disc is visible.
    // Only drawn on the map we know the player is on.
    if (
        mapState.mapId !== null
        && moveState.mapId !== null
        && mapState.mapId === moveState.mapId
    ) {
        // Target ring (orange) — drawn first so the current disc covers it
        // if the cells coincide.
        if (playerState.isMoving && playerState.targetCellId !== null) {
            const { cx, cy } = cellCenter(playerState.targetCellId);
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, 9, 0, Math.PI * 2);
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#fb923c";
            ctx.stroke();
            ctx.restore();
        }

        // Current-position disc (yellow).
        if (playerState.currentCellId !== null) {
            const { cx, cy } = cellCenter(playerState.currentCellId);
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, 8, 0, Math.PI * 2);
            ctx.fillStyle = "#facc15";
            ctx.globalAlpha = 0.85;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#000";
            ctx.stroke();
            // Inner dot for legibility when a cell label overlaps.
            ctx.beginPath();
            ctx.arc(cx, cy, 2, 0, Math.PI * 2);
            ctx.fillStyle = "#000";
            ctx.fill();
            ctx.restore();
        }
    }

    // Labels — cellId on regular walkable cells, path step number on path
    // cells (so the order is unambiguous), big bold "F"/"T" on from/to.
    // Also label interactive cells (often non-walkable) so the user can see
    // where each NPC/tree/zaap sits.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const idx = row * COLS + col;
            const cell = detail.cells[idx];
            if (!cell) continue;
            const flags = cell[0];
            if ((flags & 32) === 0) continue;
            const walkable = (flags & 1) && !(flags & 8);
            const isInteractive = interactiveStatus.has(idx);
            if (!walkable && !isInteractive) continue;
            const { cx, cy } = cellCenter(idx);

            const stepIdx = moveState.pathSequence.indexOf(idx);
            if (idx === moveState.fromCell) {
                ctx.font = "bold 11px monospace";
                ctx.fillStyle = "rgba(0,0,0,0.9)";
                ctx.fillText(`F·${idx}`, cx, cy);
            } else if (idx === moveState.toCell) {
                ctx.font = "bold 11px monospace";
                ctx.fillStyle = "rgba(0,0,0,0.9)";
                ctx.fillText(`T·${idx}`, cx, cy);
            } else if (stepIdx >= 0) {
                ctx.font = "bold 10px monospace";
                ctx.fillStyle = "rgba(0,0,0,0.9)";
                ctx.fillText(String(stepIdx), cx, cy);
            } else if (isInteractive) {
                ctx.font = "bold 9px monospace";
                ctx.fillStyle = "rgba(255,255,255,0.95)";
                ctx.fillText(String(idx), cx, cy);
            } else {
                ctx.font = "8px monospace";
                ctx.fillStyle = "rgba(255,255,255,0.55)";
                ctx.fillText(String(idx), cx, cy);
            }
        }
    }
}

function updateMoveStatus(host: HTMLElement): void {
    const status = host.querySelector<HTMLElement>("[data-move='status']");
    if (!status) return;
    if (moveState.fromCell === null) {
        status.textContent = "click on map to set from";
        status.style.color = "#9bd";
    } else if (moveState.toCell === null) {
        status.textContent = `from=${moveState.fromCell} · click to set to`;
        status.style.color = "#22c55e";
    } else {
        status.textContent = `from=${moveState.fromCell} → to=${moveState.toCell}`;
        status.style.color = "#facc15";
    }
}

function handleCanvasClick(canvas: HTMLCanvasElement, host: HTMLElement, ev: MouseEvent): void {
    if (!moveState.detail) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (canvas.width  / rect.width);
    const my = (ev.clientY - rect.top)  * (canvas.height / rect.height);
    const cell = pickCellAt(mx, my, moveState.detail.cells);
    if (cell === null) return;

    if (moveState.fromCell === null) {
        moveState.fromCell = cell;
    } else if (moveState.toCell === null) {
        moveState.toCell = cell;
    } else {
        // 3rd click — restart with this cell as new from.
        moveState.fromCell = cell;
        moveState.toCell = null;
        moveState.pathCells.clear();
        moveState.pathSequence = [];
    }
    redrawMoveCanvas(host);
    updateMoveStatus(host);
}

async function runMoveAction(action: "compute" | "send", host: HTMLElement): Promise<void> {
    const result = host.querySelector<HTMLElement>("[data-move='result']");
    if (!result) return;
    if (moveState.fromCell === null || moveState.toCell === null) {
        result.style.color = "#f87171";
        result.textContent = "select from + to on the map first";
        return;
    }
    result.style.color = "#888";
    result.textContent = "…";
    try {
        const url = action === "compute" ? "/api/dofus/movement/compute" : "/api/dofus/movement/move";
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fromCell: moveState.fromCell, toCell: moveState.toCell }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) {
            moveState.pathSequence = Array.isArray(data.path) ? data.path : [];
            moveState.pathCells = new Set(moveState.pathSequence);
            redrawMoveCanvas(host);
            const km = (data.keyMovements ?? []).join(",");
            const pivots = (data.pivots ?? [])
                .map((p: { cellId: number; direction: number }) => `${p.cellId}/${p.direction}`)
                .join(" → ");
            result.style.color = "#4ade80";
            result.textContent = `${action} ok\n${data.path?.length ?? "?"} cells\npivots: ${pivots}\nkeyMov: [${km}]`;
        } else {
            result.style.color = "#f87171";
            result.textContent = `${action} failed: ${data.reason ?? data.error ?? "unknown"}`;
        }
    } catch (err) {
        result.style.color = "#f87171";
        result.textContent = `error: ${String(err)}`;
    }
}

function handleMoveBtn(action: string | undefined, host: HTMLElement): void {
    if (action === "reset") {
        moveState.fromCell = null;
        moveState.toCell = null;
        moveState.pathCells.clear();
        moveState.pathSequence = [];
        redrawMoveCanvas(host);
        updateMoveStatus(host);
        const result = host.querySelector<HTMLElement>("[data-move='result']");
        if (result) { result.textContent = ""; result.style.color = "#666"; }
        return;
    }
    if (action === "compute" || action === "send") {
        void runMoveAction(action, host);
    }
}

// =============================================================================
// Refresh — only updates the header + grid regions; never touches the move panel
// =============================================================================

function renderHeader(meta: MapMeta | null, mapId: number, runtime: RuntimeMap): string {
    const liveCount = runtime.interactives.filter((i) => i.source === "live").length;
    const totalCount = runtime.interactives.length;
    const lastSeen = runtime.lastSeenAt ? `vu ${fmtAge(runtime.lastSeenAt)}` : "depuis le legacy import";
    // Player block — only meaningful when the PlayerStore agrees we're on this map.
    const onThisMap = mapState.mapId === mapId;
    const cellNow = onThisMap && playerState.currentCellId !== null
        ? `<code style="color:#facc15">cell ${playerState.currentCellId}</code>`
        : `<code style="color:#666">cell ?</code>`;
    const cellTarget = playerState.isMoving && playerState.targetCellId !== null && playerState.targetCellId !== playerState.currentCellId
        ? ` → <code style="color:#fb923c">${playerState.targetCellId}</code>`
        : "";
    const movingBadge = playerState.isMoving
        ? `<span style="background:#7c2d12;color:#fed7aa;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">MOVING</span>`
        : `<span style="background:#14532d;color:#86efac;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">IDLE</span>`;
    return `
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
            <div>
                <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px">Current Map</div>
                <div style="font-size:18px;color:#eee;font-weight:600">${escapeHtml(meta?.name ?? `Map ${mapId}`)}</div>
                <div style="font-size:12px;color:#888">
                    mapId <code style="color:#9bd">${mapId}</code>
                    ${meta ? ` · pos (${meta.posX}, ${meta.posY}) · area ${meta.areaId}` : ""}
                </div>
                <div style="font-size:12px;color:#888;margin-top:4px">
                    Player ${cellNow}${cellTarget}${movingBadge}
                </div>
            </div>
            <div style="text-align:right;font-size:11px;color:#888">
                <div>${totalCount} interactives</div>
                <div style="color:#4ade80">${liveCount} live</div>
                <div style="color:#666">${lastSeen}</div>
            </div>
        </div>
    `;
}

function renderGrid(runtime: RuntimeMap): string {
    const groups = groupByType(runtime.interactives);
    if (groups.length === 0) {
        return `<div style="color:#666;font-style:italic;padding:16px;text-align:center;border:1px dashed #333;border-radius:6px">—</div>`;
    }
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">${groups.map(renderCard).join("")}</div>`;
}

interface StaticDbSummary {
    totalTypes: number;
    resolvedTypes: number;
    totalGfxLearned: number;
    resolved: Array<{
        typeId: number;
        name: string;
        gfxIds: number[];
        mapCount: number;
        skills: Array<{ skillId: number; name: string; gatheredItem?: { id: number; name: string } }>;
    }>;
}

async function fetchStaticDbSummary(): Promise<StaticDbSummary | null> {
    try {
        const r = await fetch("/api/dofus/static-db/summary");
        if (!r.ok) return null;
        return await r.json() as StaticDbSummary;
    } catch { return null; }
}

function renderDb(db: StaticDbSummary | null): string {
    if (!db) {
        return `<div style="color:#666;padding:12px;font-style:italic">DB indisponible</div>`;
    }
    const pct = db.totalTypes > 0 ? Math.round((db.resolvedTypes / db.totalTypes) * 1000) / 10 : 0;
    const header = `
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
            <div>
                <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px">Static DB</div>
                <div style="font-size:14px;color:#eee;font-weight:600">
                    ${db.resolvedTypes} / ${db.totalTypes} types résolus
                    <span style="color:#888;font-weight:400">(${pct}%)</span>
                </div>
            </div>
            <div style="font-size:11px;color:#888;text-align:right">
                <div><span style="color:#9bd">${db.totalGfxLearned}</span> gfxIds appris</div>
                <div style="color:#666">+1 entry à chaque nouveau (typeId, gfxId) vu en itx</div>
            </div>
        </div>
        <div style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;margin-bottom:14px">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#3a7b3a,#4ade80);transition:width .25s"></div>
        </div>
    `;
    if (db.resolved.length === 0) {
        return header + `<div style="color:#666;font-style:italic;padding:12px;border:1px dashed #333;border-radius:6px;text-align:center">Aucun type encore résolu — visite des maps pour apprendre.</div>`;
    }
    const rows = db.resolved.map((e) => {
        const skillsTxt = e.skills.length > 0
            ? e.skills.map((s) => {
                const item = s.gatheredItem ? ` → <span style="color:#facc15">${escapeHtml(s.gatheredItem.name)}</span>` : "";
                return `<span style="color:#9bd">${escapeHtml(s.name)}</span>${item}`;
            }).join(", ")
            : `<span style="color:#666">—</span>`;
        const gfxTxt = e.gfxIds.slice(0, 4).join(", ") + (e.gfxIds.length > 4 ? ` <span style="color:#666">+${e.gfxIds.length - 4}</span>` : "");
        return `
            <div style="display:grid;grid-template-columns:42px 1fr auto;gap:8px;padding:6px 8px;border-top:1px solid #1a1a1a;font-size:11px;align-items:baseline">
                <span style="color:#666;font-variant-numeric:tabular-nums">#${e.typeId}</span>
                <div>
                    <div style="color:#eee">${escapeHtml(e.name)} <span style="color:#666;font-size:10px">[gfx ${gfxTxt}]</span></div>
                    <div style="color:#888;font-size:10px;margin-top:2px">${skillsTxt}</div>
                </div>
                <span style="color:#666;font-size:10px;white-space:nowrap">${e.mapCount > 0 ? `${e.mapCount} map${e.mapCount > 1 ? "s" : ""}` : ""}</span>
            </div>
        `;
    }).join("");
    return header + `
        <div style="border:1px solid #1a1a1a;border-radius:6px;max-height:400px;overflow-y:auto">
            ${rows}
        </div>
    `;
}

function setRegion(host: HTMLElement, region: string, html: string): void {
    const el = host.querySelector<HTMLElement>(`[data-region='${region}']`);
    if (el) el.innerHTML = html;
}

function setEmptyMessage(host: HTMLElement, msg: string, hint?: string): void {
    setRegion(host, "header", `
        <div style="text-align:center;padding:32px 16px;color:#888">
            <div style="font-size:14px">${escapeHtml(msg)}</div>
            ${hint ? `<div style="font-size:12px;margin-top:6px;color:#666">${escapeHtml(hint)}</div>` : ""}
        </div>
    `);
    setRegion(host, "grid", "");
}

async function refresh(host: HTMLElement): Promise<void> {
    // mapId comes from the PlayerStore (MapRenderer instance) — single source
    // of truth, no WS-itx dependency. Falls back to the legacy
    // /api/dofus/map/current ONLY if the PlayerStore hasn't bootstrapped yet
    // (covers the brief window before the first state-fetch resolves).
    let mapId = mapState.mapId;
    if (mapId === null) {
        const cur = await getCurrentMapId();
        if ("error" in cur) {
            if (cur.status === 503) setEmptyMessage(host, "Pas attaché à un jeu Dofus", "Attache l'agent Frida pour voir l'état runtime.");
            else if (cur.status === 404) setEmptyMessage(host, "Map courante pas encore connue", cur.error);
            else setEmptyMessage(host, "Erreur", cur.error);
            return;
        }
        mapId = cur.mapId;
    }

    // Move panel canvas — load detail when map changes (no-op otherwise).
    const movePanelEl = host.querySelector<HTMLElement>("[data-region='move-panel']");
    if (movePanelEl) await ensureMapDetailFor(mapId, movePanelEl);

    const runtime = await getMapRuntime(mapId);
    if (!runtime) {
        setEmptyMessage(host, "Données runtime indisponibles", `Map ${mapId} — réessaie dans 1 seconde`);
        return;
    }
    const meta = moveState.detail; // reuse the detail we already fetched

    moveState.runtime = runtime;
    if (movePanelEl) redrawMoveCanvas(movePanelEl);

    setRegion(host, "header", renderHeader(meta, mapId, runtime));
    setRegion(host, "grid", renderGrid(runtime));
    void fetchStaticDbSummary().then((db) => setRegion(host, "db", renderDb(db)));
}

/** Lightweight header refresh — re-renders only the position/isMoving line
 *  using the in-memory `playerState` + `moveState.runtime` we already have.
 *  Avoids the full refresh() round-trips when only the player moved within
 *  the current map (no map change, no interactives change). */
function refreshHeaderLite(host: HTMLElement): void {
    if (mapState.mapId === null || !moveState.runtime) return;
    const meta = moveState.detail;
    setRegion(host, "header", renderHeader(meta, mapState.mapId, moveState.runtime));
}

/** Renders the live PlayerStore + MapStateStore snapshots as JSON blocks.
 *  Pure read-out for debugging — the bot uses /api/dofus/{player,map}/state
 *  or the corresponding WS pushes directly. */
function renderPlayerRaw(): string {
    return `
        <details open style="background:#0d0d0d;border:1px solid #1f1f1f;border-radius:6px;padding:6px 12px">
            <summary style="cursor:pointer;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:1px">
                PlayerState (raw)
            </summary>
            <pre style="margin:8px 0 4px;font-family:var(--font-code,monospace);font-size:11px;color:#bbb;line-height:1.5;white-space:pre">${JSON.stringify(playerState, null, 2)}</pre>
        </details>
        <details open style="background:#0d0d0d;border:1px solid #1f1f1f;border-radius:6px;padding:6px 12px;margin-top:8px">
            <summary style="cursor:pointer;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:1px">
                MapState (raw)
            </summary>
            <pre style="margin:8px 0 4px;font-family:var(--font-code,monospace);font-size:11px;color:#bbb;line-height:1.5;white-space:pre">${JSON.stringify(mapState, null, 2)}</pre>
        </details>
    `;
}

function refreshPlayerRaw(host: HTMLElement): void {
    setRegion(host, "player-raw", renderPlayerRaw());
}

export async function mountState(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    host.style.cssText = "padding:14px;color:#ccc;font-family:system-ui,sans-serif";
    host.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:18px">
            <div data-region="header"></div>
            <div data-region="player-raw"></div>
            <div data-region="move-panel"></div>
            <div data-region="grid"></div>
            <div data-region="db"></div>
        </div>
    `;

    // Initial PlayerState raw block (nulls until the WS push lands).
    refreshPlayerRaw(host);

    // Build the move panel skeleton ONCE — refresh() never touches it.
    const movePanelHost = host.querySelector<HTMLElement>("[data-region='move-panel']");
    if (movePanelHost) {
        buildMovePanel(movePanelHost);
        redrawMoveCanvas(movePanelHost);
        updateMoveStatus(movePanelHost);

        // Canvas click → set from / to / restart cycle. Hover → show cellId
        // in the canvas tooltip so the user can verify which cellId sits
        // visually where they think it does (vs the in-game iso projection).
        const canvas = movePanelHost.querySelector<HTMLCanvasElement>("canvas[data-move='canvas']");
        if (canvas) {
            canvas.addEventListener("click", (ev) => handleCanvasClick(canvas, movePanelHost, ev));
            canvas.addEventListener("mousemove", (ev) => {
                if (!moveState.detail) return;
                const rect = canvas.getBoundingClientRect();
                const mx = (ev.clientX - rect.left) * (canvas.width  / rect.width);
                const my = (ev.clientY - rect.top)  * (canvas.height / rect.height);
                const cell = pickCellAt(mx, my, moveState.detail.cells);
                canvas.title = cell !== null ? `cell ${cell} (row ${Math.floor(cell / COLS)}, col ${cell % COLS})` : "";
            });
        }

        // Reset / Compute / Send buttons.
        movePanelHost.addEventListener("click", (ev) => {
            const btn = (ev.target as HTMLElement)?.closest?.<HTMLButtonElement>("button[data-move]");
            if (!btn) return;
            handleMoveBtn(btn.dataset.move, movePanelHost);
        });
    }

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubFrame: (() => void) | null = null;
    let unsubPlayer: (() => void) | null = null;

    const cleanup = (): void => {
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        if (unsubFrame) { unsubFrame(); unsubFrame = null; }
        if (unsubPlayer) { unsubPlayer(); unsubPlayer = null; }
    };

    const doRefresh = async (): Promise<void> => {
        if (!host.isConnected) { cleanup(); return; }
        try { await refresh(host); } catch { /* keep polling */ }
    };

    const scheduleRefresh = (): void => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void doRefresh();
        }, REFRESH_DEBOUNCE_MS);
    };

    unsubFrame = subscribe("network-frame-added", (msg: { frame?: { typeKey?: { className?: string } } }) => {
        const cn = msg?.frame?.typeKey?.className;
        if (cn && REFRESH_TRIGGER_CLASSES.has(cn)) scheduleRefresh();
    });

    // Player state changes (cell/move) — light redraws only. Map-id changes
    // come on a separate event below.
    unsubPlayer = subscribe("dofus-player-state-changed", (msg: { state?: Partial<PlayerState> }) => {
        const s = msg?.state ?? {};
        playerState.currentCellId = s.currentCellId ?? null;
        playerState.targetCellId = s.targetCellId ?? null;
        playerState.cellPath = Array.isArray(s.cellPath) ? s.cellPath : [];
        playerState.isMoving = !!s.isMoving;
        playerState.characterId = s.characterId ?? playerState.characterId;
        refreshPlayerRaw(host);
        const movePanelHost = host.querySelector<HTMLElement>("[data-region='move-panel']");
        if (movePanelHost) redrawMoveCanvas(movePanelHost);
        refreshHeaderLite(host);
    });

    // Map state changes (mapId, entities) — full refresh on mapId change.
    let lastSeenMapId = mapState.mapId;
    const unsubMapState = subscribe("dofus-map-state-changed", (msg: { state?: Partial<MapState> }) => {
        const s = msg?.state ?? {};
        mapState.mapId = s.mapId ?? null;
        mapState.entities = Array.isArray(s.entities) ? s.entities : [];
        refreshPlayerRaw(host);
        if (mapState.mapId !== lastSeenMapId) {
            lastSeenMapId = mapState.mapId;
            scheduleRefresh();
        }
    });
    // Track the unsub through the existing cleanup hook.
    const prevUnsubPlayer = unsubPlayer;
    unsubPlayer = (): void => { try { prevUnsubPlayer(); } catch {} try { unsubMapState(); } catch {} };

    // Bootstrap: fetch the initial state and do one full refresh.
    void Promise.all([fetchInitialPlayerState(), fetchInitialMapState()]).then(() => {
        lastSeenMapId = mapState.mapId;
        refreshPlayerRaw(host);
        scheduleRefresh();
    });

    // Delegated click handler for per-instance "use" chips inside the grid.
    host.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement)?.closest?.<HTMLButtonElement>("button[data-action='use']");
        if (!btn || btn.disabled) return;
        const elementId = Number(btn.dataset.elementid);
        if (!Number.isFinite(elementId)) return;
        const orig = btn.textContent ?? "";
        btn.disabled = true;
        btn.textContent = "…";
        void (async () => {
            try {
                const r = await fetch("/api/dofus/interactive/use", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ elementId }),
                });
                const data = await r.json().catch(() => ({}));
                if (data.ok) {
                    btn.textContent = "✓";
                    btn.title = `Sent: ${data.skillName ?? "skill"} (uid=${data.skillInstanceUid})`;
                    scheduleRefresh();
                } else {
                    btn.textContent = "✗";
                    btn.title = `Failed: ${data.reason ?? data.error ?? "unknown"}`;
                    setTimeout(() => { if (host.isConnected) { btn.textContent = orig; btn.disabled = false; } }, 1500);
                }
            } catch (err) {
                btn.textContent = "✗";
                btn.title = `Error: ${String(err)}`;
                setTimeout(() => { if (host.isConnected) { btn.textContent = orig; btn.disabled = false; } }, 1500);
            }
        })();
    });

    // No more 10s slow-poll: the PlayerStore push (`dofus-player-state-changed`)
    // covers map changes, and `network-frame-added` for itx/iet/ieu covers
    // interactive-state changes. If both signals miss for some reason, the
    // user can refresh the panel by re-clicking the tab.
}
