// State sub-tab. Wholly driven by PlayerStore/MapStateStore WS pushes.
// Static data (typeId resolution DB, per-map cell topology) is fetched only
// when needed: once at mount for the DB; once per mapId change for the cells.
// No runtime HTTP fetches — `network-frame-added` triggers nothing here.

import type { PluginPageContext } from "../../../frontend/core/plugin-types";
import { subscribe } from "../../../frontend/core/ws";

// =============================================================================
// Types
// =============================================================================

interface PlayerState {
    currentCellId: number | null;
    targetCellId: number | null;
    cellPath: number[];
    isMoving: boolean;
    characterId: string | null;
}

interface MapInteractableSkill { skillId: number; skillInstanceUid: number }
interface MapInteractable {
    elementId: number;
    cellId: number | null;
    interactiveTypeId: number;
    state: number;
    enabledSkills: MapInteractableSkill[];
    disabledSkills: MapInteractableSkill[];
    isReady: boolean;
    canInteract: boolean;
}
type MapEntityKind = "player" | "monsterGroup" | "npc" | "unknown";
interface MapEntityMonster { monsterId: number; level: number; grade: number }
interface MapEntitySnapshot {
    entityId: string;
    cellId: number | null;
    kind: MapEntityKind;
    name: string | null;
    level: number | null;
    monsters?: MapEntityMonster[];
    npcId?: number;
}

const ENTITY_COLORS: Record<MapEntityKind, string> = {
    player:       "#a78bfa",  // purple — other players
    monsterGroup: "#ef4444",  // red — aggressive mobs
    npc:          "#06b6d4",  // cyan — NPCs (quest, vendor, etc.)
    unknown:      "#6b7280",  // gray
};

// Lazy-loaded monster catalog (id → name). Resolves monsterId for tooltips.
let monsterNameById: Map<number, string> | null = null;
async function ensureMonsterCatalog(): Promise<void> {
    if (monsterNameById) return;
    try {
        const r = await fetch("/api/dofus/catalog/monsters");
        if (!r.ok) return;
        const data = await r.json() as { items: Array<{ id: number; name: string }> };
        monsterNameById = new Map(data.items.map((m) => [m.id, m.name]));
    } catch { /* leave null, tooltip falls back to ids */ }
}
interface MapState {
    mapId: number | null;
    entities: MapEntitySnapshot[];
    interactables: MapInteractable[];
}

interface MapDetail {
    mapId: number; name: string; posX: number; posY: number;
    subAreaId: number; areaId: number;
    cells: Array<[number, number, number, number, number]>;
    interactives: Array<[number, number, number]>;
}

interface ResolvedTypeSkill {
    skillId: number; name: string;
    gatheredItem?: { id: number; name: string };
}
interface ResolvedType {
    typeId: number; name: string; gfxIds: number[];
    mapCount: number; skills: ResolvedTypeSkill[];
}
interface StaticDbSummary {
    totalTypes: number; resolvedTypes: number; totalGfxLearned: number;
    resolved: ResolvedType[];
}

// =============================================================================
// Module-scope state — single source of truth
// =============================================================================

const playerState: PlayerState = {
    currentCellId: null, targetCellId: null,
    cellPath: [], isMoving: false, characterId: null,
};

interface MinimapFilters {
    showPlayer: boolean;
    showEntities: boolean;
    onlyActionable: boolean;
    showPath: boolean;
}
const minimapFilters: MinimapFilters = {
    showPlayer: true,
    showEntities: true,
    onlyActionable: false,
    showPath: true,
};
const mapState: MapState = { mapId: null, entities: [], interactables: [] };
let currentMapDetail: MapDetail | null = null;
const staticByType = new Map<number, ResolvedType>();

// =============================================================================
// Autopilot panel state
// =============================================================================

interface TravelStatus {
    state: "idle" | "running" | "done" | "failed" | "cancelled";
    destMapId: number | null;
    currentEdgeIdx: number | null;
    totalEdges: number | null;
    currentTransitionCell: number | null;
    lastError: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

const travelStatus: TravelStatus = {
    state: "idle",
    destMapId: null,
    currentEdgeIdx: null,
    totalEdges: null,
    currentTransitionCell: null,
    lastError: null,
    startedAt: null,
    finishedAt: null,
};

let travelPollTimer: ReturnType<typeof setInterval> | null = null;
const TRAVEL_POLL_MS = 500;

async function fetchTravelStatus(): Promise<void> {
    try {
        const r = await fetch("/api/dofus/travel/status");
        if (!r.ok) return;
        const s = await r.json() as TravelStatus;
        Object.assign(travelStatus, s);
    } catch { /* leave previous */ }
}

function startTravelPoll(host: HTMLElement): void {
    if (travelPollTimer) return;
    travelPollTimer = setInterval(async () => {
        await fetchTravelStatus();
        renderAutopilotPanel(host);
        if (travelStatus.state !== "running") {
            if (travelPollTimer) { clearInterval(travelPollTimer); travelPollTimer = null; }
        }
    }, TRAVEL_POLL_MS);
}

function stopTravelPoll(): void {
    if (travelPollTimer) { clearInterval(travelPollTimer); travelPollTimer = null; }
}

// Cell grid layout matches the in-game iso projection used by cell-grid.ts:
// north top, east right, south bottom, west left.
const COLS = 14;
const ROWS = 40;
const CELL_SIZE = 40;
const HALF_V = CELL_SIZE / 4;

// =============================================================================
// Utils
// =============================================================================

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
}

