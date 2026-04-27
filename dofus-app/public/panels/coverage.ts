// Coverage panel — set-cover greedy on maps, recomputed at every step.
//
// Plan source: data/resource-plan.json (built by build-resource-plan.py).
// Plan format: flat list of MAPS, each with the gfxIds it covers.
//
// Runtime loop:
//   captured = new Set(plan.knownGfx)
//   while remaining maps with score > 0:
//       score(map) = |map.gfxIds \ captured|
//       pick map with max score; tie-break by same-subarea-as-player + Manhattan
//       try to autopilot+capture
//       on success: captured |= map.gfxIds; remove map
//       on fail: mark map failed-this-session; pick next
//
// After every successful capture, scores update — entries that would have
// captured already-known gfxIds drop, so we naturally avoid redundant visits.

import { rpcCall } from "../lib/rpc.js";
import { onWsEvent } from "../lib/ws.js";
import { logRpcLine } from "./logs.js";
import {
    reachableMidsFrom, loadWorldGraphFromJson,
    type WorldGraph, type MapMeta,
} from "../lib/regions.js";

interface MapEntry {
    mapId: number; posX: number; posY: number; wm: number;
    subAreaId: number; subArea: string;
    outdoor?: boolean; priority?: boolean;
    gfxIds: number[];
    order?: number;        // set when loaded from coverage-plan.json (ordered mode)
    isWaypoint?: boolean;  // ordered-plan only: traverse without expecting capture yield
}
interface ResourcePlan {
    generatedAt: string;
    stats: { totalMaps: number; totalGfxToCapture: number; knownGfx: number };
    knownGfx: number[];
    gfxCount?: Record<string, number>;   // gfxId → how many maps contain it (popularity)
    maps: MapEntry[];
}

interface SubAreaEntry { id: number; name: string; level?: number; areaId?: number; }
interface AreaEntry { id: number; name: string; }

type RunPhase = "idle" | "init" | "traveling" | "capturing" | "fail" | "done" | "stopped";

