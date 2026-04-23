// Map panel — renders the current Dofus map as a staggered diamond grid with
// walkability, special cells, arrows, and a live actor overlay fed by socket
// capture (irl = moves, jnc = removals, iri = our own destination).
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";
import { onWsEvent } from "../lib/ws.js";

interface MapCell {
    id: number; mov: boolean; los: boolean; speed: number; floor: number; arrow: number;
    red: boolean; blue: boolean; mapChangeData: number;
    nonWalkableRp: boolean; nonWalkableFight: boolean;
    farmCell: boolean; visible: boolean; havenbagCell: boolean;
}
interface MapState {
    mapId: number; posX: number; posY: number; subAreaId: number; worldMap: number; nameId: number;
    name?: string;
    neighbors: { top: number; bottom: number; left: number; right: number };
    arrowCells: { top: number[]; bottom: number[]; left: number[]; right: number[] };
    cells: MapCell[];
}

interface Actor {
    id: string;              // Int64 as string
    cell: number;
    lastSeen: number;        // Date.now()
    kind: "self" | "monster" | "npc" | "player" | "resource" | "other";
    kindEnum?: string;       // raw Ankama uk flags (for debugging / tooltip)
    name?: string;           // localized name when we can resolve it (resources mostly)
    group?: MonsterGroupInfo; // attached when this actor is a monster group with full info
}

interface Interactive {
    elementId: string;
    cell: number;
    typeId: number;
    name: string;
}

interface MonsterEntry { level: number; monsterId: number; monsterName: string; grade: number; }
interface MonsterGroupInfo {
    actorId: string;
    cellId: number;
    leader: MonsterEntry | null;
    underlings: MonsterEntry[];
    totalLevel: number;
    totalCount: number;
    alignmentSide: number;
}

interface ActorSnapshot {
    id: string;
    cell: number;
    speed: number;
    kindEnum: string;
    kindDefCls: string;
}

/**
 * Map Ankama's `uk` flag-enum (as comma-separated member names) to a semantic
 * kind. Deduced empirically by observing a live sample + cross-checking with
 * in-game types reported by the user:
 *   czrr — attackable target (monsters; present on the player entity too)
 *   czrw — harvestable resource (Ortie, Menthe, Frêne, …)
 *   czrx — NPCs with -99xxx ids (quest-givers, merchants)
 *   czsd — "local self" marker (ONLY on the current player's own entity)
 *   czsf — "any player character" (local self AND other human players)
 *   czrs, czsg — rare singletons (archmonsters, named quest triggers)
 */
function classifyKind(kindEnum: string): Actor["kind"] {
    const flags = new Set(kindEnum.split(",").map(s => s.trim()));
    if (flags.has("czsd")) return "self";           // local player only
    if (flags.has("czsf")) return "player";         // other human players
    if (flags.has("czrw")) return "resource";
    if (flags.has("czrx")) return "npc";
    if (flags.has("czrr") || flags.has("czrs") || flags.has("czsg")) return "monster";
    return "other";
}

const CELL_W = 40;
const CELL_H = 20;
const GRID_COLS = 14;
// Dofus grid uses the 14-wide staggered pattern; row count = floor(560 / 14) = 40 but really it's an
// alternating "0..13 = top-half" / "14..27 = bottom-half shifted" pattern — so we compute row from id/14.

const COLOR = {
    wall:    "#1f1f1f",
    floor:   "#3a6a3a",  // walkable
    floorAlt:"#2f5e2f",  // walkable, lower tint to show chessboard alternation
    los:     "#4a4a2f",  // non-walkable but LoS allowed (low obstacle)
    red:     "#b94141",
    blue:    "#3f74c2",
    farm:    "#886a1e",
    havenbag:"#88328a",
    arrow:   "#e0b238",
    nwFight: "#5a1f1f",
    grid:    "#0d0d0d",
    selfActor:   "#f4e05a",
    playerActor: "#5ad7f4",
    monsterActor:"#eb4a7c",
    npcActor:    "#b480f0",
    resourceActor:"#6ad16a",  // green — harvestables (Menthe, Ortie, Frêne, …)
};

function cellCenter(id: number): [number, number] {
    const row = Math.floor(id / GRID_COLS);
    const col = id % GRID_COLS;
    const cx = col * CELL_W + ((row & 1) ? CELL_W / 2 : 0) + CELL_W / 2;
    const cy = row * (CELL_H / 2) + CELL_H / 2;
    return [cx, cy];
}