function cellCenter(cellId: number): { cx: number; cy: number } {
    const row = Math.floor(cellId / COLS);
    const col = cellId % COLS;
    const cx = col * CELL_SIZE + (row & 1 ? CELL_SIZE / 2 : 0) + CELL_SIZE / 2;
    const cy = row * HALF_V + HALF_V;
    return { cx, cy };
}

// =============================================================================
// Fetches — only on mount + on mapId change. Never per-frame.
// =============================================================================

async function fetchPlayerState(): Promise<void> {
    try {
        const r = await fetch("/api/dofus/player/state");
        if (!r.ok) return;
        const s = await r.json() as Partial<PlayerState>;
        playerState.currentCellId = s.currentCellId ?? null;
        playerState.targetCellId = s.targetCellId ?? null;
        playerState.cellPath = Array.isArray(s.cellPath) ? s.cellPath : [];
        playerState.isMoving = !!s.isMoving;
        playerState.characterId = s.characterId ?? null;
    } catch { /* leave defaults */ }
}

async function fetchMapState(): Promise<void> {
    try {
        const r = await fetch("/api/dofus/map/state");
        if (!r.ok) return;
        const s = await r.json() as Partial<MapState>;
        mapState.mapId = s.mapId ?? null;
        mapState.entities = Array.isArray(s.entities) ? s.entities : [];
        mapState.interactables = Array.isArray(s.interactables) ? s.interactables : [];
    } catch { /* leave defaults */ }
}

async function fetchMapDetail(mapId: number): Promise<void> {
    try {
        const r = await fetch(`/api/dofus/maps/${mapId}`);
        if (!r.ok) { currentMapDetail = null; return; }
        currentMapDetail = await r.json() as MapDetail;
    } catch { currentMapDetail = null; }
}

async function fetchStaticDb(): Promise<void> {
    try {
        const r = await fetch("/api/dofus/static-db/summary");
        if (!r.ok) return;
        const db = await r.json() as StaticDbSummary;
        staticByType.clear();
        for (const e of db.resolved) staticByType.set(e.typeId, e);
    } catch { /* leave empty */ }
}

// =============================================================================
// Renderers — pure projections of module state into the DOM.
// =============================================================================

function renderHeader(host: HTMLElement): void {
    const slot = host.querySelector<HTMLElement>("[data-region='header']");
    if (!slot) return;
    if (mapState.mapId === null) {
        slot.innerHTML = `
            <div style="padding:24px;text-align:center;color:#888">
                <div style="font-size:14px">Pas attaché ou map pas encore connue</div>
                <div style="font-size:11px;margin-top:6px;color:#666">Attache l'agent Frida pour voir l'état runtime.</div>
            </div>`;
        return;
    }
    const meta = currentMapDetail;
    const name = escapeHtml(meta?.name ?? `Map ${mapState.mapId}`);
    const pos = meta ? ` · pos (${meta.posX}, ${meta.posY}) · area ${meta.areaId}` : "";
    const cellNow = playerState.currentCellId !== null
        ? `<code style="color:#facc15">cell ${playerState.currentCellId}</code>`
        : `<code style="color:#666">cell ?</code>`;
    const cellTarget =
        playerState.isMoving
        && playerState.targetCellId !== null
        && playerState.targetCellId !== playerState.currentCellId
            ? ` → <code style="color:#fb923c">${playerState.targetCellId}</code>`
            : "";
    const moveBadge = playerState.isMoving
        ? `<span style="background:#7c2d12;color:#fed7aa;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">MOVING</span>`
        : `<span style="background:#14532d;color:#86efac;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px">IDLE</span>`;
    slot.innerHTML = `
        <div>
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px">Current Map</div>
            <div style="font-size:18px;color:#eee;font-weight:600">${name}</div>
            <div style="font-size:12px;color:#888">mapId <code style="color:#9bd">${mapState.mapId}</code>${pos}</div>
            <div style="font-size:12px;color:#888;margin-top:4px">Player ${cellNow}${cellTarget}${moveBadge}</div>
        </div>`;
}

function renderAutopilotPanel(host: HTMLElement): void {
    const slot = host.querySelector<HTMLElement>("[data-region='autopilot']");
    if (!slot) return;

    const s = travelStatus;
    const showInput = s.state !== "running";

    let body = "";
    if (s.state === "running") {
        const step = (s.currentEdgeIdx ?? 0) + 1;
        body = `
            <div style="display:flex;align-items:center;gap:12px;color:#a78bfa">
                <span>→ Map ${s.destMapId}</span>
                <span style="color:#666">·</span>
                <span>step ${step}/${s.totalEdges ?? "?"}</span>
                ${s.currentTransitionCell != null ? `<span style="color:#666">·</span><span>cell ${s.currentTransitionCell}</span>` : ""}
                <button data-action="travel-cancel" style="margin-left:auto">Cancel</button>
            </div>`;
    } else if (s.state === "done") {
        const elapsed = s.startedAt && s.finishedAt ? Math.round((s.finishedAt - s.startedAt) / 1000) : null;
        body = `<div style="color:#86efac">✓ Arrivé à ${s.destMapId}${s.totalEdges != null ? `  (${s.totalEdges} steps${elapsed != null ? `, ${elapsed}s` : ""})` : ""}</div>`;
    } else if (s.state === "failed") {
        body = `<div style="color:#fca5a5">✗ failed: ${escapeHtml(s.lastError ?? "unknown")}</div>`;
    } else if (s.state === "cancelled") {
        body = `<div style="color:#fcd34d">⊘ cancelled</div>`;
    }

    const inputRow = showInput ? `
        <div style="display:flex;align-items:center;gap:8px;margin-top:${body ? "6px" : "0"}">
            <span style="color:#888;font-size:11px">Aller à map</span>
            <input data-input="travel-dest" type="number" placeholder="mapId" style="width:140px;background:#1a1a1a;border:1px solid #333;color:#ddd;padding:4px 6px;font:11px monospace" />
            <button data-action="travel-go">Go</button>
        </div>` : "";

    slot.innerHTML = `
        <div style="border:1px solid #2a2a2a;padding:8px 10px;border-radius:4px;background:#181818;margin-top:8px">
            <div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Autopilot</div>
            ${body}
            ${inputRow}
        </div>`;
}