export function renderCoverage(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; gap:var(--s-3); padding:var(--s-3); height:100%; overflow:hidden">

        <!-- LEFT: controls + queue -->
        <div style="flex:0 0 380px; display:flex; flex-direction:column; gap:var(--s-3); overflow:hidden">
          <fieldset style="border:1px solid #333; padding:var(--s-2); border-radius:4px">
            <legend style="padding:0 var(--s-2); color:var(--c-label); font-size:11px">catalog + plan</legend>
            <div style="display:flex; gap:var(--s-2); flex-wrap:wrap">
              <button id="cv-extract" class="btn">EXTRACT CATALOGS</button>
              <button id="cv-reload-plan" class="btn">↻ reload plan</button>
              <select id="cv-plan-variant" style="background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px; padding:2px 4px">
                <option value="coverage-plan.json">full coverage</option>
                <option value="coverage-plan-no-wabbit.json">no Wabbit</option>
                <option value="coverage-plan-wabbit.json">Wabbit only</option>
              </select>
              <button id="cv-load-ordered" class="btn" title="Load the selected coverage-plan-*.json (ordered + densified). Runner walks in plan order, no scoring.">USE COVERAGE PLAN</button>
            </div>
            <div id="cv-extract-status" style="margin-top:var(--s-1); font-size:10px; color:var(--c-label); font-family:var(--font-mono)"></div>
            <div id="cv-plan-summary" style="margin-top:var(--s-2); font-size:11px; color:var(--c-label); font-family:var(--font-mono); white-space:pre-wrap"></div>
          </fieldset>

          <fieldset style="border:1px solid #333; padding:var(--s-2); border-radius:4px">
            <legend style="padding:0 var(--s-2); color:var(--c-label); font-size:11px">smart coverage builder</legend>
            <div style="display:flex; gap:var(--s-2); align-items:center; flex-wrap:wrap; margin-bottom:var(--s-1)">
              <span style="font-size:11px; color:var(--c-label)">worlds:</span>
              <label style="font-size:11px; color:#ccc"><input type="checkbox" id="cv-ad-wm1" checked> wm=1</label>
              <label style="font-size:11px; color:#ccc"><input type="checkbox" id="cv-ad-wmm1" checked> wm=-1</label>
            </div>
            <div style="display:flex; gap:var(--s-2); align-items:center; margin-bottom:var(--s-1); flex-wrap:wrap">
              <span style="font-size:11px; color:var(--c-label)">subareas:</span>
              <label style="font-size:11px; color:#ccc"><input type="radio" name="cv-ad-sa-mode" value="any" checked> any</label>
              <label style="font-size:11px; color:#ccc"><input type="radio" name="cv-ad-sa-mode" value="include"> include</label>
              <label style="font-size:11px; color:#ccc"><input type="radio" name="cv-ad-sa-mode" value="exclude"> exclude</label>
            </div>
            <div style="display:flex; gap:var(--s-2); align-items:center; margin-bottom:var(--s-1)">
              <input type="text" id="cv-ad-sa-input" placeholder="search subarea name + Enter" style="flex:1; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px; padding:2px 4px">
            </div>
            <div id="cv-ad-sa-tags" style="display:flex; gap:4px; flex-wrap:wrap; margin-bottom:var(--s-2); min-height:1.4em"></div>
            <div style="display:flex; gap:var(--s-2); align-items:center; margin-bottom:var(--s-1); flex-wrap:wrap">
              <span style="font-size:11px; color:var(--c-label)">hb mapId:</span>
              <input type="text" id="cv-ad-hb-mid" placeholder="auto-fill" style="width:100px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px; padding:2px 4px">
              <span style="font-size:11px; color:var(--c-label)">hb id:</span>
              <input type="text" id="cv-ad-hb-id" placeholder="auto-fill" style="width:130px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px; padding:2px 4px">
              <button id="cv-ad-hb-autofill" class="btn" title="Go into your haven-bag (press H), then click. Captures current mapId and the next igd packet's ecxt.">auto-fill</button>
            </div>
            <div style="display:flex; gap:var(--s-2); margin-bottom:var(--s-2)">
              <button id="cv-ad-compute" class="btn">↻ Build path</button>
              <button id="cv-ad-start" class="btn primary">▶ Start path</button>
              <button id="cv-ad-resume" class="btn" style="display:none" title="resume after Tier-2 brick or N1 fallback">RESUME</button>
            </div>
            <div id="cv-ad-status" style="font-size:10px; color:var(--c-label); font-family:var(--font-mono); white-space:pre-wrap; margin-bottom:var(--s-1)"></div>
            <div id="cv-ad-regions" style="max-height:160px; overflow:auto; font-family:var(--font-mono); font-size:11px; border-top:1px solid #222; padding-top:var(--s-1)"></div>
          </fieldset>

          <fieldset style="border:1px solid #333; padding:var(--s-2); border-radius:4px">
            <legend style="padding:0 var(--s-2); color:var(--c-label); font-size:11px">runner</legend>
            <div style="display:flex; gap:var(--s-2); flex-wrap:wrap">
              <button id="cv-runplan" class="btn primary">START</button>
              <button id="cv-skip" class="btn" disabled title="abort current travel, mark map as failed-this-session, pick next-best">SKIP MAP</button>
              <button id="cv-retry" class="btn" title="clear failed-maps set so they get re-tried — useful after walking back to a region where they're now reachable">RETRY FAILED</button>
            </div>
            <div id="cv-counters" style="margin-top:var(--s-2); font-size:11px; font-family:var(--font-mono); color:var(--c-label); white-space:pre-wrap"></div>
          </fieldset>

          <div style="flex:1; min-height:0; display:flex; flex-direction:column; border:1px solid #333; border-radius:4px; padding:var(--s-2)">
            <div style="font-size:11px; color:var(--c-label); font-family:var(--font-mono); margin-bottom:var(--s-1)">queue (top 50 by current score)</div>
            <div id="cv-queue" style="flex:1; min-height:0; overflow:auto; font-family:var(--font-mono); font-size:11px"></div>
          </div>
        </div>

        <!-- RIGHT: live target -->
        <div style="flex:1; display:flex; flex-direction:column; gap:var(--s-2); min-width:0; overflow:auto">
          <div style="display:flex; gap:var(--s-2); align-items:center; padding:var(--s-2); background:#0a0a0a; border:1px solid #222; border-radius:4px">
            <span id="cv-phase-dot" style="width:10px; height:10px; border-radius:50%; background:#444; display:inline-block"></span>
            <span id="cv-phase-label" style="font-family:var(--font-mono); font-size:13px; color:#ccc">idle</span>
          </div>

          <div id="cv-current" style="font-family:var(--font-mono); font-size:12px; color:#ccc; white-space:pre-wrap; padding:var(--s-2); background:#0a0a0a; border:1px solid #222; border-radius:4px; min-height:7em"></div>

          <div style="display:flex; gap:var(--s-2); align-items:flex-start">
            <img id="cv-target-img" style="max-width:480px; max-height:320px; border:1px solid #333; image-rendering:pixelated; background:#111" alt="target preview" />
            <div id="cv-target-meta" style="flex:1; font-family:var(--font-mono); font-size:11px; color:var(--c-label); white-space:pre-wrap; padding:var(--s-2); background:#0a0a0a; border:1px solid #222; border-radius:4px; align-self:stretch"></div>
          </div>

          <div style="font-size:10px; color:var(--c-label); font-family:var(--font-mono); margin-top:var(--s-1)">autopilot state (use the Map tab autopilot debug panel for live)</div>
          <div id="cv-debug-state" style="font-family:var(--font-mono); font-size:11px; color:#ccc; white-space:pre-wrap; padding:var(--s-2); background:#0a0a0a; border:1px solid #222; border-radius:4px; min-height:6em"></div>
        </div>
      </div>
    `;

    const extractBtn   = container.querySelector<HTMLButtonElement>("#cv-extract")!;
    const extractStat  = container.querySelector<HTMLDivElement>("#cv-extract-status")!;
    const reloadPlanBtn = container.querySelector<HTMLButtonElement>("#cv-reload-plan")!;
    const loadOrderedBtn = container.querySelector<HTMLButtonElement>("#cv-load-ordered")!;
    const planSummary  = container.querySelector<HTMLDivElement>("#cv-plan-summary")!;
    const startBtn     = container.querySelector<HTMLButtonElement>("#cv-runplan")!;
    const skipBtn      = container.querySelector<HTMLButtonElement>("#cv-skip")!;
    const retryBtn     = container.querySelector<HTMLButtonElement>("#cv-retry")!;
    const counters     = container.querySelector<HTMLDivElement>("#cv-counters")!;
    const queueEl      = container.querySelector<HTMLDivElement>("#cv-queue")!;
    const phaseDot     = container.querySelector<HTMLSpanElement>("#cv-phase-dot")!;
    const phaseLabel   = container.querySelector<HTMLSpanElement>("#cv-phase-label")!;
    const currentEl    = container.querySelector<HTMLDivElement>("#cv-current")!;
    const targetImg    = container.querySelector<HTMLImageElement>("#cv-target-img")!;
    const targetMeta   = container.querySelector<HTMLDivElement>("#cv-target-meta")!;
    const debugStateEl = container.querySelector<HTMLDivElement>("#cv-debug-state")!;
    const adWm1Cb       = container.querySelector<HTMLInputElement>("#cv-ad-wm1")!;
    const adWmm1Cb      = container.querySelector<HTMLInputElement>("#cv-ad-wmm1")!;
    const adSaInput     = container.querySelector<HTMLInputElement>("#cv-ad-sa-input")!;
    const adSaTags      = container.querySelector<HTMLDivElement>("#cv-ad-sa-tags")!;
    const adHbMidInput  = container.querySelector<HTMLInputElement>("#cv-ad-hb-mid")!;
    const adHbIdInput   = container.querySelector<HTMLInputElement>("#cv-ad-hb-id")!;
    const adHbAutofill  = container.querySelector<HTMLButtonElement>("#cv-ad-hb-autofill")!;
    const adComputeBtn  = container.querySelector<HTMLButtonElement>("#cv-ad-compute")!;
    const adStartBtn    = container.querySelector<HTMLButtonElement>("#cv-ad-start")!;
    const adResumeBtn   = container.querySelector<HTMLButtonElement>("#cv-ad-resume")!;
    const adStatusEl    = container.querySelector<HTMLDivElement>("#cv-ad-status")!;
    const adRegionsEl   = container.querySelector<HTMLDivElement>("#cv-ad-regions")!;

    // ---- catalogs (sub/area names for human-readable preview) ----
    const subareas = new Map<number, SubAreaEntry>();
    const areas    = new Map<number, AreaEntry>();
    async function loadCatalogs(): Promise<void> {
        try {
            const sa = await fetch("/api/catalog/subareas").then(r => r.json());
            for (const s of (sa?.items ?? [])) subareas.set(s.id, s);
        } catch {}
        try {
            const ar = await fetch("/api/catalog/areas").then(r => r.json());
            for (const a of (ar?.items ?? [])) areas.set(a.id, a);
        } catch {}
    }

    // ---- plan + runtime state ----
    let plan: ResourcePlan | null = null;
    let captured = new Set<number>();
    let failedMaps = new Set<number>();          // maps tried this session that didn't engage / arrive
    let visitedMaps = new Set<number>();         // maps successfully captured this session
    let mapsArr: MapEntry[] = [];                // in-memory pool, removed on success/fail
    let runRequested = false;
    let abortCurrentTravel = false;
    let totalCapturedAtStart = 0;
    // Plan source mode. "scored" = resource-plan.json + dynamic scoring (default).
    // "ordered" = coverage-plan.json + walk in static order (with waypoints).
    let planMode: "scored" | "ordered" | "adaptive" = "scored";
    // Adaptive path-runner state
    let adGraph: WorldGraph | null = null;
    let adMapMeta: Map<number, MapMeta> = new Map();
    let adAwaitingResume = false;
    let adBuiltPath: PathStep[] = [];
    let adPathIndex = 0;
    let adPathDropped: number[] = [];
    let adPathStats = { targetCount: 0, zaapJumps: 0 };
    let adRegionFailsCount = 0;  // consecutive silent-rejects (Tier-2 brick proxy)
    const adSubareaTags = new Set<number>();
    interface KnownZaap { mapId: number; posX: number; posY: number; wm: number; }
    let adKnownZaaps: KnownZaap[] = [];
    // Zaaps that returned "Impossible d'utiliser ce zaap" (i.e. the server
    // rejected the teleport — probably this account hasn't unlocked it).
    // dun.lqq() returns a static catalog of ~47 popular zaaps regardless of
    // account; we can't tell unlocked from locked at build time. So we
    // optimistically include all of them, then blacklist on first failure
    // and recompute. Cleared on RESUME.
    const adFailedZaaps = new Set<number>();

    // A single step of the smart-path. Walk steps imply autoTravelInstant;
    // capture steps imply captureCurrentMap on the current map. openHb +
    // zaap are the cross-region bridge primitives, only inserted when a
    // candidate is not walk-reachable from the current path-position.
    type PathStep =
        | { kind: "walk"; target: number }
        | { kind: "capture"; target: number }
        | { kind: "openHb" }
        | { kind: "zaap"; target: number };

    async function loadPlan(): Promise<void> {
        try {
            const r = await fetch("/api/resource-plan");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            plan = await r.json();
            captured = new Set(plan?.knownGfx ?? []);
            // Pre-load gfxWeight from the plan's static popularity counts
            // (build-resource-plan.py computes mapCount per gfxId).
            gfxWeight = new Map();
            for (const [g, n] of Object.entries(plan?.gfxCount ?? {})) gfxWeight.set(parseInt(g, 10), Number(n));
            // Pull session-captured gfxIds from disk (any data/maps/*.json
            // with updatedAt set). Lets us resume after a page reload without
            // losing the visited-this-session progress.
            let sessionCount = 0, scannedMaps = 0;
            try {
                const cap = await fetch("/api/captured-gfx").then(r => r.json());
                for (const g of (cap?.gfxIds ?? [])) captured.add(Number(g));
                sessionCount = (cap?.gfxIds?.length ?? 0);
                scannedMaps = cap?.scannedMaps ?? 0;
                // Mark visited maps so we don't re-target them.
                visitedMaps = new Set();
                // We can't enumerate visited maps from the gfx endpoint alone.
                // Instead skip during pickNext: any plan-map whose gfxIds are
                // ALL in captured will have score=0 → naturally skipped.
            } catch {}
            failedMaps = new Set();
            mapsArr = (plan?.maps ?? []).slice();
            totalCapturedAtStart = captured.size;
            const stats = plan?.stats;
            const initialCaptured = captured.size;
            planSummary.textContent =
                `plan: ${stats?.totalMaps ?? "?"} maps · ${stats?.totalGfxToCapture ?? "?"} unique gfx target\n` +
                `at build time: ${stats?.knownGfx ?? "?"} gfx known (gfx-to-type.json)\n` +
                `loaded from disk now: +${sessionCount} more gfx (${scannedMaps} captured maps)\n` +
                `→ total currently captured: ${initialCaptured} gfx`;
            redrawQueue();
            updateCounters();
        } catch (e) {
            plan = null; mapsArr = [];
            planSummary.textContent = `no plan loaded — run:\n  python dofus-app/scripts/build-resource-plan.py\n(${String(e).slice(0, 80)})`;
        }
    }

    // Load coverage-plan.json (built by build-coverage-plan.py). Maps are
    // pre-ordered + densified with waypoints. Runner walks in `order` field
    // sequentially instead of scoring. Waypoints have empty gfxIds —
    // captured naturally returns 0 there, so they're traversed without yield.
    async function loadOrderedPlan(filename: string = "coverage-plan.json"): Promise<void> {
        try {
            const r = await fetch(`/api/coverage-plan?file=${encodeURIComponent(filename)}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const cp = await r.json();
            captured = new Set();  // ordered mode doesn't track gfx — just walk
            try {
                const cap = await fetch("/api/captured-gfx").then(r => r.json());
                for (const g of (cap?.gfxIds ?? [])) captured.add(Number(g));
            } catch {}
            failedMaps = new Set();
            visitedMaps = new Set();
            // Convert coverage-plan entry shape → MapEntry shape.
            mapsArr = (cp?.maps ?? []).map((m: any): MapEntry => ({
                mapId: m.mapId,
                posX: m.posX, posY: m.posY,
                wm: m.worldMap,
                subAreaId: m.subAreaId ?? 0,
                subArea: m.subArea ?? "",
                gfxIds: m.sampleGfx ?? [],  // sample only — full list isn't in coverage-plan
                order: m.order,
                isWaypoint: !!m.isWaypoint,
            }));
            mapsArr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            totalCapturedAtStart = captured.size;
            planMode = "ordered";
            const wpCount = mapsArr.filter(m => m.isWaypoint).length;
            planSummary.textContent =
                `[ORDERED] ${filename}: ${mapsArr.length} maps (${wpCount} waypoints, ${mapsArr.length - wpCount} capture)\n` +
                `expected new clusters: ${cp?.stats?.expectedNewClusters ?? "?"}\n` +
                `densified to keep hops short — runner walks in order, ignores scoring`;
            redrawQueue();
            updateCounters();
        } catch (e) {
            plan = null; mapsArr = []; planMode = "scored";
            planSummary.textContent = `failed to load coverage-plan — run:\n  python dofus-app/scripts/build-coverage-plan.py\n(${String(e).slice(0, 80)})`;
        }
    }

    // Weighted set-cover: map score = sum of "popularity" weights of each
    // unmapped gfxId on the map. Popularity = number of plan-maps containing
    // that gfxId. Maps containing many WIDELY-PRESENT gfxs rank higher than
    // maps with the same raw gfx count but rarer gfxs. User asked: prioritise
    // common interactables first.
    let gfxWeight: Map<number, number> = new Map();
    function scoreMap(m: MapEntry): number {
        let s = 0;
        for (const g of m.gfxIds) if (!captured.has(g)) s += gfxWeight.get(g) ?? 1;
        return s;
    }
    function rawScore(m: MapEntry): number {
        let s = 0;
        for (const g of m.gfxIds) if (!captured.has(g)) s++;
        return s;
    }
    function manhattan(a: { posX: number; posY: number }, b: { posX: number; posY: number }): number {
        return Math.abs(a.posX - b.posX) + Math.abs(a.posY - b.posY);
    }

    // Drop from mapsArr every non-waypoint map whose entire gfxIds set is now
    // captured (rawScore == 0). Called after each successful capture so the
    // queue stays clean — user observed maps for already-known gfx still
    // showing up otherwise.
    function pruneCapturedMaps(): number {
        const before = mapsArr.length;
        mapsArr = mapsArr.filter(m => m.isWaypoint || rawScore(m) > 0);
        return before - mapsArr.length;
    }

    let currentPlayerMapId: number | null = null;
    async function refreshPlayerMapId(): Promise<void> {
        try { currentPlayerMapId = await rpcCall<number>("getCurrentMapId", []); }
        catch { currentPlayerMapId = null; }
    }

    // Pick the next best map. Tie-break: prefer same wm as current map, same
    // subarea as current map, then closest Manhattan distance. Skip maps in
    // `failedMaps` and `visitedMaps`. Returns null when nothing left to try.
    // Compare two 4-tuples lexicographically. JS native `<` on arrays falls
    // back to string comparison ("[-336,0,0,5]" vs "[-1,0,0,0]" gives the
    // wrong order!) — that bug was making the runner pick low-score maps
    // while the queue display (which uses sort with element-wise compare)
    // showed the correct top. Element-wise compare here.
    function keyLess(a: [number, number, number, number], b: [number, number, number, number]): boolean {
        for (let i = 0; i < 4; i++) {
            if (a[i]! < b[i]!) return true;
            if (a[i]! > b[i]!) return false;
        }
        return false;
    }
    // Max Manhattan distance per hop. Beyond this, autopilot tends to silent-reject
    // because the pathfind goes too long. User asked (2026-04-27) to prioritize
    // proximity over score so the runner does many short hops in a region before
    // moving on, even if it means revisiting nearby areas. 5 cells = "adjacent
    // neighborhood" — most hops within a subarea fit.
    const MAX_HOP = 5;

    function pickNext(): { map: MapEntry; score: number } | null {
        // Ordered mode: walk by `order` field, skip visited/failed. Waypoints
        // are transit-only (score=0 but we DO pick them). Non-waypoint maps
        // with rawScore=0 (all gfx already captured) are skipped — keeps the
        // queue from re-visiting redundant captures.
        if (planMode === "ordered") {
            for (const m of mapsArr) {
                if (failedMaps.has(m.mapId) || visitedMaps.has(m.mapId)) continue;
                if (!m.isWaypoint && rawScore(m) === 0) continue;
                return { map: m, score: m.isWaypoint ? 0 : scoreMap(m) };
            }
            return null;
        }
        const cur = currentPlayerMapId ? mapsArr.find(m => m.mapId === currentPlayerMapId) ?? null : null;
        let best: MapEntry | null = null;
        let bestScore = 0;
        let bestKey: [number, number, number, number] = [Infinity, Infinity, Infinity, Infinity];
        for (const m of mapsArr) {
            if (failedMaps.has(m.mapId) || visitedMaps.has(m.mapId)) continue;
            const s = scoreMap(m);
            if (s <= 0) continue;
            // Proximity-first ordering (changed 2026-04-27 from score-first):
            //   1. Within MAX_HOP cells of player → strongly preferred (0 vs 1)
            //   2. Same worldmap (no zaap warp needed) → preferred
            //   3. Closer = better (raw manhattan)
            //   4. Higher score = tie-breaker (negative for sort)
            // If no player position known, fall back to score-first.
            const dist = cur ? manhattan(m, cur) : 0;
            const key: [number, number, number, number] = cur ? [
                dist <= MAX_HOP ? 0 : 1,
                m.wm === cur.wm ? 0 : 1,
                dist,
                -s,
            ] : [-s, 0, 0, 0];
            if (best === null || keyLess(key, bestKey)) {
                best = m; bestScore = s; bestKey = key;
            }
        }
        return best ? { map: best, score: bestScore } : null;
    }

    function topRanked(n: number): Array<{ map: MapEntry; score: number }> {
        if (planMode === "ordered") {
            return mapsArr
                .filter(m => !failedMaps.has(m.mapId) && !visitedMaps.has(m.mapId))
                .filter(m => m.isWaypoint || rawScore(m) > 0)
                .slice(0, n)
                .map(m => ({ map: m, score: m.isWaypoint ? 0 : scoreMap(m) }));
        }
        const cur = currentPlayerMapId ? mapsArr.find(m => m.mapId === currentPlayerMapId) ?? null : null;
        const out: Array<{ map: MapEntry; score: number; key: [number, number, number, number] }> = [];
        for (const m of mapsArr) {
            if (failedMaps.has(m.mapId) || visitedMaps.has(m.mapId)) continue;
            const s = scoreMap(m);
            if (s <= 0) continue;
            const dist = cur ? manhattan(m, cur) : 0;
            const key: [number, number, number, number] = cur ? [
                dist <= MAX_HOP ? 0 : 1,
                m.wm === cur.wm ? 0 : 1,
                dist,
                -s,
            ] : [-s, 0, 0, 0];
            out.push({ map: m, score: s, key });
        }
        out.sort((a, b) => {
            for (let i = 0; i < 4; i++) if (a.key[i]! !== b.key[i]!) return a.key[i]! - b.key[i]!;
            return 0;
        });
        return out.slice(0, n);
    }

    function redrawQueue(): void {
        if (!plan) { queueEl.textContent = ""; return; }
        const top = topRanked(50);
        const frag = document.createDocumentFragment();
        top.forEach((row, i) => {
            const m = row.map;
            const isCurrent = i === 0;
            const raw = rawScore(m);
            const div = document.createElement("div");
            div.style.cssText = `padding:2px 4px; border-radius:2px; ${isCurrent ? "background:#1a3a1a; color:#fff; border-left:3px solid #4a4" : "color:var(--c-label)"}`;
            div.textContent = `${(i + 1).toString().padStart(3)}  w=${row.score.toString().padStart(5)} (+${raw.toString().padStart(2)}gfx)  ${m.mapId.toString().padStart(10)} (${m.posX.toString().padStart(3)},${m.posY.toString().padStart(3)}) wm=${m.wm.toString().padStart(2)}  ${(m.subArea || "?").slice(0, 22)}`;
            frag.appendChild(div);
        });
        if (top.length === 0) {
            const div = document.createElement("div");
            div.style.color = "#888";
            div.textContent = "no map left with score > 0";
            frag.appendChild(div);
        }
        queueEl.replaceChildren(frag);
    }

    function setPhase(phase: RunPhase, label: string): void {
        const colors: Record<RunPhase, string> = {
            idle: "#444", init: "#888", traveling: "#fc4", capturing: "#4af",
            fail: "#f33", done: "#4a4", stopped: "#666",
        };
        phaseDot.style.background = colors[phase];
        phaseLabel.textContent = label;
    }

    function updateCounters(): void {
        if (!plan) { counters.textContent = "no plan"; return; }
        const totalMaps = plan.maps.length;
        // "actionable" = maps still in pool whose score > 0. This is what
        // matters — `total - visited - failed` is misleading because many
        // maps have score=0 after reload (their gfxIds are all already
        // captured from previous sessions or this session's bonus catches).
        let actionable = 0, alreadyCovered = 0;
        for (const m of mapsArr) {
            if (failedMaps.has(m.mapId) || visitedMaps.has(m.mapId)) continue;
            if (scoreMap(m) > 0) actionable++;
            else alreadyCovered++;
        }
        const newGfx = captured.size - totalCapturedAtStart;
        counters.textContent =
            `maps: actionable=${actionable}  visited=${visitedMaps.size}  failed=${failedMaps.size}  done-by-bonus=${alreadyCovered}/${totalMaps}\n` +
            `gfx captured: ${captured.size} / start ${totalCapturedAtStart}  (+${newGfx} new this session)`;
    }

    function setCurrentTarget(m: MapEntry | null, score: number): void {
        if (!m) { currentEl.textContent = ""; targetImg.removeAttribute("src"); targetMeta.textContent = ""; return; }
        const sa = subareas.get(m.subAreaId);
        const area = sa ? areas.get(sa.areaId ?? -1) : null;
        const raw = rawScore(m);
        currentEl.textContent =
            `target mapId: ${m.mapId}\n` +
            `coords:       (${m.posX}, ${m.posY})  wm=${m.wm}\n` +
            `subarea:      ${m.subArea || sa?.name || "?"}  (level=${sa?.level ?? "?"})\n` +
            `area:         ${area?.name ?? "?"}\n\n` +
            `weighted score: ${score}  (popularity sum)\n` +
            `would capture:  ${raw} new gfxIds  (out of ${m.gfxIds.length} on map)`;
        targetMeta.textContent =
            `outdoor:  ${m.outdoor ?? "?"}\n` +
            `priority: ${m.priority ?? "?"}\n\n` +
            `gfxIds on map (${m.gfxIds.length}):  ✓=already captured  ✗=new\n` +
            m.gfxIds.map(g => {
                const w = gfxWeight.get(g) ?? 1;
                return `  ${captured.has(g) ? "✓" : "✗"} ${String(g).padStart(7)}  ×${w}`;
            }).join("\n");
        targetImg.src = `/map-preview/${m.mapId}.png?t=${Date.now()}`;
        targetImg.onerror = () => { targetImg.alt = "no preview cached"; };
    }

    // ============================================================
    //  Travel primitives — copied from prior coverage.ts impl.
    // ============================================================
    // (waitArrival removed 2026-04-27 — replaced by event-only arrival
    // detection via armCleanIdleBarrier listening for autopilot-done.)

    // Resolve when a `jmw` event reports the current mapId == target.
    // Returns true on match, false on timeout. Used by the adaptive runner's
    // bridgeToRegion to detect arrival in haven-bag and zaap dest.
    function waitForMapId(targetMid: number, timeoutMs = 8000): Promise<boolean> {
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok: boolean) => { if (done) return; done = true; unsub(); clearTimeout(timer); resolve(ok); };
            const unsub = onWsEvent((ev) => {
                if (ev.type !== "message") return;
                const m = (ev as any).message;
                if (m?.type !== "send") return;
                const p = m.payload;
                if (p?.type !== "socket" || p.cls !== "jmw") return;
                const mid = Number(p.fields?.ekry ?? 0);
                if (mid === targetMid) finish(true);
            });
            const timer = setTimeout(() => finish(false), timeoutMs);
        });
    }

    function armCleanIdleBarrier(): { wait: (maxMs: number) => Promise<"event" | "timeout">; cancel: () => void } {
        let fired = false;
        let resolveFn: ((v: "event" | "timeout") => void) | null = null;
        let timeoutTimer: any = null;
        let unsubbed = false;
        const unsub = onWsEvent((ev) => {
            if (ev.type !== "message") return;
            const m = (ev as any).message;
            if (m?.type !== "send" || m?.payload?.type !== "autopilot-done") return;
            fired = true;
            if (resolveFn) {
                if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
                resolveFn("event"); resolveFn = null;
            }
        });
        const safeUnsub = () => { if (!unsubbed) { unsubbed = true; unsub(); } };
        return {
            wait(maxMs) {
                return new Promise((resolve) => {
                    if (fired) { resolve("event"); return; }  // sticky — listener stays alive for repeated waits
                    resolveFn = resolve;
                    // Timeout DOES NOT unsub — caller may wait again and the
                    // autopilot-done event might still fire later. Only `cancel()`
                    // (or the event itself) tears down the listener.
                    timeoutTimer = setTimeout(() => {
                        if (resolveFn) { resolveFn("timeout"); resolveFn = null; }
                        timeoutTimer = null;
                    }, maxMs);
                });
            },
            cancel() {
                safeUnsub();
                if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
                resolveFn = null;
            },
        };
    }

    // Wait for the FIRST outgoing movement-related packet within `timeoutMs`:
    //   - `iri` (GameMapMovementRequest) — fires when the player starts walking
    //   - `isu` (GameMapMovementConfirm) — fires on arrival at next map
    //   - `isp` — bypassed-autopilot variant (sub-autopilot, see installOutgoingHook)
    // Any of these = the player is moving / has moved → bbd engaged.
    // Returns true on first match, false on timeout (= silent reject).
    function waitForEngagement(timeoutMs = 5000): Promise<boolean> {
        return new Promise((resolve) => {
            let done = false;
            const ENGAGE_CLASSES = new Set(["iri", "isu", "isp"]);
            const finish = (ok: boolean) => { if (done) return; done = true; unsub(); clearTimeout(timer); resolve(ok); };
            const unsub = onWsEvent((ev) => {
                if (ev.type !== "message") return;
                const m = (ev as any).message;
                if (m?.type !== "send") return;
                const p = m.payload;
                if (p?.type !== "socket") return;
                if (p.direction === "out" && ENGAGE_CLASSES.has(p.cls)) finish(true);
            });
            const timer = setTimeout(() => finish(false), timeoutMs);
        });
    }
    async function isAutopilotActive(): Promise<boolean> {
        // Fallback IL2CPP read — only used when WS-based detection isn't
        // suitable (e.g. user hasn't started outgoing capture). Reads the
        // single deiy field cheaply.
        try {
            const r = await rpcCall<any>("isAutopilotActive", []);
            return r?.active === true;
        } catch { return false; }
    }

    // Wait until dtt is idle (deiy=false) AND the position has stopped changing
    // for `stableMs`. Used between coverage iterations to ensure the prior
    // autopilot's tail (tkl event, server position ack, async cleanup) has
    // fully settled before firing the next bbd. Without this, fast back-to-back
    // bbds can race the prior cleanup → next bbd silent-rejects intermittently.
    async function waitIdleAndStable(stableMs = 800, maxMs = 5000): Promise<void> {
        const start = Date.now();
        let lastMid = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
        let lastChange = Date.now();
        // Poll every 500ms (was 250) to halve main-thread pressure between maps.
        while (Date.now() - start < maxMs) {
            await new Promise(r => setTimeout(r, 500));
            const active = await isAutopilotActive();
            const mid = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
            if (mid !== lastMid) { lastMid = mid; lastChange = Date.now(); }
            if (!active && Date.now() - lastChange >= stableMs) return;
        }
    }

    async function captureCurrentMap(): Promise<{ mapId: number; gfxIds: number[] } | null> {
        const [mid, ints] = await Promise.all([
            rpcCall<number>("getCurrentMapId", []),
            rpcCall<any[]>("getInteractivesOnMap", []),
        ]);
        if (!mid) return null;
        const res = await fetch(`/api/maps/${mid}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interactives: ints }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Resolve the gfxIds for this map: prefer the in-memory plan entry
        // (avoids an extra fetch), fall back to reading the saved per-map JSON
        // (covers cases where the autopilot ended on a map NOT in our plan —
        // e.g. user walked manually mid-run, or the player got teleported).
        const planMap = mapsArr.find(m => m.mapId === mid);
        if (planMap) return { mapId: mid, gfxIds: planMap.gfxIds };
        try {
            const md = await fetch(`/api/maps/${mid}`).then(r => r.ok ? r.json() : null);
            const gfxIds: number[] = Array.isArray(md?.ie) ? md.ie.map((x: any[]) => Number(x[2])) : [];
            return { mapId: mid, gfxIds };
        } catch { return { mapId: mid, gfxIds: [] }; }
    }

    // Single attempt at one map. Returns:
    //   "ok"          - arrived + captured
    //   "skip"        - user clicked SKIP MAP
    //   "fail"        - silent reject / stall / abort
    async function travelAndCapture(target: MapEntry): Promise<"ok" | "skip" | "fail"> {
        abortCurrentTravel = false;
        // Already on target?
        let onTarget = false;
        try { onTarget = (await rpcCall<number>("getCurrentMapId", [])) === target.mapId; } catch {}

        if (!onTarget) {
            // Drain the prior travel's tail before arming a new barrier.
            // Without this, the previous tkl→autopilot-done event arrives
            // ~50-200ms AFTER we arm cleanBarrier and triggers it as if the
            // new target was reached — runner then captures the wrong map
            // and the new bbd silent-rejects on the still-cleaning state.
            setPhase("init", "settling");
            await waitIdleAndStable(800, 5000);
            const cleanBarrier = armCleanIdleBarrier();
            // ARM the engagement listener BEFORE bbd — iri can fire within
            // 50-200ms of bbd, races the await for autoTravelInstant.
            const engagementWait = waitForEngagement(5000);
            setPhase("init", `bbd → ${target.mapId}`);
            // Tier 1 defensive cleanup before every bbd. Two cheap static-field
            // writes that null the static `foz.dpgi` (cached pathfind exception
            // that silently makes future solves return empty) and reset
            // `foz.dpgl._state` (CTS Notifying → NotCanceled). Identified
            // 2026-04-27 as the root of the cumulative "session bricked" state.
            // No effect on healthy sessions. Does NOT fix Tier 2 (worldgraph
            // edges corrupted) — that still requires Dofus restart.
            try { await rpcCall<any>("probeStaticField", ["foz", "dpgi", true]); } catch {}
            try { await rpcCall<any>("probeFozCts", [0]); } catch {}
            // autoTravelInstant runs an internal BFS pre-check on the cached
            // worldgraph before dispatching bbd. Non-reachable targets return
            // ok:false immediately — skip waiting 5s for an engagement that
            // will never come (and avoid corrupting foz state Tier 2).
            const bbdRet = await rpcCall<any>("autoTravelInstant", [target.mapId]).catch(() => null);
            if (bbdRet && bbdRet.ok === false && typeof bbdRet.reason === "string" && bbdRet.reason.includes("non-reachable")) {
                cleanBarrier.cancel();
                logRpcLine(`[plan] ${target.mapId} non-reachable per worldgraph BFS — skipping`);
                return "fail";
            }

            // Wait for outgoing `iri` (= client→server move request) =
            // confirmation that bbd engaged + pathfinder issued first step.
            const engaged = await engagementWait;
            if (abortCurrentTravel) {
                cleanBarrier.cancel();
                try { await rpcCall<any>("abortAutoTravel", []); } catch {}
                return "skip";
            }
            if (!engaged) {
                cleanBarrier.cancel();
                return "fail";  // no iri = silent reject
            }
            setPhase("traveling", `→ ${target.mapId} (${target.posX},${target.posY}) ${target.subArea}`);
            // Arrival detection — event-only (no polling). The autopilot-done
            // event fires on dtt.tkl(true,false) at the FINAL completion.
            // Arrival watcher with stall-detection + auto-retry. Resets a stall
            // timer on every movement packet (iri/isu/isp). If no movement for
            // STALL_MS, re-fires autoTravelInstant on the SAME target (often
            // unsticks the autopilot mid-journey when it stops moving). After
            // MAX_RETRIES re-fires, gives up.
            const STALL_MS = 10000;     // no movement for 10s = stuck
            const MAX_RETRIES = 3;
            const OSCILLATION_THRESHOLD = 3;  // same map visited N times = ping-pong bug
            const TOTAL_TIMEOUT = 5 * 60 * 1000;
            let retries = 0;
            let oscillationFixes = 0;
            const MAX_OSCILLATION_FIXES = 2;
            const totalTimer = setTimeout(() => { /* nothing — handled in loop */ }, TOTAL_TIMEOUT);
            const totalDeadline = Date.now() + TOTAL_TIMEOUT;
            let arrivedOk = false;
            let lastMovement = Date.now();
            // Track each map visit during this travel — server pushes `jmw`
            // with `ekry` = newly-loaded mapId on every map transition.
            // Two oscillation modes detected:
            //   (a) Cross-map ping-pong: same mapId visited 3+ times via jmw
            //   (b) On-map stall: stuck on the same mapId > STUCK_ON_MAP_MS
            //       while iri/isu packets keep firing (= moving in circles
            //       intra-map, e.g. building entrance with no map change)
            const STUCK_ON_MAP_MS = 30000;
            const mapVisits = new Map<number, number>();
            let oscillationDetected = false;
            let oscillatingMapId = 0;
            let currentMapEnteredAt = Date.now();
            let currentMapInTravel = -1;
            const moveUnsub = onWsEvent((ev) => {
                if (ev.type !== "message") return;
                const m = (ev as any).message;
                if (m?.type !== "send") return;
                const p = m.payload;
                if (!p) return;
                if (p.type === "socket" && p.direction === "out" && (p.cls === "iri" || p.cls === "isu" || p.cls === "isp")) {
                    lastMovement = Date.now();
                }
                if (p.type === "socket" && p.cls === "jmw") {
                    const mid = Number(p.fields?.ekry ?? 0);
                    if (mid > 0) {
                        const n = (mapVisits.get(mid) ?? 0) + 1;
                        mapVisits.set(mid, n);
                        currentMapInTravel = mid;
                        currentMapEnteredAt = Date.now();
                        if (n >= OSCILLATION_THRESHOLD && mid !== target.mapId) {
                            oscillationDetected = true;
                            oscillatingMapId = mid;
                        }
                    }
                }
            });
            outerWait: while (Date.now() < totalDeadline && !abortCurrentTravel) {
                const remaining = Math.min(STALL_MS, totalDeadline - Date.now());
                const arrived = await cleanBarrier.wait(remaining);
                if (arrived === "event") { arrivedOk = true; break outerWait; }
                if (abortCurrentTravel) break outerWait;
                // Also catch on-map stall: stuck on same mapId for >30s while
                // movement packets keep firing (intra-map circle, no jmw).
                if (!oscillationDetected
                    && currentMapInTravel > 0 && currentMapInTravel !== target.mapId
                    && Date.now() - currentMapEnteredAt > STUCK_ON_MAP_MS
                    && Date.now() - lastMovement < 5000) {
                    oscillationDetected = true;
                    oscillatingMapId = currentMapInTravel;
                    logRpcLine(`[plan] on-map stall on ${currentMapInTravel} (${Math.round((Date.now() - currentMapEnteredAt) / 1000)}s with movements but no progress)`);
                }
                // Oscillation unsticker: same mapId visited 3+ times → bbd is
                // ping-ponging the player. Abort, route to a NEIGHBOR map (one
                // we haven't been bouncing on), wait arrival, then retry the
                // original target. Resets the visit counter so a re-trigger
                // doesn't immediately fire again.
                if (oscillationDetected && oscillationFixes < MAX_OSCILLATION_FIXES) {
                    oscillationFixes++;
                    const stuck = oscillatingMapId;
                    logRpcLine(`[plan] oscillation on ${stuck} (visited ${mapVisits.get(stuck)}x) → unsticking via neighbor (fix ${oscillationFixes}/${MAX_OSCILLATION_FIXES})`);
                    setPhase("traveling", `unstick oscillation on ${stuck}`);
                    try { await rpcCall<any>("abortAutoTravel", []); } catch {}
                    try {
                        const nb = await rpcCall<any>("getNeighborMapIds", [stuck]);
                        const candidates: number[] = (nb?.neighbors ?? [])
                            .filter((mid: number) => (mapVisits.get(mid) ?? 0) < 2 && mid !== target.mapId);
                        const neighborMid = candidates[0];
                        if (neighborMid) {
                            try { await rpcCall<any>("probeStaticField", ["foz", "dpgi", true]); } catch {}
                            try { await rpcCall<any>("probeFozCts", [0]); } catch {}
                            await rpcCall<any>("autoTravelInstant", [neighborMid]);
                            // Wait up to 20s for the player to land on neighbor
                            const t0 = Date.now();
                            while (Date.now() - t0 < 20000) {
                                await new Promise(r => setTimeout(r, 600));
                                const cur = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
                                if (cur === neighborMid) break;
                            }
                            logRpcLine(`[plan] reached neighbor ${neighborMid} → re-fire bbd to original ${target.mapId}`);
                        } else {
                            logRpcLine(`[plan] no usable neighbor for ${stuck} — giving up`);
                            break outerWait;
                        }
                    } catch (err) {
                        logRpcLine(`[plan] oscillation fix threw: ${String(err).slice(0, 100)}`);
                    }
                    // Reset detection so a new bounce can be caught later
                    oscillationDetected = false;
                    mapVisits.clear();
                    currentMapEnteredAt = Date.now();
                    try { await rpcCall<any>("probeStaticField", ["foz", "dpgi", true]); } catch {}
                    try { await rpcCall<any>("probeFozCts", [0]); } catch {}
                    try { await rpcCall<any>("autoTravelInstant", [target.mapId]); } catch {}
                    lastMovement = Date.now();
                    continue;
                }
                // Timed out the slice — was it a stall (no movement) or just slow?
                if (Date.now() - lastMovement >= STALL_MS) {
                    if (retries >= MAX_RETRIES) {
                        logRpcLine(`[plan] gave up on ${target.mapId} after ${retries} retries`);
                        break outerWait;
                    }
                    retries++;
                    logRpcLine(`[plan] stall on ${target.mapId} → retry bbd (${retries}/${MAX_RETRIES})`);
                    setPhase("traveling", `re-bbd → ${target.mapId} (retry ${retries}/${MAX_RETRIES})`);
                    // Same Tier 1 defensive cleanup as the initial bbd above.
                    try { await rpcCall<any>("probeStaticField", ["foz", "dpgi", true]); } catch {}
                    try { await rpcCall<any>("probeFozCts", [0]); } catch {}
                    try { await rpcCall<any>("autoTravelInstant", [target.mapId]); } catch {}
                    lastMovement = Date.now();  // give it another STALL_MS to react
                }
                // else: movement is happening, just hasn't arrived yet — loop and wait more
            }
            moveUnsub();
            clearTimeout(totalTimer);
            cleanBarrier.cancel();  // tear down the autopilot-done listener (was leaking on success path)
            if (!arrivedOk) {
                try { await rpcCall<any>("abortAutoTravel", []); } catch {}
                return abortCurrentTravel ? "skip" : "fail";
            }
        }

        // Waypoint maps in ordered-plan mode are transit-only — skip capture.
        if (target.isWaypoint) {
            setPhase("done", `traversed waypoint ${target.mapId}`);
            return "ok";
        }
        setPhase("capturing", `mapId ${target.mapId}`);
        // Wait 2s after arrival so the new map has time to load its interactives
        // (server pushes the StatedMapUpdateEvent ~100-500ms after tkl). User
        // observed captureCurrentMap firing too early and missing gfxIds.
        await new Promise(r => setTimeout(r, 2000));
        try {
            const cap = await captureCurrentMap();
            if (!cap) return "fail";
            for (const g of cap.gfxIds) captured.add(g);
            return "ok";
        } catch (e) {
            logRpcLine(`[plan] cap err: ${String(e).slice(0, 80)}`);
            return "fail";
        }
    }

    // ============================================================
    //  Smart path runner — popularity scoring, proximity-greedy,
    //  zaap-bridge inserted only for individually unreachable targets.
    // ============================================================

    async function loadAdaptiveData(): Promise<void> {
        adStatusEl.textContent = "loading worldgraph + plan + zaaps…";
        const [wgJson, planJson, zaapsRsp] = await Promise.all([
            fetch("/api/worldgraph").then(r => r.ok ? r.json() : null).catch(() => null),
            fetch("/api/resource-plan").then(r => r.ok ? r.json() : null).catch(() => null),
            rpcCall<any>("listKnownZaaps", []).catch(() => null),
        ]);
        if (!wgJson || !wgJson.adjacency || !wgJson.uidToMapId) {
            adStatusEl.textContent = "no worldgraph dump — open Map tab → reachability → REFRESH";
            adGraph = null; return;
        }
        adGraph = loadWorldGraphFromJson(wgJson);
        adMapMeta = new Map();
        for (const m of (planJson?.maps ?? [])) {
            adMapMeta.set(m.mapId, {
                posX: m.posX, posY: m.posY, worldMap: m.wm, subAreaId: m.subAreaId,
            });
        }
        for (const mid of adGraph.mapIdToUids.keys()) {
            if (!adMapMeta.has(mid)) {
                adMapMeta.set(mid, { posX: 0, posY: 0, worldMap: 0, subAreaId: 0 });
            }
        }
        adKnownZaaps = [];
        for (const z of (zaapsRsp?.items ?? [])) {
            const mid = Number(z.mapId);
            const meta = adMapMeta.get(mid);
            if (mid > 0 && meta) {
                adKnownZaaps.push({ mapId: mid, posX: meta.posX, posY: meta.posY, wm: meta.worldMap });
            }
        }
        adStatusEl.textContent =
            `loaded: ${adGraph.mapIdToUids.size} maps in graph, ` +
            `${zaapsRsp?.count ?? 0} known zaaps (${adKnownZaaps.length} with coords)`;
    }

    function adGetUserWorlds(): Set<number> {
        const s = new Set<number>();
        if (adWm1Cb.checked) s.add(1);
        if (adWmm1Cb.checked) s.add(-1);
        return s;
    }
    function adGetSubareaMode(): "any" | "include" | "exclude" {
        const v = container.querySelector<HTMLInputElement>("input[name=\"cv-ad-sa-mode\"]:checked")?.value;
        return (v === "include" || v === "exclude") ? v : "any";
    }
    function adMatchesFilters(mid: number): boolean {
        const meta = adMapMeta.get(mid);
        if (!meta) return false;
        const worlds = adGetUserWorlds();
        if (worlds.size > 0 && !worlds.has(meta.worldMap)) return false;
        const mode = adGetSubareaMode();
        if (mode === "include" && adSubareaTags.size > 0 && !adSubareaTags.has(meta.subAreaId)) return false;
        if (mode === "exclude" && adSubareaTags.has(meta.subAreaId)) return false;
        return true;
    }

    // Build the smart path. Greedy nearest-actionable-target from current
    // position; when a candidate is not walk-reachable, search the unlock'd
    // zaap network for a zaap whose mapId IS reachable to the candidate;
    // if found, insert openHb → zaap(zaap.mapId) → walk(candidate); if
    // not, drop the candidate as truly unreachable.
    //
    // Reachability cache: zaap mapId → Set<reachable mapId>. Computed once
    // per zaap so the inner loop is O(1) lookups instead of N BFS calls.
    function adBuildPath(startMid: number): {
        steps: PathStep[]; targetCount: number; zaapJumps: number; dropped: number[];
    } {
        const steps: PathStep[] = [];
        const dropped: number[] = [];
        let targetCount = 0;
        let zaapJumps = 0;
        if (!adGraph) return { steps, targetCount, zaapJumps, dropped };

        // Eligible candidate maps (popularity score > 0, matches filters, not visited/failed).
        const remaining = new Map<number, MapEntry>();
        for (const m of mapsArr) {
            if (visitedMaps.has(m.mapId) || failedMaps.has(m.mapId)) continue;
            if (!adMatchesFilters(m.mapId)) continue;
            if (scoreMap(m) <= 0) continue;
            remaining.set(m.mapId, m);
        }

        // Lazy zaap reachability cache — only computed for zaaps actually queried.
        const zaapReach = new Map<number, Set<number>>();
        const reachOfZaap = (mid: number): Set<number> => {
            let s = zaapReach.get(mid);
            if (!s) { s = reachableMidsFrom(mid, adGraph!); zaapReach.set(mid, s); }
            return s;
        };

        let lastPos = startMid;
        const hbMid = Number(adHbMidInput.value) || 0;
        const SAFETY_MAX_ITERS = 5000;
        let iters = 0;
        while (remaining.size > 0 && iters++ < SAFETY_MAX_ITERS) {
            // lastMeta may be missing if the player is in their HB or another
            // instance map not present in the worldgraph. In that case we skip
            // walk-reachability (nothing reachable from outside the graph) and
            // rely on the zaap fallback to route every candidate.
            const lastMeta = adMapMeta.get(lastPos);
            const isOffGraph = !lastMeta || lastMeta.worldMap === 0;
            // Sort by SCORE descending (popularity-weighted new gfx); tie-break
            // by Manhattan ascending. If we're off-graph, distance is
            // meaningless so it just becomes 0 (sort by score only).
            const sorted = [...remaining.values()]
                .map(m => ({
                    m,
                    score: scoreMap(m),
                    dist: lastMeta
                        ? Math.abs(m.posX - lastMeta.posX) + Math.abs(m.posY - lastMeta.posY)
                        : 0,
                }))
                .sort((a, b) => {
                    if (b.score !== a.score) return b.score - a.score;
                    return a.dist - b.dist;
                });
            const reachFromLast = isOffGraph ? new Set<number>() : reachableMidsFrom(lastPos, adGraph);
            // If we're already in HB, skip the openHb step on the first
            // zaap-jump (we're at the zaap). After that first zaap, lastPos
            // is somewhere else in the world, so subsequent zaap jumps
            // correctly emit openHb again.
            const inHbNow = hbMid > 0 && lastPos === hbMid;
            let progressed = false;
            for (const { m: candidate } of sorted) {
                if (reachFromLast.has(candidate.mapId)) {
                    steps.push({ kind: "walk", target: candidate.mapId });
                    steps.push({ kind: "capture", target: candidate.mapId });
                    lastPos = candidate.mapId;
                    remaining.delete(candidate.mapId);
                    targetCount++;
                    progressed = true;
                    break;
                }
                // Not directly reachable — find best zaap that CAN reach it.
                let bestZaap: KnownZaap | null = null;
                let bestZaapDist = Infinity;
                for (const z of adKnownZaaps) {
                    if (adFailedZaaps.has(z.mapId)) continue;  // server-rejected this session
                    if (!reachOfZaap(z.mapId).has(candidate.mapId)) continue;
                    const d = Math.abs(z.posX - candidate.posX) + Math.abs(z.posY - candidate.posY);
                    if (d < bestZaapDist) { bestZaap = z; bestZaapDist = d; }
                }
                if (bestZaap) {
                    // Skip openHb only if we're already standing in our own HB.
                    if (!inHbNow) steps.push({ kind: "openHb" });
                    steps.push({ kind: "zaap", target: bestZaap.mapId });
                    steps.push({ kind: "walk", target: candidate.mapId });
                    steps.push({ kind: "capture", target: candidate.mapId });
                    lastPos = candidate.mapId;
                    remaining.delete(candidate.mapId);
                    targetCount++;
                    zaapJumps++;
                    progressed = true;
                    break;
                }
                // Truly unreachable — drop and try next sorted candidate.
                dropped.push(candidate.mapId);
                remaining.delete(candidate.mapId);
            }
            if (!progressed) break;
        }
        return { steps, targetCount, zaapJumps, dropped };
    }

    function renderPathList(): void {
        if (!adBuiltPath.length) {
            // Even with no path, show captured/failed history if any.
            adRegionsEl.replaceChildren(buildHistoryFragment());
            return;
        }
        const frag = document.createDocumentFragment();
        const head = document.createElement("div");
        head.style.cssText = "color:#9cf; padding:2px 4px; border-bottom:1px solid #222; margin-bottom:2px";
        head.textContent =
            `path: ${adPathStats.targetCount} targets, ${adPathStats.zaapJumps} zaap jumps, ` +
            `${adPathDropped.length} dropped (truly unreachable)  |  ` +
            `captured ${visitedMaps.size}, failed ${failedMaps.size}`;
        frag.appendChild(head);
        // Show 80 surrounding the current step
        const start = Math.max(0, adPathIndex - 5);
        const end = Math.min(adBuiltPath.length, start + 80);
        for (let i = start; i < end; i++) {
            const s = adBuiltPath[i]!;
            const div = document.createElement("div");
            const isCurrent = i === adPathIndex;
            const isDone = i < adPathIndex;
            div.style.cssText = `padding:1px 4px; ${
                isCurrent ? "background:#1a3a1a; color:#fff; border-left:3px solid #4a4" :
                isDone ? "color:#666" : "color:var(--c-label)"
            }`;
            const meta = (s.kind === "walk" || s.kind === "capture" || s.kind === "zaap") && "target" in s
                ? adMapMeta.get(s.target) : null;
            const coord = meta ? ` (${meta.posX},${meta.posY})` : "";
            const lbl =
                s.kind === "walk"    ? `${(i+1).toString().padStart(4)}  walk    → ${s.target}${coord}` :
                s.kind === "capture" ? `${(i+1).toString().padStart(4)}  capture   ${s.target}${coord}` :
                s.kind === "openHb"  ? `${(i+1).toString().padStart(4)}  openHB` :
                                       `${(i+1).toString().padStart(4)}  zaap    → ${(s as any).target}${coord}`;
            div.textContent = lbl;
            frag.appendChild(div);
        }
        if (end < adBuiltPath.length) {
            const div = document.createElement("div");
            div.style.cssText = "padding:1px 4px; color:#666; font-style:italic";
            div.textContent = `… +${adBuiltPath.length - end} more steps`;
            frag.appendChild(div);
        }
        // Append history (captured + failed) below the path steps.
        frag.appendChild(buildHistoryFragment());
        adRegionsEl.replaceChildren(frag);
    }

    function buildHistoryFragment(): DocumentFragment {
        const frag = document.createDocumentFragment();
        const fmtList = (label: string, color: string, set: Set<number>) => {
            if (set.size === 0) return;
            const sec = document.createElement("div");
            sec.style.cssText = `margin-top:6px; padding-top:4px; border-top:1px dashed #333; color:${color}`;
            const head = document.createElement("div");
            head.style.cssText = `padding:1px 4px; font-weight:bold`;
            head.textContent = `${label} (${set.size})`;
            sec.appendChild(head);
            // Most recent first — Set preserves insertion order so reverse
            const arr = [...set].reverse().slice(0, 30);
            for (const mid of arr) {
                const meta = adMapMeta.get(mid);
                const planMap = mapsArr.find(m => m.mapId === mid);
                const sa = planMap ? subareas.get(planMap.subAreaId) : undefined;
                const div = document.createElement("div");
                div.style.cssText = "padding:0px 4px; color:var(--c-label)";
                const coord = meta ? `(${meta.posX.toString().padStart(3)},${meta.posY.toString().padStart(3)})` : "";
                div.textContent = `  ${mid.toString().padStart(10)} ${coord}  ${(sa?.name || "").slice(0, 24)}`;
                sec.appendChild(div);
            }
            if (set.size > 30) {
                const more = document.createElement("div");
                more.style.cssText = "padding:0px 4px; color:#666; font-style:italic";
                more.textContent = `  … +${set.size - 30} more`;
                sec.appendChild(more);
            }
            frag.appendChild(sec);
        };
        fmtList("✓ captured this session", "#6c6", visitedMaps);
        fmtList("✗ failed this session", "#c66", failedMaps);
        return frag;
    }

    async function adRunPath(): Promise<void> {
        if (!adGraph) {
            setPhase("idle", "no worldgraph — click Build path first");
            return;
        }
        try { await rpcCall<any>("installOutgoingHook", [[]]); } catch {}
        try { await rpcCall<any>("hookAutopilotDone", []); } catch {}
        setPhase("init", "path: starting");
        skipBtn.disabled = false;
        await refreshPlayerMapId();

        const BRICK_THRESHOLD = 5;

        while (runRequested && !adAwaitingResume && adPathIndex < adBuiltPath.length) {
            const step = adBuiltPath[adPathIndex]!;
            renderPathList();
            try {
                if (step.kind === "walk") {
                    // Reuse travelAndCapture's machinery but skip its "capture
                    // current map" tail by looking up a planMap stub. travelAndCapture
                    // handles autopilot dispatch + retries + Tier-1 cleanup.
                    const planMap = mapsArr.find(m => m.mapId === step.target);
                    if (!planMap) {
                        // Synthesize a temporary MapEntry so travelAndCapture works
                        const meta = adMapMeta.get(step.target);
                        const tmp: MapEntry = {
                            mapId: step.target,
                            posX: meta?.posX ?? 0, posY: meta?.posY ?? 0,
                            wm: meta?.worldMap ?? 0,
                            subAreaId: meta?.subAreaId ?? 0,
                            subArea: "",
                            gfxIds: [],
                            isWaypoint: true,  // skip capture inside travelAndCapture
                        };
                        setCurrentTarget(tmp, 0);
                        const r = await travelAndCapture(tmp);
                        if (r === "ok") { adPathIndex++; adRegionFailsCount = 0; }
                        else if (r === "skip") {
                            failedMaps.add(step.target);
                            await recomputePathFromHere("user skip");
                        } else {
                            failedMaps.add(step.target);
                            adRegionFailsCount++;
                            if (adRegionFailsCount >= BRICK_THRESHOLD) {
                                pauseForBrick();
                                return;
                            }
                            await recomputePathFromHere("walk fail");
                        }
                    } else {
                        setCurrentTarget(planMap, scoreMap(planMap));
                        const r = await travelAndCapture({ ...planMap, isWaypoint: true });
                        if (r === "ok") { adPathIndex++; adRegionFailsCount = 0; }
                        else if (r === "skip") {
                            failedMaps.add(step.target);
                            await recomputePathFromHere("user skip");
                        } else {
                            failedMaps.add(step.target);
                            adRegionFailsCount++;
                            if (adRegionFailsCount >= BRICK_THRESHOLD) { pauseForBrick(); return; }
                            await recomputePathFromHere("walk fail");
                        }
                    }
                } else if (step.kind === "capture") {
                    setPhase("capturing", `capture ${step.target}`);
                    // Wait 1.5s for map interactives to settle (server StatedMapUpdateEvent).
                    await new Promise(r => setTimeout(r, 1500));
                    try {
                        const cap = await captureCurrentMap();
                        if (cap) {
                            const beforeSize = captured.size;
                            for (const g of cap.gfxIds) captured.add(g);
                            const newGfxCount = captured.size - beforeSize;
                            visitedMaps.add(cap.mapId);
                            pruneCapturedMaps();
                            updateCounters();
                            // Re-render setCurrentTarget so ✓/✗ markers reflect the
                            // newly-captured gfx for the next walk's preview.
                            const planMap = mapsArr.find(m => m.mapId === cap.mapId);
                            if (planMap) setCurrentTarget(planMap, scoreMap(planMap));
                            setPhase("done", `captured ${cap.mapId}: +${newGfxCount} new gfx`);
                        }
                    } catch (e) {
                        logRpcLine(`[path] cap err: ${String(e).slice(0, 80)}`);
                    }
                    adPathIndex++;
                } else if (step.kind === "openHb") {
                    const hbId = Number(adHbIdInput.value);
                    const hbMid = Number(adHbMidInput.value);
                    if (!hbId || !hbMid) {
                        adStatusEl.textContent = "openHb step blocked — fill havre-sac info first";
                        adAwaitingResume = true; adResumeBtn.style.display = ""; return;
                    }
                    setPhase("traveling", `openHb (${hbMid})`);
                    try { await rpcCall<any>("enterHavreSac", [hbId]); } catch (e) {
                        logRpcLine(`[path] enterHavreSac err: ${String(e).slice(0, 80)}`);
                    }
                    const arr = await waitForMapId(hbMid, 10000);
                    if (!arr) {
                        const cur = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
                        if (cur !== hbMid) {
                            await recomputePathFromHere("enterHavreSac arrival timeout");
                            continue;
                        }
                    }
                    adPathIndex++;
                } else if (step.kind === "zaap") {
                    setPhase("traveling", `zaap → ${step.target}`);
                    try { await rpcCall<any>("zaapTeleport", [step.target]); } catch (e) {
                        logRpcLine(`[path] zaapTeleport err: ${String(e).slice(0, 80)}`);
                    }
                    const arr = await waitForMapId(step.target, 10000);
                    if (!arr) {
                        const cur = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
                        if (cur !== step.target) {
                            await recomputePathFromHere("zaap arrival timeout");
                            continue;
                        }
                    }
                    adPathIndex++;
                }
            } catch (e) {
                logRpcLine(`[path] step ${adPathIndex} (${step.kind}) threw: ${String(e).slice(0, 80)}`);
                await recomputePathFromHere("exception in step");
            }
            // No waitIdleAndStable / refreshPlayerMapId here — each step type
            // already handles its own arrival semantics (travelAndCapture does
            // its own settling; openHb/zaap/capture have no autopilot tail to
            // drain; recompute paths read currentPlayerMapId only when needed).
            // 20 RPC polls per step would lag the game.
        }

        skipBtn.disabled = true;
        if (adPathIndex >= adBuiltPath.length) setPhase("done", "path complete");
        else if (!runRequested && !adAwaitingResume) setPhase("stopped", "stopped");
        adStartBtn.textContent = "▶ Start path";
    }

    async function recomputePathFromHere(reason: string): Promise<void> {
        // Refresh once here (caller doesn't poll between steps anymore).
        await refreshPlayerMapId();
        const lastPos = currentPlayerMapId ?? 0;
        if (!lastPos) return;
        logRpcLine(`[path] recomputing from ${lastPos}: ${reason}`);
        const built = adBuildPath(lastPos);
        adBuiltPath = built.steps;
        adPathIndex = 0;
        adPathDropped = built.dropped;
        adPathStats = { targetCount: built.targetCount, zaapJumps: built.zaapJumps };
        renderPathList();
    }

    function pauseForBrick(): void {
        adAwaitingResume = true;
        adResumeBtn.style.display = "";
        setPhase("fail",
            `${adRegionFailsCount} consecutive silent-rejects — suspect Tier-2 brick. ` +
            `Restart Dofus then click RESUME.`);
        skipBtn.disabled = true;
    }

    async function runPlan(): Promise<void> {
        if (!mapsArr.length) { setPhase("idle", "no plan"); return; }
        // Install outgoing packet hook + autopilot completion hook BEFORE the
        // first bbd. Without installOutgoingHook, the WS layer never sees iri
        // events → waitForEngagement always times out → "bbd fail" even when
        // the player is actually moving (the symptom you saw 2026-04-27).
        try { await rpcCall<any>("installOutgoingHook", [[]]); } catch {}
        try { await rpcCall<any>("hookAutopilotDone", []); } catch {}
        setPhase("init", "starting");
        skipBtn.disabled = false;

        await refreshPlayerMapId();
        while (runRequested) {
            const next = pickNext();
            redrawQueue();
            updateCounters();
            if (!next) {
                setPhase("done", "no maps left with new gfx — all reachable coverage done");
                break;
            }
            setCurrentTarget(next.map, next.score);
            const res = await travelAndCapture(next.map);
            if (res === "ok") {
                visitedMaps.add(next.map.mapId);
                const pruned = pruneCapturedMaps();
                const prunedNote = pruned > 0 ? ` (pruned ${pruned} now-redundant maps)` : "";
                setPhase("done", `captured ${next.map.mapId} → ${captured.size - totalCapturedAtStart} new gfx total${prunedNote}`);
            } else if (res === "skip") {
                failedMaps.add(next.map.mapId);
                setPhase("stopped", `user skipped ${next.map.mapId}`);
            } else {
                failedMaps.add(next.map.mapId);
                setPhase("fail", `bbd fail on ${next.map.mapId} — try next-best`);
            }
            // Re-render queue + counters after capture: scores changed (bonus
            // catches), failedMaps grew, player position changed → tie-breakers
            // shift. User wanted live updates between iterations.
            await refreshPlayerMapId();
            redrawQueue();
            updateCounters();
            // Wait until dtt is idle AND position is stable before next bbd —
            // prior autopilot's async tail (tkl, server ack) needs to fully
            // settle, otherwise the next bbd can race it and silent-reject.
            // Replaces the old 250ms blind sleep.
            await waitIdleAndStable();
        }

        skipBtn.disabled = true;
        if (!runRequested) setPhase("stopped", `stopped`);
        startBtn.textContent = "START";
    }

    // ---- wire ----
    extractBtn.addEventListener("click", async () => {
        extractStat.textContent = "extracting (~15s)…";
        try {
            const r = await rpcCall<any>("extractAllCatalogs", []);
            extractStat.textContent = `done: ${JSON.stringify(r.counts).slice(0, 90)}`;
            await loadCatalogs();
        } catch (err) { extractStat.textContent = `err: ${String(err).slice(0, 100)}`; }
    });
    reloadPlanBtn.addEventListener("click", () => { planMode = "scored"; void loadPlan(); });
    const planVariantSelect = container.querySelector<HTMLSelectElement>("#cv-plan-variant")!;
    loadOrderedBtn.addEventListener("click", () => { void loadOrderedPlan(planVariantSelect.value); });

    startBtn.addEventListener("click", () => {
        if (runRequested) {
            runRequested = false;
            abortCurrentTravel = true;
            startBtn.textContent = "stopping…";
            return;
        }
        runRequested = true;
        startBtn.textContent = "STOP";
        runPlan().finally(() => {
            runRequested = false;
            abortCurrentTravel = false;
            startBtn.textContent = "START";
        });
    });

    skipBtn.addEventListener("click", () => {
        abortCurrentTravel = true;
        setPhase("fail", "user skip — picking next-best");
    });

    retryBtn.addEventListener("click", () => {
        const n = failedMaps.size;
        failedMaps = new Set();
        redrawQueue();
        updateCounters();
        setPhase("idle", `cleared ${n} failed maps — they'll be re-tried next pick`);
    });

    // ---- adaptive runner: localStorage persistence + filter wiring ----
    interface AdaptiveCfg {
        worlds: number[];
        subareaMode: "any" | "include" | "exclude";
        subareaIds: number[];
        havreSacId: string;
        havreSacMapId: string;
    }
    const LS_KEY = "cv.adaptive.cfg.v1";
    function loadAdCfg(): AdaptiveCfg {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) return JSON.parse(raw);
        } catch {}
        // Defaults pre-filled with the dev account's HB info — saves a
        // round-trip through the auto-fill workflow on a fresh localStorage.
        // Other accounts: just type your own values (auto-fill button still works).
        return { worlds: [1, -1], subareaMode: "any", subareaIds: [],
                 havreSacId: "72182268199", havreSacMapId: "162791424" };
    }
    function saveAdCfg(): void {
        const cfg: AdaptiveCfg = {
            worlds: [
                ...(adWm1Cb.checked ? [1] : []),
                ...(adWmm1Cb.checked ? [-1] : []),
            ],
            subareaMode: adGetSubareaMode(),
            subareaIds: [...adSubareaTags],
            havreSacId: adHbIdInput.value,
            havreSacMapId: adHbMidInput.value,
        };
        try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
    }
    function renderSubareaTags(): void {
        adSaTags.innerHTML = "";
        for (const id of adSubareaTags) {
            const sa = subareas.get(id);
            const tag = document.createElement("span");
            tag.style.cssText = "background:#1a3a3a; color:#9cc; padding:1px 6px; border-radius:3px; font-size:10px; display:inline-flex; align-items:center; gap:3px";
            tag.textContent = sa?.name ?? `#${id}`;
            const x = document.createElement("button");
            x.textContent = "×";
            x.style.cssText = "background:none; border:none; color:#9cc; cursor:pointer; padding:0 2px; font-size:12px";
            x.onclick = () => { adSubareaTags.delete(id); renderSubareaTags(); saveAdCfg(); renderPathList(); };
            tag.appendChild(x);
            adSaTags.appendChild(tag);
        }
    }
    {
        const cfg = loadAdCfg();
        adWm1Cb.checked = cfg.worlds.includes(1);
        adWmm1Cb.checked = cfg.worlds.includes(-1);
        const modeRadio = container.querySelector<HTMLInputElement>(`input[name="cv-ad-sa-mode"][value="${cfg.subareaMode}"]`);
        if (modeRadio) modeRadio.checked = true;
        for (const id of cfg.subareaIds) adSubareaTags.add(id);
        adHbIdInput.value = cfg.havreSacId;
        adHbMidInput.value = cfg.havreSacMapId;
    }
    adWm1Cb.addEventListener("change", () => { saveAdCfg(); renderPathList(); });
    adWmm1Cb.addEventListener("change", () => { saveAdCfg(); renderPathList(); });
    container.querySelectorAll<HTMLInputElement>("input[name=\"cv-ad-sa-mode\"]").forEach(r =>
        r.addEventListener("change", () => { saveAdCfg(); renderPathList(); }));
    adHbIdInput.addEventListener("change", saveAdCfg);
    adHbMidInput.addEventListener("change", saveAdCfg);
    adSaInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const q = adSaInput.value.trim().toLowerCase();
        if (!q) return;
        for (const [id, sa] of subareas) {
            if ((sa.name ?? "").toLowerCase().includes(q)) {
                adSubareaTags.add(id);
                renderSubareaTags();
                saveAdCfg();
                renderPathList();
                adSaInput.value = "";
                return;
            }
        }
    });

    adComputeBtn.addEventListener("click", async () => {
        await loadAdaptiveData();
        await refreshPlayerMapId();
        if (!adGraph || !currentPlayerMapId) {
            adStatusEl.textContent = "cannot build path: " + (!adGraph ? "no worldgraph" : "no current mapId");
            return;
        }
        const built = adBuildPath(currentPlayerMapId);
        adBuiltPath = built.steps;
        adPathIndex = 0;
        adPathDropped = built.dropped;
        adPathStats = { targetCount: built.targetCount, zaapJumps: built.zaapJumps };
        adStatusEl.textContent =
            `path built: ${built.steps.length} steps, ${built.targetCount} targets, ` +
            `${built.zaapJumps} zaap jumps, ${built.dropped.length} dropped (truly unreachable)`;
        renderPathList();
    });

    adStartBtn.addEventListener("click", () => {
        if (runRequested && planMode === "adaptive") {
            runRequested = false;
            abortCurrentTravel = true;
            adStartBtn.textContent = "stopping…";
            return;
        }
        if (!adGraph) {
            adStatusEl.textContent = "build path first";
            return;
        }
        if (adBuiltPath.length === 0 || adPathIndex >= adBuiltPath.length) {
            // No path or path complete — rebuild from current pos
            (async () => {
                await refreshPlayerMapId();
                if (!currentPlayerMapId) { adStatusEl.textContent = "no current mapId"; return; }
                const built = adBuildPath(currentPlayerMapId);
                adBuiltPath = built.steps;
                adPathIndex = 0;
                adPathDropped = built.dropped;
                adPathStats = { targetCount: built.targetCount, zaapJumps: built.zaapJumps };
                renderPathList();
                if (adBuiltPath.length === 0) {
                    adStatusEl.textContent = "nothing to do — no actionable maps under current filters";
                    return;
                }
                planMode = "adaptive";
                runRequested = true;
                adAwaitingResume = false;
                adResumeBtn.style.display = "none";
                adStartBtn.textContent = "STOP path";
                adRunPath().finally(() => {
                    runRequested = false;
                    abortCurrentTravel = false;
                    adStartBtn.textContent = "▶ Start path";
                });
            })();
            return;
        }
        planMode = "adaptive";
        runRequested = true;
        adAwaitingResume = false;
        adResumeBtn.style.display = "none";
        adStartBtn.textContent = "STOP path";
        adRunPath().finally(() => {
            runRequested = false;
            abortCurrentTravel = false;
            adStartBtn.textContent = "▶ Start path";
        });
    });

    adResumeBtn.addEventListener("click", () => {
        if (!adAwaitingResume) return;
        adAwaitingResume = false;
        adResumeBtn.style.display = "none";
        adRegionFailsCount = 0;
        adFailedZaaps.clear();  // give blacklisted zaaps another chance after manual intervention
        if (planMode === "adaptive" && !runRequested) {
            // Rebuild path from current position to discard whatever was stale.
            (async () => {
                await refreshPlayerMapId();
                if (currentPlayerMapId) {
                    await recomputePathFromHere("resume after pause");
                }
                runRequested = true;
                adStartBtn.textContent = "STOP path";
                adRunPath().finally(() => {
                    runRequested = false;
                    adStartBtn.textContent = "▶ Start path";
                });
            })();
        }
    });

    adHbAutofill.addEventListener("click", async () => {
        // Robust workflow: arm the igd listener BEFORE prompting, so it doesn't
        // matter whether the user is currently in the HB or outside. They press
        // H, the entry-igd packet fires with ecxt=havreSacId; we capture, wait
        // for the map transition to settle, then read getCurrentMapId.
        // Tested 2026-04-27: pressing H while OUTSIDE the HB sends
        // igd{ecxt=havreSacId}, then ~500ms later jmw lands on the HB mapId.
        adStatusEl.textContent =
            "auto-fill: arming igd listener — press H now to enter your haven-bag " +
            "(if already inside, leave then re-enter). Waiting up to 60s…";
        try {
            const captured = await new Promise<number | null>((resolve) => {
                let done = false;
                const timer = setTimeout(() => { if (!done) { done = true; unsub(); resolve(null); } }, 60000);
                const unsub = onWsEvent((ev) => {
                    if (ev.type !== "message") return;
                    const m = (ev as any).message;
                    if (m?.type !== "send") return;
                    const p = m.payload;
                    if (p?.type !== "socket") return;
                    if (p.direction === "out" && p.cls === "igd") {
                        const ecxt = p.fields?.ecxt;
                        if (ecxt !== undefined && ecxt !== null) {
                            done = true; clearTimeout(timer); unsub();
                            resolve(Number(ecxt));
                        }
                    }
                });
            });
            if (captured === null) {
                adStatusEl.textContent = "auto-fill timed out — type values manually";
                return;
            }
            adHbIdInput.value = String(captured);
            // Give the server time to push jmw with the HB mapId.
            await new Promise(r => setTimeout(r, 1500));
            const mid = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
            if (mid) adHbMidInput.value = String(mid);
            saveAdCfg();
            adStatusEl.textContent = `auto-fill OK: havreSacId=${captured} mapId=${adHbMidInput.value || "?"}`;
        } catch (e) {
            adStatusEl.textContent = `auto-fill error: ${String(e).slice(0, 100)}`;
        }
    });

    // Live debug state poller DISABLED (user request 2026-04-27) — was running
    // every 2.5s and adding constant main-thread RPC pressure during runs.
    // The autopilot debug panel in the Map tab provides on-demand inspection.
    debugStateEl.textContent = "(live polling disabled — use the Map tab autopilot debug panel for on-demand state)";

    // initial
    void loadCatalogs().then(() => renderSubareaTags());
    void loadPlan();
    // Ensure outgoing hook is live so adaptive auto-fill can catch igd
    // and travelAndCapture can see iri/jmw. Idempotent server-side.
    void rpcCall("installOutgoingHook", [[]]).catch(() => {});
}