function colorFor(c: MapCell): string {
    if (c.red)   return COLOR.red;
    if (c.blue)  return COLOR.blue;
    if (c.farmCell)     return COLOR.farm;
    if (c.havenbagCell) return COLOR.havenbag;
    if (!c.mov) {
        if (c.nonWalkableFight) return COLOR.nwFight;
        if (c.los) return COLOR.los;
        return COLOR.wall;
    }
    // Walkable — alternate tint per chessboard for readability.
    const row = Math.floor(c.id / GRID_COLS);
    const col = c.id % GRID_COLS;
    return ((row + col) & 1) ? COLOR.floor : COLOR.floorAlt;
}

function drawDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, fill: string, stroke: string = COLOR.grid): void {
    const hw = CELL_W / 2, hh = CELL_H / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.5;
    ctx.stroke();
}

function drawActor(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string, label: string): void {
    ctx.beginPath();
    ctx.arc(cx, cy - 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (label) {
        ctx.font = "9px monospace";
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(label, cx, cy - 9);
    }
}

function parsePathLastCell(summary: unknown): number | null {
    // "[N] a, b, c, ..." — return last numeric entry as integer
    if (typeof summary !== "string") return null;
    const m = summary.match(/\[\d+\]\s*(.*)$/);
    if (!m) return null;
    const parts = m[1].split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const last = parts[parts.length - 1].replace(/\+\d+/, "").trim();
    const n = parseInt(last, 10);
    return Number.isFinite(n) ? n : null;
}

function decompressCell(v: number): number {
    // iri.efdn uses (dir << 12) | cellId encoding. irl.efeh uses raw cell.
    // If value looks compressed (> 560 typical max), unmask low 12 bits.
    return v > 559 ? (v & 0xfff) : v;
}

function parseInt64(s: unknown): string | null {
    if (typeof s !== "string") return null;
    const t = s.trim().replace(/^"|"$/g, "");
    if (!/^-?\d+$/.test(t)) return null;
    return t;
}

function parseIntField(s: unknown): number | null {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (!/^-?\d+$/.test(t)) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
}

export function renderMap(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; gap:var(--s-3); padding:var(--s-3); height:100%; box-sizing:border-box">
        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:var(--s-2)">
          <div style="display:flex; gap:var(--s-2); align-items:center; flex-wrap:wrap">
            <button id="mp-refresh" class="btn primary">↻ REFRESH</button>
            <button id="mp-clear-actors" class="btn" title="Clear the actor overlay">clear actors</button>
            <span style="color:var(--c-label); font-size:10px; margin-left:var(--s-2)">trace:</span>
            <button id="mp-arm-bt" class="btn" title="Install ecu.xbe hook with IL2CPP backtrace on iri/isu/isp/jmw/isl">ARM BT</button>
            <button id="mp-dump-bt" class="btn" title="Dump captured backtraces to the log">DUMP BT</button>
            <button id="mp-scan-arrow" class="btn" title="Scan IL2CPP classes for Arrow/Border/Direction candidates">SCAN ARROW</button>
            <span style="color:var(--c-label); font-size:10px; margin-left:var(--s-2)">auto-travel:</span>
            <input id="mp-travel-x" type="number" placeholder="x" style="width:50px; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px" title="Target posX">
            <input id="mp-travel-y" type="number" placeholder="y" style="width:50px; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px" title="Target posY">
            <button id="mp-travel-go" class="btn" title="Compute shortest world path and auto-navigate">GO</button>
            <button id="mp-travel-stop" class="btn" title="Cancel the current travel" style="display:none">STOP</button>
            <span id="mp-header" style="font-size:12px; color:var(--c-label)">not loaded</span>
          </div>
          <div style="display:flex; gap:var(--s-2); align-items:center; font-size:10px; color:var(--c-label); flex-wrap:wrap">
            <span>walkable</span><span style="background:${COLOR.floor}; padding:1px 6px">■</span>
            <span>wall</span><span style="background:${COLOR.wall}; padding:1px 6px; color:#fff">■</span>
            <span>low-obst (los)</span><span style="background:${COLOR.los}; padding:1px 6px">■</span>
            <span>fight-blocked</span><span style="background:${COLOR.nwFight}; padding:1px 6px">■</span>
            <span>farm</span><span style="background:${COLOR.farm}; padding:1px 6px">■</span>
            <span>red spawn</span><span style="background:${COLOR.red}; padding:1px 6px">■</span>
            <span>blue spawn</span><span style="background:${COLOR.blue}; padding:1px 6px">■</span>
            <span>arrow cell</span><span style="color:${COLOR.arrow}">▲</span>
            <span>me</span><span style="color:${COLOR.selfActor}">●</span>
            <span>players</span><span style="color:${COLOR.playerActor}">●</span>
            <span>monsters</span><span style="color:${COLOR.monsterActor}">●</span>
            <span>npcs</span><span style="color:${COLOR.npcActor}">●</span>
            <span>resources</span><span style="color:${COLOR.resourceActor}">●</span>
          </div>
          <canvas id="mp-canvas" style="background:#0a0a0a; border:1px solid #222; image-rendering:pixelated"></canvas>
        </div>
        <aside style="width:280px; flex-shrink:0; display:flex; flex-direction:column; gap:var(--s-2); font-size:11px">
          <div class="section-header">selected cell</div>
          <div id="mp-cell-info" style="background:#111; border:1px solid #222; padding:var(--s-2); min-height:60px">click a cell</div>
          <div class="section-header">neighbors</div>
          <div id="mp-neighbors" style="background:#111; border:1px solid #222; padding:var(--s-2)">—</div>
          <div class="section-header">actors on map (<span id="mp-actor-count">0</span>)</div>
          <div id="mp-actors" style="background:#111; border:1px solid #222; padding:var(--s-2); flex:1; min-height:80px; max-height:280px; overflow:auto; font-family:var(--font-mono)">—</div>
        </aside>
      </div>
    `;

    const canvas = container.querySelector<HTMLCanvasElement>("#mp-canvas")!;
    const ctx = canvas.getContext("2d")!;
    const headerEl = container.querySelector<HTMLElement>("#mp-header")!;
    const cellInfoEl = container.querySelector<HTMLElement>("#mp-cell-info")!;
    const neighborsEl = container.querySelector<HTMLElement>("#mp-neighbors")!;
    const actorsEl = container.querySelector<HTMLElement>("#mp-actors")!;
    const actorCountEl = container.querySelector<HTMLElement>("#mp-actor-count")!;
    const refreshBtn = container.querySelector<HTMLButtonElement>("#mp-refresh")!;
    const clearActorsBtn = container.querySelector<HTMLButtonElement>("#mp-clear-actors")!;

    let state: MapState | null = null;
    let selectedCell = -1;
    let selfCell = -1;
    let meActorId: string | null = null;
    // After we send iri, remember (dest cell, ts). The next irl within the window
    // whose destination cell matches is almost certainly ours — we snag its actorId.
    let pendingSelfMove: { cell: number; ts: number } | null = null;
    const SELF_MATCH_WINDOW_MS = 4000;
    const actors = new Map<string, Actor>();

    function canvasSize(): void {
        const row = 40; // max rows we'll ever see
        canvas.width  = GRID_COLS * CELL_W + CELL_W / 2 + 2;
        canvas.height = row * (CELL_H / 2) + CELL_H / 2 + 2;
    }

    function render(): void {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!state) return;
        // Cells
        for (const c of state.cells) {
            const [cx, cy] = cellCenter(c.id);
            drawDiamond(ctx, cx, cy, colorFor(c));
            if (c.arrow !== 0) {
                // Arrow marker as a small triangle overlay
                ctx.fillStyle = COLOR.arrow;
                ctx.beginPath();
                ctx.moveTo(cx - 3, cy + 3);
                ctx.lineTo(cx + 3, cy + 3);
                ctx.lineTo(cx,     cy - 4);
                ctx.closePath();
                ctx.fill();
            }
        }
        // Selection outline
        if (selectedCell >= 0 && selectedCell < state.cells.length) {
            const [cx, cy] = cellCenter(selectedCell);
            drawDiamond(ctx, cx, cy, "transparent", "#fff");
            ctx.lineWidth = 1;
        }
        // Self actor
        if (selfCell >= 0 && selfCell < state.cells.length) {
            const [cx, cy] = cellCenter(selfCell);
            drawActor(ctx, cx, cy, COLOR.selfActor, "me");
        }
        // Other actors
        for (const a of actors.values()) {
            if (a.cell < 0 || a.cell >= state.cells.length) continue;
            const [cx, cy] = cellCenter(a.cell);
            const color = a.kind === "player" ? COLOR.playerActor
                        : a.kind === "npc"     ? COLOR.npcActor
                        : a.kind === "resource"? COLOR.resourceActor
                        : a.kind === "monster" ? COLOR.monsterActor
                        : COLOR.monsterActor;
            // Prefer group level (e.g. "Nv 94") for monster groups, then resource name,
            // else last 4 digits of actorId as a fallback identifier.
            const label = a.group ? `Nv ${a.group.totalLevel}` : (a.name ?? a.id.slice(-4));
            drawActor(ctx, cx, cy, color, label);
        }
    }

    function updateHeader(): void {
        if (!state) { headerEl.textContent = "not loaded"; return; }
        const walkable = state.cells.filter(c => c.mov).length;
        headerEl.innerHTML = `<b>${state.mapId}</b> ${state.name ? "— " + state.name : ""} · world (${state.posX}, ${state.posY}) · subArea ${state.subAreaId} · ${walkable}/${state.cells.length} walkable`;
    }

    function updateNeighbors(): void {
        if (!state) { neighborsEl.textContent = "—"; return; }
        const fmt = (id: number) => id && id > 0 ? String(id) : "<i>none</i>";
        neighborsEl.innerHTML = `
          <div style="text-align:center">↑ ${fmt(state.neighbors.top)}</div>
          <div style="display:flex; justify-content:space-between">
            <span>← ${fmt(state.neighbors.left)}</span>
            <span>${fmt(state.neighbors.right)} →</span>
          </div>
          <div style="text-align:center">↓ ${fmt(state.neighbors.bottom)}</div>
        `;
    }

    function updateActorList(): void {
        actorCountEl.textContent = String(actors.size + (selfCell >= 0 ? 1 : 0));
        const rows: string[] = [];
        if (selfCell >= 0) rows.push(`<div style="color:${COLOR.selfActor}">● me → cell ${selfCell}</div>`);
        const now = Date.now();
        const list = [...actors.values()].sort((a, b) => {
            // Group by kind, then by cell
            const order: Record<string, number> = { monster: 0, resource: 1, npc: 2, player: 3, other: 4, self: -1 };
            const ka = order[a.kind] ?? 5, kb = order[b.kind] ?? 5;
            if (ka !== kb) return ka - kb;
            return a.cell - b.cell;
        });
        for (const a of list) {
            const color = a.kind === "player" ? COLOR.playerActor
                        : a.kind === "npc"     ? COLOR.npcActor
                        : a.kind === "resource"? COLOR.resourceActor
                        : COLOR.monsterActor;
            const age = ((now - a.lastSeen) / 1000).toFixed(0);
            let label = a.name ? `<b>${escHtml(a.name)}</b>` : escHtml(a.id);
            let extra = "";
            if (a.group) {
                // Build a tooltip-style composition line: "Niveau 94 · 5 mobs: Larve Jaune(20), …"
                const comp: MonsterEntry[] = [];
                if (a.group.leader) comp.push(a.group.leader);
                for (const u of a.group.underlings) comp.push(u);
                const mobs = comp.map(m => `${m.monsterName || `id${m.monsterId}`}(${m.level})`).join(", ");
                label = `<b>Niveau ${a.group.totalLevel}</b>`;
                extra = `<div style="font-size:9px; color:var(--c-label); padding-left:12px">${a.group.totalCount} mobs: ${escHtml(mobs)}</div>`;
            }
            rows.push(`<div><span style="color:${color}">●</span> <span style="color:var(--c-label)">${a.kind}</span> ${label} · cell ${a.cell} · ${age}s${extra}</div>`);
        }
        actorsEl.innerHTML = rows.length ? rows.join("") : "—";
    }

    function updateCellInfo(): void {
        if (!state || selectedCell < 0) { cellInfoEl.textContent = "click a cell"; return; }
        const c = state.cells[selectedCell];
        if (!c) { cellInfoEl.textContent = "cell out of range"; return; }
        const flags: string[] = [];
        if (c.mov) flags.push("walkable"); else flags.push("wall");
        if (c.los) flags.push("los");
        if (c.red) flags.push("red-spawn");
        if (c.blue) flags.push("blue-spawn");
        if (c.farmCell) flags.push("farm");
        if (c.havenbagCell) flags.push("havenbag");
        if (c.nonWalkableFight) flags.push("nw-fight");
        if (c.nonWalkableRp) flags.push("nw-rp");
        if (!c.visible) flags.push("invisible");
        if (c.arrow) flags.push(`arrow=${c.arrow}`);
        if (c.mapChangeData) flags.push(`mcd=0x${c.mapChangeData.toString(16)}`);
        // Any actor on this cell? If it's a group, render the full composition.
        let actorHtml = "";
        for (const a of actors.values()) {
            if (a.cell !== selectedCell) continue;
            if (a.group) {
                const list = [a.group.leader, ...a.group.underlings].filter(Boolean) as MonsterEntry[];
                const rows = list.map(m => `<div style="padding-left:8px">· ${escHtml(m.monsterName || `id${m.monsterId}`)} (${m.level})</div>`).join("");
                actorHtml += `
                  <div style="margin-top:6px; padding:var(--s-2); background:#0b0b0b; border:1px solid var(--c-line)">
                    <b>Niveau ${a.group.totalLevel}</b> — ${a.group.totalCount} mobs
                    ${rows}
                  </div>
                `;
            } else if (a.name) {
                actorHtml += `<div style="margin-top:6px; color:var(--c-label)">${a.kind}: <b>${escHtml(a.name)}</b></div>`;
            } else {
                actorHtml += `<div style="margin-top:6px; color:var(--c-label)">${a.kind}: ${escHtml(a.id)}</div>`;
            }
        }
        cellInfoEl.innerHTML = `
          <b>cell ${c.id}</b> (floor ${c.floor}, speed ${c.speed})<br>
          <span style="color:var(--c-label)">${flags.join(" · ") || "—"}</span>
          ${actorHtml}
        `;
    }

    async function loadState(): Promise<void> {
        refreshBtn.disabled = true;
        try {
            const r = await rpcCall<MapState | null>("getMapState", []);
            if (!r) { headerEl.textContent = "getMapState returned null — are you on a map?"; return; }
            // If mapId changed, drop the tracker (actors belong to the old map).
            if (state && state.mapId !== r.mapId) { actors.clear(); selfCell = -1; }
            state = r;
            canvasSize();
            updateHeader();
            updateNeighbors();
            updateCellInfo();

            // Bulk snapshot from the runtime entity store — fills in everyone currently
            // rendered, not just those that have moved since we opened the panel.
            // In parallel, pull the interactive-elements catalogue so we can label
            // resources by name (Ortie, Menthe Sauvage, …) instead of raw actorId.
            // And the monster-group cache (populated from last iso) for tooltips.
            try {
                const [snap, interactives, groups] = await Promise.all([
                    rpcCall<ActorSnapshot[]>("listActorsOnMap", []),
                    rpcCall<Interactive[]>("getInteractivesOnMap", []).catch(() => [] as Interactive[]),
                    rpcCall<MonsterGroupInfo[]>("getMonsterGroupsOnMap", []).catch(() => [] as MonsterGroupInfo[]),
                ]);
                const nameByElementId = new Map<string, string>();
                for (const it of interactives) if (it.name) nameByElementId.set(it.elementId, it.name);
                const groupByActorId = new Map<string, MonsterGroupInfo>();
                for (const g of groups) groupByActorId.set(g.actorId, g);

                // Rebuild the actors map from scratch to drop stale entries.
                actors.clear();
                // Dedupe by actorId: the same actor can appear twice (stale cached Entity + live).
                // Prefer the richer kindEnum (more flags = more info).
                const byId = new Map<string, ActorSnapshot>();
                for (const a of snap) {
                    const prev = byId.get(a.id);
                    if (!prev || a.kindEnum.length > prev.kindEnum.length) byId.set(a.id, a);
                }
                for (const a of byId.values()) {
                    if (a.cell < 0 || a.cell >= r.cells.length) continue;
                    const kind = classifyKind(a.kindEnum);
                    if (kind === "self") {
                        selfCell = a.cell;
                        if (!meActorId) meActorId = a.id;
                        continue;
                    }
                    if (meActorId && a.id === meActorId) { selfCell = a.cell; continue; }
                    const name = nameByElementId.get(a.id);
                    const group = groupByActorId.get(a.id);
                    // If this actor is confirmed as a monster group in the iso cache, force
                    // "monster" kind regardless of uk-flag classification (the uk flag enum
                    // isn't reliable — same-type larva groups show with different flags).
                    const finalKind: Actor["kind"] = group ? "monster" : kind;
                    actors.set(a.id, { id: a.id, cell: a.cell, lastSeen: Date.now(), kind: finalKind, kindEnum: a.kindEnum, name, group });
                }
            } catch (err) {
                logRpcLine(`[map] listActorsOnMap failed: ${String(err)}`);
            }

            updateActorList();
            render();
        } catch (err) {
            logRpcLine(`[map] getMapState failed: ${String(err)}`);
            headerEl.textContent = `error: ${String(err)}`;
        } finally {
            refreshBtn.disabled = false;
        }
    }

    canvas.addEventListener("click", (e) => {
        if (!state) return;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (canvas.width / rect.width);
        const y = (e.clientY - rect.top)  * (canvas.height / rect.height);
        // Find closest cell by center distance (cheap for 560 cells).
        let best = -1, bestD2 = Infinity;
        for (const c of state.cells) {
            const [cx, cy] = cellCenter(c.id);
            const dx = x - cx, dy = y - cy;
            const d2 = dx * dx + dy * dy * 4;  // y-weighted because diamonds are squat
            if (d2 < bestD2) { bestD2 = d2; best = c.id; }
        }
        selectedCell = best;
        updateCellInfo();
        render();
    });

    refreshBtn.addEventListener("click", () => { travelActive = false; void loadState(); });

    // Install the ecu.xbe hook once per session so outgoing socket events
    // reach the map panel (jmw → auto-reload map state). Also primes the
    // map-coord index (~0 cost when autotravel doesn't need it, but the
    // travel button uses it to resolve (x,y) → mapId instantly).
    let hookInstalled = false;
    async function ensureHook(): Promise<void> {
        if (hookInstalled) return;
        try {
            await rpcCall<any>("installOutgoingHook", [[]]);
            hookInstalled = true;
            rpcCall<any>("primeMapCoordIndex", []).catch(() => null);
        } catch { /* ignore */ }
    }

    // Backtrace capture: arm the ecu.xbe hook filtered on the 5-message cascade
    // that a manual arrow click emits. After arming, the user does a MANUAL
    // arrow click in-game; each of iri/isu/isp/jmw/isl captures its call stack
    // resolved via the IL2CPP method-address table. DUMP BT pulls them back
    // and prints into the log.
    const ARROW_CASCADE_CLASSES = ["iri", "isu", "isp", "jmw", "isl"];
    container.querySelector<HTMLButtonElement>("#mp-arm-bt")!.addEventListener("click", async () => {
        try {
            const r = await rpcCall<any>("installOutgoingHook", [ARROW_CASCADE_CLASSES]);
            if (r?.ok) {
                await rpcCall<number>("clearOutgoingStacks", []).catch(() => 0);
                logRpcLine(`[map] backtrace armed on [${r.traced.join(",")}] (IL2CPP table ${r.tableSize} methods) — now click a border arrow manually in-game, then DUMP BT`);
            } else {
                logRpcLine(`[map] installOutgoingHook failed: ${JSON.stringify(r)}`);
            }
        } catch (err) {
            logRpcLine(`[map] installOutgoingHook threw: ${String(err)}`);
        }
    });
    // Auto-travel: (x, y) → plan world path → iterate hops.
    // Each hop waits for the `loadState()` that fires on jmw (see the WS
    // subscriber below) so we don't blast multiple requests at the server.
    const travelGoBtn = container.querySelector<HTMLButtonElement>("#mp-travel-go")!;
    const travelStopBtn = container.querySelector<HTMLButtonElement>("#mp-travel-stop")!;
    travelStopBtn.style.display = "none";
    // Suspend UI's heavy reload (listActors + interactives + monsterGroups,
    // 3 gc.choose heap walks per jmw) while the game's native autopilot is
    // running, otherwise our RPCs throttle its VM thread between hops. Flag
    // is set when GO is pressed and expires after 2 min OR on manual refresh.
    let travelActive = false;
    let travelDeadline = 0;
    let currentTravelTarget: string | null = null;
    function isTraveling(): boolean { return travelActive && Date.now() < travelDeadline; }
    travelGoBtn.addEventListener("click", async () => {
        const targetX = parseInt(container.querySelector<HTMLInputElement>("#mp-travel-x")!.value, 10);
        const targetY = parseInt(container.querySelector<HTMLInputElement>("#mp-travel-y")!.value, 10);
        if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) { logRpcLine(`[travel] invalid x/y`); return; }
        travelActive = true;
        travelDeadline = Date.now() + 120_000;
        try {
            // Resolve (x,y) → mapId, then arm. User must click on the in-game
            // worldmap to actually fire (hook picks up the click on main thread).
            if (!state) { logRpcLine(`[travel] state not loaded`); travelActive = false; return; }
            const lookup = await rpcCall<any>("findMapIdByCoords", [targetX, targetY, state.worldMap]);
            if (!lookup?.best) { logRpcLine(`[travel] no map at (${targetX},${targetY})`); travelActive = false; return; }
            currentTravelTarget = String(lookup.best.mapId);
            const r = await rpcCall<any>("autoTravelInstant", [lookup.best.mapId]);
            if (!r?.ok) { logRpcLine(`[travel] failed: ${r?.reason}`); travelActive = false; currentTravelTarget = null; return; }
            logRpcLine(`[travel] → mapId=${lookup.best.mapId}`);
            // Arrival is detected by the jmw WS handler below — no polling.
        } catch (e) {
            logRpcLine(`[travel] threw: ${String(e)}`);
            travelActive = false;
        }
    });

    container.querySelector<HTMLButtonElement>("#mp-scan-arrow")!.addEventListener("click", async () => {
        try {
            const r = await rpcCall<{ matched: Array<{ cls: string; ns: string; parent: string;
                methods: Array<{ name: string; isStatic: boolean; params: string[]; ret: string }>;
                fields: Array<{ name: string; type: string; isStatic: boolean }>;
            }> }>("scanArrowCandidates", []);
            const all = r.matched;
            if (!all.length) { logRpcLine(`[map] no arrow candidates found`); return; }
            logRpcLine(`[scan] === ${all.length} arrow-related classes ===`);
            for (const c of all) {
                logRpcLine(`[scan] ${c.cls}  (ns="${c.ns}", parent=${c.parent}) — ${c.methods.length}m/${c.fields.length}f`);
                // Highlight click/tap/press/interact/trigger methods specifically.
                const CLICK_KW = ["click", "press", "tap", "select", "activate", "interact", "trigger", "touch", "pointer"];
                const clickish = c.methods.filter(m => {
                    const low = m.name.toLowerCase();
                    return CLICK_KW.some(k => low.includes(k));
                });
                for (const m of clickish) {
                    logRpcLine(`[scan]   CLICKISH ${m.isStatic ? "static " : ""}${m.name}(${m.params.join(",")}) → ${m.ret}`);
                }
                // Small methods taking no params or a single int/cell — high-likelihood handlers.
                const shortHandlers = c.methods.filter(m => !m.isStatic && m.params.length <= 1 && m.ret === "System.Void"
                    && !CLICK_KW.some(k => m.name.toLowerCase().includes(k))
                    && m.name !== ".ctor" && m.name !== "Awake" && m.name !== "OnEnable" && m.name !== "OnDisable"
                    && m.name !== "Start" && m.name !== "Update" && m.name !== "OnDestroy");
                for (const m of shortHandlers.slice(0, 8)) {
                    logRpcLine(`[scan]   short    ${m.name}(${m.params.join(",")}) → ${m.ret}`);
                }
            }
            logRpcLine(`[scan] === end ===`);
        } catch (err) {
            logRpcLine(`[map] scanArrowCandidates threw: ${String(err)}`);
        }
    });

    container.querySelector<HTMLButtonElement>("#mp-dump-bt")!.addEventListener("click", async () => {
        try {
            const stacks = await rpcCall<Array<{ ts: number; cls: string; frames: string[] }>>("getOutgoingStacks", []);
            if (!stacks.length) { logRpcLine(`[map] no backtraces captured — did you ARM BT and then click an arrow?`); return; }
            logRpcLine(`[map] === ${stacks.length} captured backtraces ===`);
            const t0 = stacks[0].ts;
            for (const s of stacks) {
                const dt = s.ts - t0;
                logRpcLine(`[bt] +${dt}ms ${s.cls}`);
                for (let i = 0; i < s.frames.length; i++) {
                    logRpcLine(`[bt]   #${i} ${s.frames[i]}`);
                }
            }
        } catch (err) {
            logRpcLine(`[map] getOutgoingStacks threw: ${String(err)}`);
        }
    });

    clearActorsBtn.addEventListener("click", () => {
        actors.clear();
        selfCell = -1;
        updateActorList();
        render();
    });

    // Subscribe to socket events to maintain actor overlay.
    const unsub = onWsEvent((ev) => {
        if (ev.type !== "message") return;
        const m = (ev as any).message;
        if (!m || m.type !== "send") return;
        const p = m.payload as any;
        if (!p || p.type !== "socket") return;

        const fields = (p.fields || {}) as Record<string, unknown>;
        const cls = String(p.cls || "");

        // Outgoing map-loaded signal (jmw) — the client just confirmed a new map is ready.
        // Reload the grid state automatically so the user doesn't have to click REFRESH.
        // During an auto-travel, skip the heavy listActors/Interactives/MonsterGroups
        // scans — just update state.mapId by reading MapRenderer. Full reload happens
        // once at travel end.
        if (p.direction === "out" && (cls === "jmw" || p.name === "GameContextReadyMessage")) {
            // During travel, skip the heavy loadState on every hop (would
            // stutter the game's map rebuild). Detect arrival via the mapId
            // carried in the jmw event itself — the agent hook populates
            // `fields.ekry` for jmw only.
            if (isTraveling()) {
                const arrivedMapId = (p.fields as any)?.ekry;
                if (arrivedMapId && currentTravelTarget && String(arrivedMapId) === currentTravelTarget) {
                    travelActive = false;
                    currentTravelTarget = null;
                    logRpcLine(`[travel] arrived at ${arrivedMapId}`);
                    setTimeout(() => { void loadState(); }, 300);
                }
                return;
            }
            setTimeout(() => { void loadState(); }, 250);
            return;
        }

        // Outgoing move request (iri) — my destination
        if (p.direction === "out" && (cls === "iri" || p.name === "GameMapMovementRequestMessage")) {
            const raw = parsePathLastCell(fields["efdn"]);
            if (raw !== null) {
                const dest = decompressCell(raw);
                selfCell = dest;
                // Arm the "next matching irl is me" detector if we don't already know our actorId.
                if (!meActorId) pendingSelfMove = { cell: dest, ts: Date.now() };
                updateActorList();
                render();
            }
            return;
        }

        // Incoming move (irl) — track other actors, distinguish "me" from others.
        if (p.direction === "in" && (cls === "irl" || p.name === "GameMapMovementMessage")) {
            const actorId = parseInt64(fields["efeb"]);
            const current = parseIntField(fields["efee"]);
            const pathLast = parsePathLastCell(fields["efeh"]);
            const cellRaw = pathLast ?? current;
            if (actorId === null || cellRaw === null || cellRaw < 0) return;
            const cell = decompressCell(cellRaw);

            // "That's me" resolution: if we armed pendingSelfMove and this irl's destination
            // matches the cell we just requested, adopt this actorId as ours.
            if (!meActorId && pendingSelfMove
                && Date.now() - pendingSelfMove.ts < SELF_MATCH_WINDOW_MS
                && cell === pendingSelfMove.cell) {
                meActorId = actorId;
                pendingSelfMove = null;
                // Ensure we're not double-listed as "other" from a previous irl.
                actors.delete(actorId);
            }

            if (actorId === meActorId) {
                selfCell = cell;
            } else {
                // Preserve the richer kind from snapshot if we already know this actor;
                // otherwise leave as "other" — next loadState() will classify it properly.
                const prev = actors.get(actorId);
                actors.set(actorId, {
                    id: actorId,
                    cell,
                    lastSeen: Date.now(),
                    kind: prev?.kind ?? "other",
                    kindEnum: prev?.kindEnum,
                });
            }
            updateActorList();
            render();
            return;
        }

        // Actor removed (jnc)
        if (p.direction === "in" && (cls === "jnc" || p.name === "GameContextRemoveElementMessage")) {
            const actorId = parseInt64(fields["ektq"]);
            if (actorId !== null && actors.delete(actorId)) {
                updateActorList();
                render();
            }
        }
    });

    // Cleanup: when the wrapper gets replaced (tab switch), MutationObserver
    // detects removal and calls unsub to free the WS listener.
    const mo = new MutationObserver(() => {
        if (!document.body.contains(container)) {
            unsub();
            mo.disconnect();
        }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Initial load — fetch map state + pre-install the nav hook so the
    // first click has a warm cache. These run in parallel; the hook install
    // takes ~2s (class-scan prime), much better absorbed here than on click.
    void loadState();
    void ensureHook();
}

function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