function renderRaw(host: HTMLElement): void {
    const slot = host.querySelector<HTMLElement>("[data-region='raw']");
    if (!slot) return;
    // Build the <details> shells ONCE so the user's open/closed toggle survives
    // updates. Subsequent calls only patch the <pre> contents, leaving the
    // <details> elements (and their `open` attribute) untouched.
    const existingPre = slot.querySelectorAll<HTMLPreElement>("pre[data-raw]");
    if (existingPre.length === 2) {
        existingPre[0]!.textContent = JSON.stringify(playerState, null, 2);
        existingPre[1]!.textContent = JSON.stringify(mapState, null, 2);
        return;
    }
    const block = (key: "player" | "map", title: string, payload: unknown): string => `
        <details open style="background:#0d0d0d;border:1px solid #1f1f1f;border-radius:6px;padding:6px 12px${key === "map" ? ";margin-top:8px" : ""}">
            <summary style="cursor:pointer;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:1px;display:flex;justify-content:space-between;align-items:center;gap:8px;list-style:none">
                <span>${title}</span>
                <button data-copy="${key}" style="font:10px monospace;padding:2px 10px;background:#1a1a1a;color:#9bd;border:1px solid #333;border-radius:3px;cursor:pointer">Copy</button>
            </summary>
            <pre data-raw="${key}" style="margin:8px 0 4px;font-family:var(--font-code,monospace);font-size:11px;color:#bbb;line-height:1.5;white-space:pre">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
        </details>`;
    slot.innerHTML = block("player", "PlayerState (raw)", playerState) + block("map", "MapState (raw)", mapState);
}

function redrawMinimap(host: HTMLElement): void {
    const canvas = host.querySelector<HTMLCanvasElement>("[data-region='minimap'] canvas");
    if (!canvas) return;
    canvas.width = (COLS + 0.5) * CELL_SIZE;
    canvas.height = (ROWS + 1) * HALF_V;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!currentMapDetail) {
        ctx.fillStyle = "#666";
        ctx.font = "12px sans-serif";
        ctx.fillText("(map detail loading…)", 10, 20);
        return;
    }

    const interactiveByCell = new Map<number, MapInteractable>();
    for (const i of mapState.interactables) {
        if (i.cellId === null || i.cellId < 0 || i.cellId >= COLS * ROWS) continue;
        // Filter: when onlyActionable, drop everything that's not ready & usable.
        if (minimapFilters.onlyActionable && !(i.isReady && i.canInteract)) continue;
        interactiveByCell.set(i.cellId, i);
    }
    // Path cells get top fill priority — the in-flight route is the most
    // important read-out when the player is moving. Empty Set when stationary
    // or when the user hides the path layer.
    const pathSet = minimapFilters.showPath ? new Set<number>(playerState.cellPath) : new Set<number>();

    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";

    const drawRhombus = (idx: number, fill: string): void => {
        const { cx, cy } = cellCenter(idx);
        ctx.beginPath();
        ctx.moveTo(cx, cy - HALF_V);
        ctx.lineTo(cx + CELL_SIZE / 2, cy);
        ctx.lineTo(cx, cy + HALF_V);
        ctx.lineTo(cx - CELL_SIZE / 2, cy);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.stroke();
    };

    // Pass 1: base cells (walkable, map-change) — gated by the static visible
    // flag. Cells holding an interactive or in the path are deferred to the
    // passes below so the upper layers paint cleanly.
    for (let idx = 0; idx < COLS * ROWS; idx++) {
        if (interactiveByCell.has(idx) || pathSet.has(idx)) continue;
        const cell = currentMapDetail.cells[idx];
        if (!cell) continue;
        const flags = cell[0];
        if ((flags & 32) === 0) continue;            // not visible
        const mcd = cell[2];                          // mapChangeData
        const walkable = !!(flags & 1) && !(flags & 8);
        if (mcd)            drawRhombus(idx, "#fde047");  // jaune (map change)
        else if (walkable)  drawRhombus(idx, "#3a7b3a");  // vert
    }

    // Pass 2: interactives — always drawn regardless of the static visible
    // flag. The server is the source of truth for where they sit; the static
    // dump sometimes fails to flag those cells visible, but they ARE on the
    // playable map. Path cells fall through to pass 3.
    for (const [cellId, ix] of interactiveByCell) {
        if (pathSet.has(cellId)) continue;
        if (ix.isReady && ix.canInteract) drawRhombus(cellId, "#3b82f6");  // bleu vif
        else if (!ix.isReady)             drawRhombus(cellId, "#1e3a8a");  // bleu foncé
        else                               drawRhombus(cellId, "#60a5fa");  // bleu clair
    }

    // Pass 3: in-flight path — top priority, overrides everything.
    for (const cellId of pathSet) {
        drawRhombus(cellId, "#f97316");
    }

    // Player markers — only when mapDetail matches the live mapState.mapId
    // (during a map transition the stale detail mustn't host a marker).
    if (mapState.mapId === currentMapDetail.mapId) {
        // Other entities first (lower z-order so the player marker tops them).
        // Coloring is driven by entity.kind — purple/red/cyan/gray.
        if (minimapFilters.showEntities) {
            ctx.save();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(0,0,0,0.7)";
            for (const e of mapState.entities) {
                if (e.cellId === null || e.cellId < 0 || e.cellId >= COLS * ROWS) continue;
                if (playerState.characterId !== null && e.entityId === playerState.characterId) continue;
                const { cx, cy } = cellCenter(e.cellId);
                ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2);
                ctx.fillStyle = ENTITY_COLORS[e.kind] ?? ENTITY_COLORS.unknown;
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
        }

        if (minimapFilters.showPlayer) {
            if (playerState.isMoving && playerState.targetCellId !== null) {
                const { cx, cy } = cellCenter(playerState.targetCellId);
                ctx.save();
                ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2);
                ctx.lineWidth = 2; ctx.strokeStyle = "#fb923c"; ctx.stroke();
                ctx.restore();
            }
            if (playerState.currentCellId !== null) {
                const { cx, cy } = cellCenter(playerState.currentCellId);
                ctx.save();
                ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2);
                ctx.fillStyle = "#facc15"; ctx.globalAlpha = 0.85; ctx.fill();
                ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.strokeStyle = "#000"; ctx.stroke();
                ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2);
                ctx.fillStyle = "#000"; ctx.fill();
                ctx.restore();
            }
        }
    }

    // Cell-id labels on every drawn cell. White text + thin black outline so
    // it reads on all the fill colors (green/yellow/blue/orange).
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 9px monospace";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    for (let idx = 0; idx < COLS * ROWS; idx++) {
        let drawn = interactiveByCell.has(idx) || pathSet.has(idx);
        if (!drawn) {
            const cell = currentMapDetail.cells[idx];
            if (cell && (cell[0] & 32)) {
                const walkable = !!(cell[0] & 1) && !(cell[0] & 8);
                if (cell[2] || walkable) drawn = true;
            }
        }
        if (!drawn) continue;
        const { cx, cy } = cellCenter(idx);
        ctx.strokeText(String(idx), cx, cy);
        ctx.fillText(String(idx), cx, cy);
    }
}

interface GroupedContent {
    typeId: number;
    resolved: ResolvedType | null;
    items: MapInteractable[];
    readyCount: number;
}

function groupContent(): GroupedContent[] {
    const groups = new Map<number, GroupedContent>();
    for (const ix of mapState.interactables) {
        let g = groups.get(ix.interactiveTypeId);
        if (!g) {
            g = {
                typeId: ix.interactiveTypeId,
                resolved: staticByType.get(ix.interactiveTypeId) ?? null,
                items: [],
                readyCount: 0,
            };
            groups.set(ix.interactiveTypeId, g);
        }
        g.items.push(ix);
        if (ix.isReady && ix.canInteract) g.readyCount++;
    }
    // Harvest types first (a skill has gatheredItem), then alphabetical.
    return [...groups.values()].sort((a, b) => {
        const ah = a.resolved?.skills.some((s) => s.gatheredItem) ? 0 : 1;
        const bh = b.resolved?.skills.some((s) => s.gatheredItem) ? 0 : 1;
        if (ah !== bh) return ah - bh;
        const an = a.resolved?.name ?? `#${a.typeId}`;
        const bn = b.resolved?.name ?? `#${b.typeId}`;
        return an.localeCompare(bn);
    });
}

function renderContent(host: HTMLElement): void {
    const slot = host.querySelector<HTMLElement>("[data-region='content']");
    if (!slot) return;
    const groups = groupContent();
    if (groups.length === 0) {
        slot.innerHTML = `<div style="color:#666;font-style:italic;padding:16px;text-align:center;border:1px dashed #333;border-radius:6px">Aucun interactif sur cette map</div>`;
        return;
    }

    const cards = groups.map((g) => {
        const name = escapeHtml(g.resolved?.name ?? `Unknown #${g.typeId}`);
        const gfxIds = g.resolved?.gfxIds ?? [];
        const gfx = gfxIds.length
            ? `<span style="color:#666;font-size:10px;margin-left:6px">[gfx ${gfxIds.slice(0, 4).join(", ")}${gfxIds.length > 4 ? ` +${gfxIds.length - 4}` : ""}]</span>`
            : "";
        const harvest = g.resolved?.skills.find((s) => s.gatheredItem);
        const harvestLine = harvest?.gatheredItem
            ? `<div style="font-size:12px;color:#facc15;margin-top:2px">→ ${escapeHtml(harvest.gatheredItem.name)}</div>`
            : "";
        const otherSkills = g.resolved?.skills.filter((s) => !s.gatheredItem).map((s) => s.name) ?? [];
        const skillsLine = otherSkills.length
            ? `<div style="font-size:11px;color:#9bd;margin-top:2px">${otherSkills.map(escapeHtml).join(" · ")}</div>`
            : "";
        const statusBadge = harvest
            ? `<span style="font-size:11px;color:${g.readyCount > 0 ? "#4ade80" : "#888"}">${g.readyCount}/${g.items.length} dispo</span>`
            : `<span style="font-size:11px;color:#888">${g.items.length}× sur la map</span>`;

        const chips = g.items.map((ix) => {
            const cellLabel = ix.cellId !== null && ix.cellId >= 0 ? String(ix.cellId) : "?";
            let bg: string, fg: string, border: string, tip: string;
            if (ix.isReady && ix.canInteract) {
                bg = "#0d3a1f"; fg = "#4ade80"; border = "#16a34a";
                tip = `cell ${ix.cellId} — dispo (clic pour utiliser)`;
            } else if (ix.isReady && !ix.canInteract) {
                bg = "#3a2a0d"; fg = "#facc15"; border = "#ca8a04";
                tip = `cell ${ix.cellId} — dispo mais skill désactivé (level/job KO)`;
            } else {
                bg = "#1a1a1a"; fg = "#666"; border = "#333";
                tip = `cell ${ix.cellId} — cooldown (state ${ix.state})`;
            }
            const disabled = !(ix.isReady && ix.canInteract);
            return `<button data-action="use" data-elementid="${ix.elementId}" ${disabled ? "disabled" : ""}
                title="${tip}"
                style="font:11px monospace;padding:2px 8px;border-radius:4px;background:${bg};color:${fg};border:1px solid ${border};cursor:${disabled ? "default" : "pointer"};min-width:32px">${cellLabel}</button>`;
        }).join("");

        return `
            <div style="background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:4px">
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
                    <strong style="color:#eee;font-size:13px">${name}${gfx}</strong>
                    ${statusBadge}
                </div>
                ${harvestLine}
                ${skillsLine}
                <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${chips}</div>
            </div>`;
    }).join("");

    slot.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">${cards}</div>`;
}

function renderAll(host: HTMLElement): void {
    renderHeader(host);
    renderRaw(host);
    redrawMinimap(host);
    renderContent(host);
}

// =============================================================================
// Mount
// =============================================================================

export async function mountState(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    // Modify individual properties (do NOT use cssText which would wipe out
    // the host's parent-applied overflow/flex styles → break scroll).
    host.style.padding = "14px 14px 60px";
    host.style.color = "#ccc";
    host.style.fontFamily = "system-ui,sans-serif";
    host.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:18px">
            <div data-region="header"></div>
            <div data-region="autopilot"></div>
            <div data-region="raw"></div>
            <div data-region="minimap">
                <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
                    <div style="background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;flex:0 0 auto">
                        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:10px;color:#666">
                            <span><span style="display:inline-block;width:10px;height:10px;background:#3a7b3a;vertical-align:middle"></span> walkable</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#fde047;vertical-align:middle"></span> map change</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#f97316;vertical-align:middle"></span> path</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#3b82f6;vertical-align:middle"></span> dispo</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#1e3a8a;vertical-align:middle"></span> cooldown</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#60a5fa;vertical-align:middle"></span> skill KO</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#facc15;vertical-align:middle"></span> moi</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#a78bfa;vertical-align:middle"></span> joueur</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#ef4444;vertical-align:middle"></span> mobs</span>
                            <span><span style="display:inline-block;width:10px;height:10px;background:#06b6d4;vertical-align:middle"></span> npc</span>
                            <span><span style="display:inline-block;width:10px;height:10px;border:2px solid #fb923c;vertical-align:middle"></span> target</span>
                        </div>
                        <div data-region="canvas-wrap" style="position:relative;align-self:flex-start">
                            <canvas style="background:#000;border:1px solid #1a1a1a;display:block"></canvas>
                            <div data-region="entity-tooltip" style="position:absolute;pointer-events:none;display:none;background:#0a0a0a;border:1px solid #444;border-radius:4px;padding:6px 10px;font-size:11px;color:#ccc;line-height:1.4;max-width:240px;z-index:5;box-shadow:0 2px 8px rgba(0,0,0,0.6)"></div>
                        </div>
                    </div>
                    <div data-region="minimap-filters" style="background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-size:12px;min-width:180px;flex:0 0 auto">
                        <div style="color:#666;text-transform:uppercase;font-size:10px;letter-spacing:1px">Filtres</div>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:#ccc">
                            <input type="checkbox" data-filter="showPlayer" checked>
                            <span style="display:inline-block;width:10px;height:10px;background:#facc15"></span>
                            <span>Mon joueur</span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:#ccc">
                            <input type="checkbox" data-filter="showEntities" checked>
                            <span style="display:inline-block;width:10px;height:10px;background:#a78bfa"></span>
                            <span>Autres entités</span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:#ccc">
                            <input type="checkbox" data-filter="onlyActionable">
                            <span style="display:inline-block;width:10px;height:10px;background:#3b82f6"></span>
                            <span>Uniquement dispo</span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:#ccc">
                            <input type="checkbox" data-filter="showPath" checked>
                            <span style="display:inline-block;width:10px;height:10px;background:#f97316"></span>
                            <span>Chemin</span>
                        </label>
                    </div>
                </div>
            </div>
            <div data-region="content"></div>
            <div data-region="world-path" style="background:#0a0a0a;border:1px solid #2a2a2a;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <strong style="color:#a78bfa;text-transform:uppercase;font-size:11px;letter-spacing:1px">Auto-travel path</strong>
                    <input data-wp="dest" type="text" inputmode="numeric" placeholder="mapId destination" style="flex:1;min-width:160px;padding:6px 10px;background:#0d0d0d;color:#ccc;border:1px solid #2a2a2a;border-radius:4px;font-family:monospace;font-size:12px">
                    <button data-wp="compute" style="padding:6px 14px;background:#1e3a8a;color:#fff;border:1px solid #2563eb;border-radius:4px;cursor:pointer;font-size:12px">Générer path</button>
                    <button data-wp="cached" style="padding:6px 14px;background:#1a1a1a;color:#9bd;border:1px solid #2a2a2a;border-radius:4px;cursor:pointer;font-size:12px">Lire cache</button>
                </div>
                <div data-wp="status" style="color:#666;font-size:11px;font-family:monospace"></div>
                <div data-wp="path" style="display:flex;flex-direction:column;gap:4px;font-size:11px;font-family:monospace"></div>
                <div style="color:#666;font-size:10px;font-style:italic">
                    "Générer" calcule un path pur via le WorldPathfinder, sans déclencher l'auto-travel ni faire bouger le perso.
                </div>
            </div>
        </div>`;

    // Bootstrap — parallel fetch, then a single full render. After this point
    // every update is driven by the two WS subscribes below.
    let lastMapId: number | null = null;
    await Promise.all([fetchPlayerState(), fetchMapState(), fetchStaticDb()]);
    if (mapState.mapId !== null) {
        await fetchMapDetail(mapState.mapId);
        lastMapId = mapState.mapId;
    }
    renderAll(host);

    // Initial autopilot fetch + render.
    void fetchTravelStatus().then(() => {
        if (!host.isConnected) return;
        renderAutopilotPanel(host);
        if (travelStatus.state === "running") startTravelPoll(host);
    });

    // Delegated click handler for autopilot buttons.
    host.addEventListener("click", async (ev) => {
        const t = ev.target as HTMLElement;
        const action = t.getAttribute?.("data-action");
        if (action === "travel-go") {
            const input = host.querySelector<HTMLInputElement>("[data-input='travel-dest']");
            const destMapId = Number(input?.value ?? "");
            if (!Number.isFinite(destMapId)) return;
            try {
                const r = await fetch("/api/dofus/travel/start", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ destMapId }),
                });
                const body = await r.json();
                if (r.ok && body?.ok) {
                    await fetchTravelStatus();
                    renderAutopilotPanel(host);
                    if (travelStatus.state === "running") startTravelPoll(host);
                } else {
                    travelStatus.state = "failed";
                    travelStatus.lastError = body?.reason ?? body?.error ?? `HTTP ${r.status}`;
                    renderAutopilotPanel(host);
                }
            } catch (e) {
                travelStatus.state = "failed";
                travelStatus.lastError = String((e as Error).message);
                renderAutopilotPanel(host);
            }
        } else if (action === "travel-cancel") {
            try { await fetch("/api/dofus/travel/cancel", { method: "POST" }); } catch {}
            await fetchTravelStatus();
            renderAutopilotPanel(host);
        }
    });

    // --- Player updates: cell/move only. Header + raw + minimap marker. ---
    const unsubPlayer = subscribe("dofus-player-state-changed", (msg: { state?: Partial<PlayerState> }) => {
        if (!host.isConnected) return;
        const s = msg?.state ?? {};
        playerState.currentCellId = s.currentCellId ?? null;
        playerState.targetCellId = s.targetCellId ?? null;
        playerState.cellPath = Array.isArray(s.cellPath) ? s.cellPath : [];
        playerState.isMoving = !!s.isMoving;
        playerState.characterId = s.characterId ?? playerState.characterId;
        renderHeader(host);
        renderRaw(host);
        redrawMinimap(host);
    });

    // --- Map updates: mapId change refetches detail + lazy DB refetch if a
    //     new typeId showed up. Same-map updates patch the live zones. ---
    const unsubMap = subscribe("dofus-map-state-changed", (msg: { state?: Partial<MapState> }) => {
        if (!host.isConnected) return;
        const s = msg?.state ?? {};
        mapState.mapId = s.mapId ?? null;
        mapState.entities = Array.isArray(s.entities) ? s.entities : [];
        mapState.interactables = Array.isArray(s.interactables) ? s.interactables : [];

        const mapChanged = mapState.mapId !== lastMapId;
        if (mapChanged) {
            lastMapId = mapState.mapId;
            currentMapDetail = null;
            renderAll(host);  // immediate paint with placeholder
            if (mapState.mapId !== null) {
                void fetchMapDetail(mapState.mapId).then(() => {
                    if (!host.isConnected) return;
                    renderHeader(host);
                    redrawMinimap(host);
                });
            }
        } else {
            renderRaw(host);
            redrawMinimap(host);
            renderContent(host);
        }

        // Self-healing DB: if any interactiveTypeId on this map is unresolved,
        // refetch once — captures types learned mid-session without a reload.
        const needsDbRefresh = mapState.interactables.some((ix) => !staticByType.has(ix.interactiveTypeId));
        if (needsDbRefresh) {
            void fetchStaticDb().then(() => {
                if (!host.isConnected) return;
                renderContent(host);
            });
        }
    });

    // --- Minimap hover tooltip — hit-test against entity discs (~8px radius) ---
    void ensureMonsterCatalog();  // warm the cache for tooltip name resolution
    const wrap = host.querySelector<HTMLElement>("[data-region='canvas-wrap']");
    const canvas = wrap?.querySelector<HTMLCanvasElement>("canvas");
    const tooltip = host.querySelector<HTMLElement>("[data-region='entity-tooltip']");
    if (wrap && canvas && tooltip) {
        const entityAtPixel = (px: number, py: number): MapEntitySnapshot | null => {
            if (!minimapFilters.showEntities) return null;
            const rect = canvas.getBoundingClientRect();
            const cx = px * (canvas.width / rect.width);
            const cy = py * (canvas.height / rect.height);
            for (const e of mapState.entities) {
                if (e.cellId === null || e.cellId < 0 || e.cellId >= COLS * ROWS) continue;
                if (playerState.characterId !== null && e.entityId === playerState.characterId) continue;
                const c = cellCenter(e.cellId);
                const dx = cx - c.cx, dy = cy - c.cy;
                if (dx * dx + dy * dy <= 64) return e;  // 8px disc
            }
            return null;
        };

        const renderTooltip = (e: MapEntitySnapshot): string => {
            if (e.kind === "player") {
                const lvl = e.level !== null ? ` <span style="color:#888">lvl ${e.level}</span>` : "";
                return `<strong style="color:#a78bfa">${escapeHtml(e.name ?? "Joueur")}</strong>${lvl}<br><span style="color:#666;font-size:10px">cell ${e.cellId} · id ${e.entityId}</span>`;
            }
            if (e.kind === "monsterGroup") {
                const ms = e.monsters ?? [];
                const lines = ms.map((m) => {
                    const name = monsterNameById?.get(m.monsterId) ?? `#${m.monsterId}`;
                    return `<div>${escapeHtml(name)} <span style="color:#888">(${m.level})</span></div>`;
                }).join("");
                return `<strong style="color:#ef4444">Groupe — ${ms.length} mob${ms.length > 1 ? "s" : ""}</strong>${lines}<div style="color:#666;font-size:10px;margin-top:3px">cell ${e.cellId}</div>`;
            }
            if (e.kind === "npc") {
                return `<strong style="color:#06b6d4">NPC</strong> <code style="color:#9bd">#${e.npcId ?? "?"}</code><br><span style="color:#666;font-size:10px">cell ${e.cellId}</span>`;
            }
            return `<strong style="color:#6b7280">Entity</strong><br><span style="color:#666;font-size:10px">cell ${e.cellId} · id ${e.entityId}</span>`;
        };

        const positionTooltip = (mx: number, my: number): void => {
            // Show first to measure, then clamp.
            const cw = canvas.clientWidth;
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            let x = mx + 14;
            let y = my + 14;
            if (x + tw > cw) x = Math.max(0, mx - tw - 8);
            if (y + th > canvas.clientHeight) y = Math.max(0, my - th - 8);
            tooltip.style.left = `${x}px`;
            tooltip.style.top = `${y}px`;
        };

        canvas.addEventListener("mousemove", (ev) => {
            const rect = canvas.getBoundingClientRect();
            const mx = ev.clientX - rect.left;
            const my = ev.clientY - rect.top;
            const hit = entityAtPixel(mx, my);
            if (!hit) { tooltip.style.display = "none"; return; }
            tooltip.innerHTML = renderTooltip(hit);
            tooltip.style.display = "block";
            positionTooltip(mx, my);
        });
        canvas.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
    }

    // --- World pathfinding panel (Auto-travel) ---
    interface PathTransition { cellId: number; direction: number; skillId: number; transitionMapId: string; type: number; criterion: string | null; id: string }
    interface PathVertex { mapId: string; zoneId: number; uid: string }
    interface PathEdge { from: PathVertex; to: PathVertex; transitions: PathTransition[] }
    interface PathResponse { ok: boolean; reason?: string; edges?: PathEdge[]; destMapId?: string; state?: number; startVertex?: PathVertex | null; fresh?: boolean }

    const wpStatus = host.querySelector<HTMLElement>("[data-wp='status']");
    const wpPath = host.querySelector<HTMLElement>("[data-wp='path']");
    const wpInput = host.querySelector<HTMLInputElement>("[data-wp='dest']");
    const wpCompute = host.querySelector<HTMLButtonElement>("[data-wp='compute']");
    const wpCached = host.querySelector<HTMLButtonElement>("[data-wp='cached']");

    function renderWorldPath(r: PathResponse): void {
        if (!wpStatus || !wpPath) return;
        if (!r.ok) {
            wpStatus.style.color = "#f87171";
            wpStatus.textContent = `Erreur : ${r.reason ?? "unknown"}`;
            wpPath.innerHTML = "";
            return;
        }
        const edges = r.edges ?? [];
        const startLine = r.startVertex ? ` · start ${r.startVertex.mapId}` : "";
        const destLine = r.destMapId ? ` · dest ${r.destMapId}` : "";
        const stateLine = r.state !== undefined ? ` · state=${r.state}` : "";
        wpStatus.style.color = edges.length > 0 ? "#4ade80" : "#888";
        wpStatus.textContent = `${edges.length} hop${edges.length > 1 ? "s" : ""}${r.fresh ? " (fresh)" : ""}${startLine}${destLine}${stateLine}`;
        wpPath.innerHTML = edges.length === 0
            ? `<span style="color:#666;font-style:italic">— pas de path en cache —</span>`
            : edges.map((e, i) => {
                const tr = e.transitions[0];
                const cellLabel = tr ? `cell <code style="color:#facc15">${tr.cellId}</code>` : "(no transition)";
                const typeBadge = tr ? `<span style="color:#666">type ${tr.type}${tr.skillId !== -1 ? `, skill ${tr.skillId}` : ""}</span>` : "";
                return `<div style="display:flex;gap:8px;align-items:baseline;padding:3px 0;border-top:${i === 0 ? "0" : "1px"} solid #1a1a1a">
                    <span style="color:#666;flex:0 0 24px">${i + 1}.</span>
                    <code style="color:#9bd">${e.from.mapId}</code>
                    <span style="color:#666">→</span>
                    <code style="color:#9bd">${e.to.mapId}</code>
                    <span style="flex:1">${cellLabel}</span>
                    ${typeBadge}
                </div>`;
            }).join("");
    }

    async function fetchCachedPath(): Promise<void> {
        if (!wpStatus) return;
        wpStatus.style.color = "#888";
        wpStatus.textContent = "Lecture cache…";
        try {
            const r = await fetch("/api/dofus/world-pathfinding/cached");
            const data = await r.json() as PathResponse;
            renderWorldPath(data);
        } catch (e) {
            wpStatus.style.color = "#f87171";
            wpStatus.textContent = `Erreur : ${String(e)}`;
        }
    }

    async function computePath(destMapId: string): Promise<void> {
        if (!wpStatus) return;
        wpStatus.style.color = "#888";
        wpStatus.textContent = `Génération vers ${destMapId}…`;
        try {
            const r = await fetch("/api/dofus/world-pathfinding/compute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ destMapId, timeoutMs: 5000 }),
            });
            const data = await r.json() as PathResponse;
            renderWorldPath(data);
        } catch (e) {
            wpStatus.style.color = "#f87171";
            wpStatus.textContent = `Erreur : ${String(e)}`;
        }
    }

    wpCached?.addEventListener("click", () => { void fetchCachedPath(); });
    wpCompute?.addEventListener("click", () => {
        const v = wpInput?.value.trim() ?? "";
        if (!/^\d+$/.test(v)) {
            if (wpStatus) { wpStatus.style.color = "#f87171"; wpStatus.textContent = "mapId numérique requis"; }
            return;
        }
        void computePath(v);
    });
    wpInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") wpCompute?.click();
    });
    // Init the hooks (idempotent) so the callback gets captured on next
    // game-triggered auto-travel even if the user doesn't click "Générer" first.
    void fetch("/api/dofus/world-pathfinding/init", { method: "POST" }).catch(() => {});
    // Auto-fetch cached path on mount.
    void fetchCachedPath();

    // --- Minimap filter toggles ---
    host.addEventListener("change", (e) => {
        const cb = (e.target as HTMLElement | null)?.closest?.<HTMLInputElement>("input[type='checkbox'][data-filter]");
        if (!cb) return;
        const key = cb.dataset.filter as keyof MinimapFilters | undefined;
        if (!key || !(key in minimapFilters)) return;
        minimapFilters[key] = cb.checked;
        redrawMinimap(host);
    });

    // --- Delegated click handlers: copy buttons + interactable "use". ---
    host.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;

        const copyBtn = target.closest?.<HTMLButtonElement>("button[data-copy]");
        if (copyBtn) {
            e.preventDefault();  // don't toggle the <details>
            const which = copyBtn.dataset.copy;
            const payload = which === "player" ? playerState : which === "map" ? mapState : null;
            if (payload === null) return;
            void navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
                const orig = copyBtn.textContent ?? "Copy";
                copyBtn.textContent = "Copied";
                setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = orig; }, 900);
            }).catch(() => {
                copyBtn.textContent = "Err";
                setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = "Copy"; }, 900);
            });
            return;
        }

        const useBtn = target.closest?.<HTMLButtonElement>("button[data-action='use']");
        if (!useBtn || useBtn.disabled) return;
        const elementId = Number(useBtn.dataset.elementid);
        if (!Number.isFinite(elementId)) return;
        const orig = useBtn.textContent ?? "";
        useBtn.disabled = true;
        useBtn.textContent = "…";
        void (async () => {
            try {
                const r = await fetch("/api/dofus/interactive/use", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ elementId }),
                });
                const data = await r.json().catch(() => ({}));
                if (data.ok) {
                    useBtn.textContent = "✓";
                    useBtn.title = `Sent: ${data.skillName ?? "skill"} (uid=${data.skillInstanceUid})`;
                } else {
                    useBtn.textContent = "✗";
                    useBtn.title = `Failed: ${data.reason ?? data.error ?? "unknown"}`;
                    setTimeout(() => {
                        if (!host.isConnected) return;
                        useBtn.textContent = orig;
                        useBtn.disabled = false;
                    }, 1500);
                }
            } catch (err) {
                useBtn.textContent = "✗";
                useBtn.title = `Error: ${String(err)}`;
                setTimeout(() => {
                    if (!host.isConnected) return;
                    useBtn.textContent = orig;
                    useBtn.disabled = false;
                }, 1500);
            }
        })();
    });

    // Silence "unused" for the WS unsubs: they're owned by the page lifetime
    // and the WS client cleans up when the underlying socket closes.
    void unsubPlayer; void unsubMap;
}
