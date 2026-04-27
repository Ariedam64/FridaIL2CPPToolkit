# Smart Coverage Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third runner mode `adaptive` to the coverage panel that operates on connected regions of the worldgraph, scores by popularity-weighted gfx coverage, and auto-bridges between regions via haven-bag + zaap.

**Architecture:** A new pure-TS module `regions.ts` provides region computation (union-find on worldgraph adjacency). A new fieldset in `coverage.ts` exposes builder controls (worlds, subareas, havre-sac info) and starts the adaptive runner. The adaptive runner reuses the existing `travelAndCapture` infrastructure but picks targets by `isReachableMid + popularity-weighted score + bubble proximity` within the active region; when the region is exhausted, it bridges via `enterHavreSac → zaapTeleport`.

**Tech Stack:** TypeScript (ES2022, strict, bundler resolution), browser DOM, existing RPC layer (`rpcCall`), existing WS event bus (`onWsEvent`). No new dependencies. No test framework available — verification via in-browser smoke runs of an exported `runSelfTests()` helper.

**Spec:** [`dofus-app/docs/superpowers/specs/2026-04-27-smart-coverage-builder-design.md`](../specs/2026-04-27-smart-coverage-builder-design.md)

---

## File Structure

- **Create:** `dofus-app/public/lib/regions.ts` — pure region engine: types, `loadWorldGraphFromJson`, `computeRegions` (union-find), `regionOf`, `isReachableMid` (directed BFS), `manhattanCenter`, `runSelfTests`. ~250 LOC.
- **Modify:** `dofus-app/public/panels/coverage.ts` — append a new fieldset (Smart Coverage Builder), add `AdaptiveState` type + `runPlanAdaptive` branch + `pickInRegion` + `pickNextRegion` + `bridgeToRegion` + `waitForMapId` helper + havre-sac auto-fill workflow + RESUME button for Tier-2 brick. Existing `scored`/`ordered` modes untouched. ~600 added LOC.
- **No server changes.** No new RPC endpoints. No build pipeline changes.

Build: existing `tsc` compiles `.ts` → `public/dist/*.js`. No bundler involved (browser uses native ES modules).

---

## Task 1: Region engine — types & loadWorldGraphFromJson

**Files:**
- Create: `dofus-app/public/lib/regions.ts`

- [ ] **Step 1: Create the file with type exports and loader**

```ts
// Region engine — pure functions, no DOM, no fetch.
// Operates on the worldgraph adjacency dumped via /api/worldgraph
// (sender.ts:dumpOutgoingEdges). See spec at
// dofus-app/docs/superpowers/specs/2026-04-27-smart-coverage-builder-design.md

export interface WorldGraph {
    adjacency: Map<number, number[]>;     // src uid → dest uids (one-way)
    uidToMapId: Map<number, number>;
    mapIdToUids: Map<number, number[]>;
}

export interface MapMeta {
    posX: number; posY: number; worldMap: number; subAreaId: number;
}

export interface Region {
    id: number;
    mapIds: Set<number>;
    worldMaps: Set<number>;
    subareas: Map<number, number>;   // subAreaId → number of maps in this region
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface WorldGraphJson {
    adjacency: Record<string, number[]>;
    uidToMapId: Record<string, number>;
    vertexCount?: number;
    edgeCount?: number;
    mappedUids?: number;
}

export function loadWorldGraphFromJson(json: WorldGraphJson): WorldGraph {
    const adjacency = new Map<number, number[]>();
    for (const [k, v] of Object.entries(json.adjacency || {})) {
        adjacency.set(Number(k), v);
    }
    const uidToMapId = new Map<number, number>();
    for (const [k, v] of Object.entries(json.uidToMapId || {})) {
        uidToMapId.set(Number(k), Number(v));
    }
    const mapIdToUids = new Map<number, number[]>();
    for (const [uid, mid] of uidToMapId) {
        const list = mapIdToUids.get(mid) ?? [];
        list.push(uid);
        mapIdToUids.set(mid, list);
    }
    return { adjacency, uidToMapId, mapIdToUids };
}
```

- [ ] **Step 2: Type-check**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/lib/regions.ts && git commit -m "feat(coverage): regions.ts skeleton — types + worldgraph loader"
```

---

## Task 2: Region engine — computeRegions (union-find)

**Files:**
- Modify: `dofus-app/public/lib/regions.ts` — append.

- [ ] **Step 1: Add union-find helper and computeRegions**

```ts
// Internal union-find. Keys are mapIds (numbers). All ops idempotent.
class UnionFind {
    private parent = new Map<number, number>();
    private rank = new Map<number, number>();
    add(x: number): void {
        if (!this.parent.has(x)) {
            this.parent.set(x, x);
            this.rank.set(x, 0);
        }
    }
    find(x: number): number {
        let p = this.parent.get(x);
        if (p === undefined) { this.add(x); return x; }
        if (p === x) return x;
        const root = this.find(p);
        this.parent.set(x, root);
        return root;
    }
    union(a: number, b: number): void {
        const ra = this.find(a), rb = this.find(b);
        if (ra === rb) return;
        const rka = this.rank.get(ra)!, rkb = this.rank.get(rb)!;
        if (rka < rkb) this.parent.set(ra, rb);
        else if (rka > rkb) this.parent.set(rb, ra);
        else { this.parent.set(rb, ra); this.rank.set(ra, rka + 1); }
    }
    roots(): Set<number> {
        const out = new Set<number>();
        for (const x of this.parent.keys()) out.add(this.find(x));
        return out;
    }
}

// Compute connected components at the mapId level. Edges are treated as
// UNDIRECTED for region grouping (a one-way edge u→v still puts u and v in
// the same region) — the "region" concept is geographic neighborhood.
// Directed reachability is computed separately via isReachableMid.
export function computeRegions(
    graph: WorldGraph,
    mapMeta: Map<number, MapMeta>,
): Region[] {
    const uf = new UnionFind();
    // Seed every known mapId so isolated maps still get a region.
    for (const mid of graph.mapIdToUids.keys()) uf.add(mid);
    // Union via edges
    for (const [srcUid, dests] of graph.adjacency) {
        const srcMid = graph.uidToMapId.get(srcUid);
        if (srcMid === undefined) continue;
        uf.add(srcMid);
        for (const dUid of dests) {
            const dMid = graph.uidToMapId.get(dUid);
            if (dMid === undefined) continue;
            uf.add(dMid);
            uf.union(srcMid, dMid);
        }
    }
    // Group mapIds by root
    const groups = new Map<number, number[]>();
    for (const mid of graph.mapIdToUids.keys()) {
        const root = uf.find(mid);
        const list = groups.get(root) ?? [];
        list.push(mid);
        groups.set(root, list);
    }
    // Build Region objects, sorted by size desc for stable IDs
    const sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length);
    const regions: Region[] = [];
    sortedGroups.forEach((mids, idx) => {
        const worldMaps = new Set<number>();
        const subareas = new Map<number, number>();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const mid of mids) {
            const meta = mapMeta.get(mid);
            if (!meta) continue;
            worldMaps.add(meta.worldMap);
            subareas.set(meta.subAreaId, (subareas.get(meta.subAreaId) ?? 0) + 1);
            if (meta.posX < minX) minX = meta.posX;
            if (meta.posY < minY) minY = meta.posY;
            if (meta.posX > maxX) maxX = meta.posX;
            if (meta.posY > maxY) maxY = meta.posY;
        }
        if (minX === Infinity) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
        regions.push({
            id: idx, mapIds: new Set(mids),
            worldMaps, subareas, bbox: { minX, minY, maxX, maxY },
        });
    });
    return regions;
}

export function regionOf(mid: number, regions: Region[]): Region | null {
    for (const r of regions) if (r.mapIds.has(mid)) return r;
    return null;
}
```

- [ ] **Step 2: Type-check**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/lib/regions.ts && git commit -m "feat(coverage): computeRegions via union-find on worldgraph adjacency"
```

---

## Task 3: Region engine — isReachableMid + manhattanCenter

**Files:**
- Modify: `dofus-app/public/lib/regions.ts` — append.

- [ ] **Step 1: Add reachability + centroid helpers**

```ts
// Directed mapId-level BFS. Mirrors sender.ts:isReachableMapIds — pushes
// ALL uids of a destination map into the frontier (the game treats all
// zone-vertices of a map as one logical node).
export function isReachableMid(
    src: number, dst: number, graph: WorldGraph, maxHops = 40,
): boolean {
    if (src === dst) return true;
    const startUids = graph.mapIdToUids.get(src);
    if (!startUids || startUids.length === 0) return false;
    const visited = new Set<number>([src]);
    let frontier: number[] = [...startUids];
    for (let hop = 0; hop < maxHops; hop++) {
        if (frontier.length === 0) return false;
        const next: number[] = [];
        for (const uid of frontier) {
            const dests = graph.adjacency.get(uid) ?? [];
            for (const d of dests) {
                const dm = graph.uidToMapId.get(d);
                if (dm === undefined || visited.has(dm)) continue;
                if (dm === dst) return true;
                visited.add(dm);
                const dUids = graph.mapIdToUids.get(dm);
                if (dUids) for (const u of dUids) next.push(u);
            }
        }
        frontier = next;
    }
    return false;
}

export function manhattanCenter(
    region: Region,
    mapMeta: Map<number, MapMeta>,
): { x: number; y: number } {
    let sx = 0, sy = 0, n = 0;
    for (const mid of region.mapIds) {
        const m = mapMeta.get(mid);
        if (!m) continue;
        sx += m.posX; sy += m.posY; n++;
    }
    if (n === 0) return { x: 0, y: 0 };
    return { x: Math.round(sx / n), y: Math.round(sy / n) };
}
```

- [ ] **Step 2: Type-check**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/lib/regions.ts && git commit -m "feat(coverage): isReachableMid + manhattanCenter helpers"
```

---

## Task 4: Region engine — runSelfTests

**Files:**
- Modify: `dofus-app/public/lib/regions.ts` — append.

- [ ] **Step 1: Add self-test runner with three synthetic cases**

```ts
// Browser-callable smoke tests. Open the coverage panel, then in DevTools:
//   import("/dist/lib/regions.js").then(m => m.runSelfTests())
// Logs PASS/FAIL per case to console.
export function runSelfTests(): { passed: number; failed: number; details: string[] } {
    const details: string[] = [];
    let passed = 0, failed = 0;
    const check = (name: string, ok: boolean, info = "") => {
        if (ok) { passed++; details.push(`✓ ${name}`); }
        else { failed++; details.push(`✗ ${name} — ${info}`); }
    };

    // Case 1: two disconnected triangles
    {
        const json: WorldGraphJson = {
            adjacency: {
                "1": [2], "2": [3], "3": [1],
                "4": [5], "5": [6], "6": [4],
            },
            uidToMapId: {
                "1": 100, "2": 101, "3": 102,
                "4": 200, "5": 201, "6": 202,
            },
        };
        const meta = new Map<number, MapMeta>([
            [100, { posX: 0, posY: 0, worldMap: 1, subAreaId: 1 }],
            [101, { posX: 1, posY: 0, worldMap: 1, subAreaId: 1 }],
            [102, { posX: 0, posY: 1, worldMap: 1, subAreaId: 1 }],
            [200, { posX: 10, posY: 10, worldMap: -1, subAreaId: 2 }],
            [201, { posX: 11, posY: 10, worldMap: -1, subAreaId: 2 }],
            [202, { posX: 10, posY: 11, worldMap: -1, subAreaId: 2 }],
        ]);
        const g = loadWorldGraphFromJson(json);
        const r = computeRegions(g, meta);
        check("case1: 2 regions", r.length === 2, `got ${r.length}`);
        check("case1: each region has 3 mapIds",
            r.every(x => x.mapIds.size === 3),
            r.map(x => x.mapIds.size).join(","));
        check("case1: regions split by wm",
            r[0]!.worldMaps.size === 1 && r[1]!.worldMaps.size === 1,
            "");
    }

    // Case 2: two components joined by a one-way edge → 1 region (undirected)
    {
        const json: WorldGraphJson = {
            adjacency: {
                "1": [2],
                "2": [1, 3],            // pair A + bridge A→B (one-way)
                "3": [4],
                "4": [3],               // pair B
            },
            uidToMapId: {
                "1": 100, "2": 101, "3": 200, "4": 201,
            },
        };
        const meta = new Map<number, MapMeta>([
            [100, { posX: 0, posY: 0, worldMap: 1, subAreaId: 1 }],
            [101, { posX: 1, posY: 0, worldMap: 1, subAreaId: 1 }],
            [200, { posX: 5, posY: 5, worldMap: -1, subAreaId: 2 }],
            [201, { posX: 6, posY: 5, worldMap: -1, subAreaId: 2 }],
        ]);
        const g = loadWorldGraphFromJson(json);
        const r = computeRegions(g, meta);
        check("case2: 1 region (one-way bridge unions)", r.length === 1,
            `got ${r.length}`);
        check("case2: region has 4 mapIds",
            r[0]!.mapIds.size === 4, `got ${r[0]?.mapIds.size}`);
        check("case2: region wm = {1, -1}",
            r[0]!.worldMaps.has(1) && r[0]!.worldMaps.has(-1),
            [...r[0]!.worldMaps].join(","));
        check("case2: isReachableMid forward (100→200)",
            isReachableMid(100, 200, g), "BFS should follow 100→101→200");
        check("case2: isReachableMid backward NOT possible (200→100)",
            !isReachableMid(200, 100, g), "no return path through one-way bridge");
    }

    // Case 3: empty graph
    {
        const g = loadWorldGraphFromJson({ adjacency: {}, uidToMapId: {} });
        const r = computeRegions(g, new Map());
        check("case3: 0 regions on empty graph", r.length === 0,
            `got ${r.length}`);
    }

    console.log(`[regions self-test] passed=${passed} failed=${failed}`);
    for (const d of details) console.log("  " + d);
    return { passed, failed, details };
}
```

- [ ] **Step 2: Type-check**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build to public/dist**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc`
Expected: no errors. File `dofus-app/public/dist/lib/regions.js` exists.

- [ ] **Step 4: Run the self-test in browser**

Open the dofus-app in browser (server must be running), open DevTools console, paste:
```js
import("/dist/lib/regions.js").then(m => m.runSelfTests())
```
Expected: `passed=8 failed=0` (all cases green).

- [ ] **Step 5: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/lib/regions.ts && git commit -m "test(coverage): regions.ts self-tests for synthetic adjacency cases"
```

---

## Task 5: Builder UI — fieldset markup + handlers wiring

**Files:**
- Modify: `dofus-app/public/panels/coverage.ts` — insert new fieldset between `catalog + plan` and `runner`, add element handles, add localStorage helpers.

- [ ] **Step 1: Add the fieldset HTML**

In `coverage.ts:renderCoverage`, locate the closing `</fieldset>` of the `catalog + plan` block (around line 63) and insert AFTER it (BEFORE the `runner` fieldset):

```ts
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
              <input type="text" id="cv-ad-sa-input" placeholder="search subarea name…" style="flex:1; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px; padding:2px 4px">
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
              <button id="cv-ad-compute" class="btn">↻ Compute regions</button>
              <button id="cv-ad-start" class="btn primary">▶ Start adaptive</button>
              <button id="cv-ad-resume" class="btn" style="display:none" title="resume after Tier-2 brick or N1 fallback">RESUME</button>
            </div>
            <div id="cv-ad-status" style="font-size:10px; color:var(--c-label); font-family:var(--font-mono); white-space:pre-wrap; margin-bottom:var(--s-1)"></div>
            <div id="cv-ad-regions" style="max-height:160px; overflow:auto; font-family:var(--font-mono); font-size:11px; border-top:1px solid #222; padding-top:var(--s-1)"></div>
          </fieldset>
```

- [ ] **Step 2: Add element handles after the existing handle declarations**

After line `const debugStateEl = container.querySelector<HTMLDivElement>("#cv-debug-state")!;` (currently around line 116), append:

```ts
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
```

- [ ] **Step 3: Add localStorage persistence helpers + load on init**

Just before the `// initial` section near the bottom of `renderCoverage` (around line 869), insert:

```ts
    // ---- adaptive runner config (localStorage-persisted) ----
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
        return { worlds: [1, -1], subareaMode: "any", subareaIds: [],
                 havreSacId: "", havreSacMapId: "" };
    }
    function saveAdCfg(): void {
        const cfg: AdaptiveCfg = {
            worlds: [
                ...(adWm1Cb.checked ? [1] : []),
                ...(adWmm1Cb.checked ? [-1] : []),
            ],
            subareaMode: (container.querySelector<HTMLInputElement>("input[name=\"cv-ad-sa-mode\"]:checked")?.value as any) || "any",
            subareaIds: [...adSubareaTags],
            havreSacId: adHbIdInput.value,
            havreSacMapId: adHbMidInput.value,
        };
        try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
    }
    const adSubareaTags = new Set<number>();
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
            x.onclick = () => { adSubareaTags.delete(id); renderSubareaTags(); saveAdCfg(); };
            tag.appendChild(x);
            adSaTags.appendChild(tag);
        }
    }
    // Restore from localStorage
    {
        const cfg = loadAdCfg();
        adWm1Cb.checked = cfg.worlds.includes(1);
        adWmm1Cb.checked = cfg.worlds.includes(-1);
        const modeRadio = container.querySelector<HTMLInputElement>(`input[name="cv-ad-sa-mode"][value="${cfg.subareaMode}"]`);
        if (modeRadio) modeRadio.checked = true;
        for (const id of cfg.subareaIds) adSubareaTags.add(id);
        adHbIdInput.value = cfg.havreSacId;
        adHbMidInput.value = cfg.havreSacMapId;
        // Tags rendered after catalogs load (in Step 4 of Task 6).
    }
    // Wire change listeners → persist
    adWm1Cb.addEventListener("change", saveAdCfg);
    adWmm1Cb.addEventListener("change", saveAdCfg);
    container.querySelectorAll<HTMLInputElement>("input[name=\"cv-ad-sa-mode\"]").forEach(r =>
        r.addEventListener("change", saveAdCfg));
    adHbIdInput.addEventListener("change", saveAdCfg);
    adHbMidInput.addEventListener("change", saveAdCfg);

    // Subarea autocomplete: show top 8 matches by name as datalist-like.
    // Simple impl: on Enter, find first subarea whose name contains the input
    // text (case-insensitive) and add it as a tag.
    adSaInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const q = adSaInput.value.trim().toLowerCase();
        if (!q) return;
        for (const [id, sa] of subareas) {
            if ((sa.name ?? "").toLowerCase().includes(q)) {
                adSubareaTags.add(id);
                renderSubareaTags();
                saveAdCfg();
                adSaInput.value = "";
                return;
            }
        }
    });
```

- [ ] **Step 4: Add `renderSubareaTags()` call after `loadCatalogs` resolves**

At the bottom, change:
```ts
    void loadCatalogs();
    void loadPlan();
```
to:
```ts
    void loadCatalogs().then(() => renderSubareaTags());
    void loadPlan();
```

- [ ] **Step 5: Type-check + build**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc`
Expected: no errors. (If tsc complains about `noUnusedLocals`, prefix any not-yet-used handles with `_`.)

- [ ] **Step 6: Browser smoke**

Reload the coverage panel. Verify:
- Smart coverage builder fieldset renders.
- Both world checkboxes default checked.
- Type "Astrub" in subarea input, press Enter → tag appears.
- Click × on the tag → tag disappears.
- Reload page → tag persists (proof localStorage works).

- [ ] **Step 7: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/panels/coverage.ts && git commit -m "feat(coverage): smart coverage builder UI fieldset with localStorage persistence"
```

---

## Task 6: Havre-sac auto-fill workflow

**Files:**
- Modify: `dofus-app/public/panels/coverage.ts` — wire the auto-fill button.

- [ ] **Step 1: Implement the auto-fill handler**

Insert just before the `// initial` block (after the localStorage section from Task 5):

```ts
    // Auto-fill workflow: user goes into their haven-bag, clicks the button.
    // Reads getCurrentMapId for havreSacMapId; arms an onWsEvent listener
    // for the next outgoing `igd` packet to capture havreSacId from ecxt.
    adHbAutofill.addEventListener("click", async () => {
        adStatusEl.textContent = "auto-fill: reading current mapId…";
        try {
            const mid = await rpcCall<number>("getCurrentMapId", []);
            if (!mid) { adStatusEl.textContent = "auto-fill failed: no current map"; return; }
            adHbMidInput.value = String(mid);
            adStatusEl.textContent =
                `auto-fill: mapId=${mid} captured. Now press H once (or open hb again) ` +
                `to capture havreSacId via igd packet (waiting up to 30s)…`;
            // Arm listener for igd outgoing packet
            const timeoutMs = 30000;
            const captured = await new Promise<number | null>((resolve) => {
                let done = false;
                const timer = setTimeout(() => { if (!done) { done = true; unsub(); resolve(null); } }, timeoutMs);
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
            if (captured !== null) {
                adHbIdInput.value = String(captured);
                saveAdCfg();
                adStatusEl.textContent = `auto-fill OK: havreSacId=${captured} mapId=${mid}`;
            } else {
                adStatusEl.textContent = `auto-fill timed out — type havreSacId manually`;
            }
        } catch (e) {
            adStatusEl.textContent = `auto-fill error: ${String(e).slice(0, 100)}`;
        }
    });
```

- [ ] **Step 2: Ensure outgoing hook is installed before auto-fill**

The `installOutgoingHook` is currently called inside `runPlan` (line 776). For auto-fill to capture `igd`, the hook must be active. Add a call right after `loadCatalogs().then(...)` in the init block:

Replace:
```ts
    void loadCatalogs().then(() => renderSubareaTags());
    void loadPlan();
```
with:
```ts
    void loadCatalogs().then(() => renderSubareaTags());
    void loadPlan();
    // Ensure outgoing hook is live so auto-fill can catch igd. Idempotent
    // server-side — re-installing while running just rewrites the trace list.
    void rpcCall("installOutgoingHook", [[]]).catch(() => {});
```

- [ ] **Step 3: Type-check + build**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc`
Expected: no errors.

- [ ] **Step 4: Browser smoke**

Reload, ensure Frida is attached. In game, go into haven-bag (press H). In the panel, click `auto-fill`. Status should immediately show the mapId; if you press H again (or exit/re-enter), igd fires and havreSacId fills in.

- [ ] **Step 5: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/panels/coverage.ts && git commit -m "feat(coverage): havre-sac auto-fill via getCurrentMapId + igd packet capture"
```

---

## Task 7: Compute regions button + region list rendering

**Files:**
- Modify: `dofus-app/public/panels/coverage.ts` — wire compute, render regions list. Adds `regions.ts` import.

- [ ] **Step 1: Add the import at top of coverage.ts**

After the existing imports (line 18-20), add:
```ts
import { computeRegions, regionOf, isReachableMid, manhattanCenter,
         loadWorldGraphFromJson, type Region, type WorldGraph,
         type MapMeta } from "../lib/regions.js";
```

- [ ] **Step 2: Add adaptive state declaration**

Right after `let planMode: "scored" | "ordered" = "scored";` (line 143), change to:
```ts
    let planMode: "scored" | "ordered" | "adaptive" = "scored";
    // Adaptive runner state
    let adGraph: WorldGraph | null = null;
    let adRegions: Region[] = [];
    let adMapMeta: Map<number, MapMeta> = new Map();
    let adActiveRegionId: number | null = null;
    let adRegionFails: Map<number, number> = new Map();
    let adAwaitingResume = false;  // N1 fallback or Tier-2 pause
```

- [ ] **Step 3: Implement loadAdaptiveData + compute handler**

Insert before the `adHbAutofill.addEventListener` block:

```ts
    async function loadAdaptiveData(): Promise<void> {
        adStatusEl.textContent = "loading worldgraph + plan…";
        const [wgJson, planJson] = await Promise.all([
            fetch("/api/worldgraph").then(r => r.ok ? r.json() : null).catch(() => null),
            fetch("/api/resource-plan").then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (!wgJson || !wgJson.adjacency || !wgJson.uidToMapId) {
            adStatusEl.textContent = "no worldgraph dump — open Map tab → reachability → REFRESH";
            adGraph = null; adRegions = []; return;
        }
        adGraph = loadWorldGraphFromJson(wgJson);
        // Build map metadata from the resource plan (has all maps with subAreaId)
        adMapMeta = new Map();
        for (const m of (planJson?.maps ?? [])) {
            adMapMeta.set(m.mapId, {
                posX: m.posX, posY: m.posY, worldMap: m.wm, subAreaId: m.subAreaId,
            });
        }
        // Some maps in the worldgraph are not in the resource plan (e.g. instances
        // filtered out at plan-build time). Fill with stubs so regions still build.
        for (const mid of adGraph.mapIdToUids.keys()) {
            if (!adMapMeta.has(mid)) {
                adMapMeta.set(mid, { posX: 0, posY: 0, worldMap: 0, subAreaId: 0 });
            }
        }
        adRegions = computeRegions(adGraph, adMapMeta);
        adStatusEl.textContent = `loaded: ${adGraph.mapIdToUids.size} maps in graph, ${adRegions.length} regions`;
    }

    function adMatchesFilters(mid: number): boolean {
        const meta = adMapMeta.get(mid);
        if (!meta) return false;
        const worlds = new Set<number>([
            ...(adWm1Cb.checked ? [1] : []),
            ...(adWmm1Cb.checked ? [-1] : []),
        ]);
        if (worlds.size > 0 && !worlds.has(meta.worldMap)) return false;
        const mode = container.querySelector<HTMLInputElement>("input[name=\"cv-ad-sa-mode\"]:checked")?.value || "any";
        if (mode === "include" && adSubareaTags.size > 0 && !adSubareaTags.has(meta.subAreaId)) return false;
        if (mode === "exclude" && adSubareaTags.has(meta.subAreaId)) return false;
        return true;
    }

    function adRegionScore(r: Region): { score: number; actionableCount: number } {
        let score = 0, count = 0;
        // Build a quick lookup of plan-map gfxIds for the score
        const planMaps = new Map<number, MapEntry>();
        for (const pm of mapsArr) planMaps.set(pm.mapId, pm);
        for (const mid of r.mapIds) {
            if (visitedMaps.has(mid) || failedMaps.has(mid)) continue;
            if (!adMatchesFilters(mid)) continue;
            const pm = planMaps.get(mid);
            if (!pm) continue;
            const s = scoreMap(pm);
            if (s > 0) { score += s; count++; }
        }
        return { score, actionableCount: count };
    }

    function renderRegionsList(): void {
        if (!adRegions.length) { adRegionsEl.textContent = ""; return; }
        const cur = currentPlayerMapId;
        const curRegion = cur ? regionOf(cur, adRegions) : null;
        const rows: Array<{ region: Region; score: number; count: number; isCurrent: boolean }> = [];
        for (const r of adRegions) {
            // World filter at the region level: skip if NONE of region's wm intersects user's selection
            const userWorlds = new Set<number>([
                ...(adWm1Cb.checked ? [1] : []),
                ...(adWmm1Cb.checked ? [-1] : []),
            ]);
            let intersects = false;
            for (const wm of r.worldMaps) if (userWorlds.has(wm)) { intersects = true; break; }
            if (!intersects && userWorlds.size > 0) continue;
            const { score, actionableCount } = adRegionScore(r);
            rows.push({ region: r, score, count: actionableCount, isCurrent: curRegion?.id === r.id });
        }
        rows.sort((a, b) => b.score - a.score);
        const frag = document.createDocumentFragment();
        for (const row of rows.slice(0, 30)) {
            const r = row.region;
            const wmStr = r.worldMaps.size === 1 ? `wm=${[...r.worldMaps][0]}` : "mixed";
            const div = document.createElement("div");
            div.style.cssText = `padding:2px 4px; ${row.isCurrent ? "background:#1a3a1a; color:#fff; border-left:3px solid #4a4" : "color:var(--c-label)"}`;
            div.textContent = `R${r.id.toString().padStart(2)} ${wmStr.padEnd(7)} ${r.mapIds.size.toString().padStart(5)} maps  Σ=${row.score.toString().padStart(6)}  act=${row.count.toString().padStart(4)}${row.isCurrent ? "  (current)" : ""}`;
            frag.appendChild(div);
        }
        adRegionsEl.replaceChildren(frag);
    }

    adComputeBtn.addEventListener("click", async () => {
        await loadAdaptiveData();
        await refreshPlayerMapId();
        renderRegionsList();
    });

    // Re-render on any filter change
    adWm1Cb.addEventListener("change", () => renderRegionsList());
    adWmm1Cb.addEventListener("change", () => renderRegionsList());
    container.querySelectorAll<HTMLInputElement>("input[name=\"cv-ad-sa-mode\"]").forEach(r =>
        r.addEventListener("change", () => renderRegionsList()));
```

- [ ] **Step 4: Type-check + build**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc`
Expected: no errors.

- [ ] **Step 5: Browser smoke**

Reload coverage panel. Click `Compute regions`. Verify:
- Status shows "loaded: N maps in graph, M regions".
- Region list renders, sorted by Σscore desc.
- The row containing your current map is highlighted with green border-left.
- Toggling wm checkboxes hides/shows regions accordingly.

- [ ] **Step 6: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/panels/coverage.ts && git commit -m "feat(coverage): compute regions + render filtered region list"
```

---

## Task 8: Adaptive runner — pickInRegion, pickNextRegion, runPlanAdaptive

**Files:**
- Modify: `dofus-app/public/panels/coverage.ts` — extend the runner.

- [ ] **Step 1: Add waitForMapId helper**

Insert just before `armCleanIdleBarrier` (around line 440):

```ts
    // Resolve when a `jmw` event reports the current mapId == target.
    // Returns true on match, false on timeout.
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
```

- [ ] **Step 2: Add adaptive picker functions**

Insert just before `function runPlan()` (around line 770):

```ts
    function adPickInRegion(regionId: number): { map: MapEntry; score: number } | null {
        const region = adRegions[regionId];
        if (!region || !adGraph) return null;
        const cur = currentPlayerMapId ?? null;
        const planMapsByMid = new Map<number, MapEntry>();
        for (const pm of mapsArr) planMapsByMid.set(pm.mapId, pm);

        let best: MapEntry | null = null;
        let bestScore = 0;
        let bestKey: [number, number, number, number] = [Infinity, Infinity, Infinity, Infinity];
        for (const mid of region.mapIds) {
            if (visitedMaps.has(mid) || failedMaps.has(mid)) continue;
            if (!adMatchesFilters(mid)) continue;
            const pm = planMapsByMid.get(mid);
            if (!pm) continue;
            const s = scoreMap(pm);
            if (s <= 0) continue;
            if (cur !== null && cur !== mid && !isReachableMid(cur, mid, adGraph)) continue;
            const dist = cur !== null ? Math.abs(pm.posX - (planMapsByMid.get(cur)?.posX ?? 0))
                                      + Math.abs(pm.posY - (planMapsByMid.get(cur)?.posY ?? 0)) : 0;
            const sameWm = cur !== null && (planMapsByMid.get(cur)?.wm === pm.wm) ? 0 : 1;
            const key: [number, number, number, number] = [
                dist <= MAX_HOP ? 0 : 1,
                sameWm,
                dist,
                -s,
            ];
            if (best === null || keyLess(key, bestKey)) {
                best = pm; bestScore = s; bestKey = key;
            }
        }
        return best ? { map: best, score: bestScore } : null;
    }

    function adPickNextRegion(): { region: Region; score: number } | null {
        const userWorlds = new Set<number>([
            ...(adWm1Cb.checked ? [1] : []),
            ...(adWmm1Cb.checked ? [-1] : []),
        ]);
        const candidates: Array<{ region: Region; score: number }> = [];
        for (const r of adRegions) {
            // World filter: skip region if no wm intersects
            let intersects = userWorlds.size === 0;
            for (const wm of r.worldMaps) if (userWorlds.has(wm)) { intersects = true; break; }
            if (!intersects) continue;
            const { score } = adRegionScore(r);
            if (score <= 0) continue;
            candidates.push({ region: r, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0] ?? null;
    }

    function adIsRegionExhausted(regionId: number): boolean {
        return adPickInRegion(regionId) === null;
    }

    async function runPlanAdaptive(): Promise<void> {
        if (!adGraph) {
            setPhase("idle", "no worldgraph — click Compute regions first");
            return;
        }
        try { await rpcCall<any>("installOutgoingHook", [[]]); } catch {}
        try { await rpcCall<any>("hookAutopilotDone", []); } catch {}
        setPhase("init", "adaptive: starting");
        skipBtn.disabled = false;
        await refreshPlayerMapId();

        const BRICK_THRESHOLD = 5;

        while (runRequested && !adAwaitingResume) {
            // Region selection / activation
            await refreshPlayerMapId();
            if (adActiveRegionId === null || adIsRegionExhausted(adActiveRegionId)) {
                const nextR = adPickNextRegion();
                if (!nextR) { setPhase("done", "no region with positive score — done"); break; }
                const curRegion = currentPlayerMapId ? regionOf(currentPlayerMapId, adRegions) : null;
                if (curRegion?.id !== nextR.region.id) {
                    setPhase("traveling", `bridging to region R${nextR.region.id}`);
                    const bridgeRes = await bridgeToRegion(nextR.region.id);
                    if (bridgeRes === "fallback-n1") {
                        adAwaitingResume = true;
                        adResumeBtn.style.display = "";
                        setPhase("stopped", `awaiting manual zaap → click RESUME or change map`);
                        // The arm-resume-listener inside bridgeToRegion will
                        // flip adAwaitingResume = false on jmw to a region-mid.
                        return;
                    }
                }
                adActiveRegionId = nextR.region.id;
                adRegionFails.set(adActiveRegionId, 0);
                renderRegionsList();
            }

            const next = adPickInRegion(adActiveRegionId!);
            if (!next) { adActiveRegionId = null; continue; }

            setCurrentTarget(next.map, next.score);
            const res = await travelAndCapture(next.map);
            if (res === "ok") {
                visitedMaps.add(next.map.mapId);
                adRegionFails.set(adActiveRegionId!, 0);
                pruneCapturedMaps();
                setPhase("done", `captured ${next.map.mapId} in R${adActiveRegionId}`);
            } else if (res === "skip") {
                failedMaps.add(next.map.mapId);
                setPhase("stopped", `skipped ${next.map.mapId}`);
            } else {
                failedMaps.add(next.map.mapId);
                const cur = adRegionFails.get(adActiveRegionId!) ?? 0;
                adRegionFails.set(adActiveRegionId!, cur + 1);
                if (cur + 1 >= BRICK_THRESHOLD) {
                    adAwaitingResume = true;
                    adResumeBtn.style.display = "";
                    setPhase("fail", `R${adActiveRegionId}: ${cur + 1} silent-rejects in a row — suspect Tier-2 brick. Restart Dofus then RESUME.`);
                    return;
                }
                setPhase("fail", `bbd fail on ${next.map.mapId} (R${adActiveRegionId} fails=${cur + 1}/${BRICK_THRESHOLD})`);
            }
            await refreshPlayerMapId();
            renderRegionsList();
            await waitIdleAndStable();
        }

        skipBtn.disabled = true;
        if (!runRequested && !adAwaitingResume) setPhase("stopped", "stopped");
        adStartBtn.textContent = "▶ Start adaptive";
    }
```

- [ ] **Step 3: Wire the Start adaptive button**

Insert near the existing `startBtn.addEventListener` (around line 835):

```ts
    adStartBtn.addEventListener("click", () => {
        if (runRequested && planMode === "adaptive") {
            runRequested = false;
            abortCurrentTravel = true;
            adStartBtn.textContent = "stopping…";
            return;
        }
        if (!adGraph) {
            adStatusEl.textContent = "compute regions first";
            return;
        }
        planMode = "adaptive";
        runRequested = true;
        adAwaitingResume = false;
        adResumeBtn.style.display = "none";
        adStartBtn.textContent = "STOP adaptive";
        runPlanAdaptive().finally(() => {
            runRequested = false;
            abortCurrentTravel = false;
            adStartBtn.textContent = "▶ Start adaptive";
        });
    });

    adResumeBtn.addEventListener("click", () => {
        if (!adAwaitingResume) return;
        adAwaitingResume = false;
        adResumeBtn.style.display = "none";
        if (planMode === "adaptive" && !runRequested) {
            runRequested = true;
            adStartBtn.textContent = "STOP adaptive";
            runPlanAdaptive().finally(() => {
                runRequested = false;
                adStartBtn.textContent = "▶ Start adaptive";
            });
        }
    });
```

- [ ] **Step 4: Add bridgeToRegion stub (will be expanded in Task 9)**

Insert before `runPlanAdaptive`:

```ts
    // Stub — full impl in Task 9. Returns "fallback-n1" for now to exercise
    // the manual-resume path during Step 5 smoke test.
    async function bridgeToRegion(_targetRegionId: number): Promise<"ok" | "fallback-n1"> {
        return "fallback-n1";
    }
```

- [ ] **Step 5: Type-check + build**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc`
Expected: no errors.

- [ ] **Step 6: Browser smoke**

Reload. Click `Compute regions`, then `Start adaptive`. Verify:
- If your current map's region has actionable maps with score > 0, runner walks to one and captures.
- If region is exhausted or you're not in any actionable region, status shows `awaiting manual zaap → click RESUME` (and RESUME button appears).
- Click STOP adaptive, button disables.

- [ ] **Step 7: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/panels/coverage.ts && git commit -m "feat(coverage): adaptive runner mode with region pickers + Tier-2 brick detection"
```

---

## Task 9: Cross-region bridge — full implementation

**Files:**
- Modify: `dofus-app/public/panels/coverage.ts` — replace the bridge stub.

- [ ] **Step 1: Replace the bridge stub with the full sequence**

Replace the `bridgeToRegion` stub from Task 8 with:

```ts
    async function bridgeToRegion(targetRegionId: number): Promise<"ok" | "fallback-n1"> {
        const region = adRegions[targetRegionId];
        if (!region) return "fallback-n1";

        // Pick best zaap dest within target region
        let known: any;
        try { known = await rpcCall<any>("listKnownZaaps", []); }
        catch { return n1Fallback(region, "listKnownZaaps threw"); }
        const items: any[] = known?.items ?? [];
        // Each item shape from sender.ts:listKnownZaaps — try common fields.
        // Filter to zaaps whose mapId is in target region.
        const inRegion = items.filter(z => {
            const mid = Number(z.mapId ?? z.MapId ?? z.m_mapId ?? 0);
            return mid > 0 && region.mapIds.has(mid);
        });
        if (inRegion.length === 0) {
            return n1Fallback(region, "no unlocked zaap in target region");
        }
        // Sort by Manhattan to region centroid
        const center = manhattanCenter(region, adMapMeta);
        inRegion.sort((a, b) => {
            const ax = Number(a.posX ?? a.x ?? 0), ay = Number(a.posY ?? a.y ?? 0);
            const bx = Number(b.posX ?? b.x ?? 0), by = Number(b.posY ?? b.y ?? 0);
            return (Math.abs(ax - center.x) + Math.abs(ay - center.y))
                 - (Math.abs(bx - center.x) + Math.abs(by - center.y));
        });
        const target = inRegion[0];
        const targetMid = Number(target.mapId ?? target.MapId ?? target.m_mapId ?? 0);

        // havreSacInfo required
        const hbId = Number(adHbIdInput.value);
        const hbMid = Number(adHbMidInput.value);
        if (!hbId || !hbMid) {
            return n1Fallback(region, "no havre-sac info — run auto-fill first");
        }

        // 1. enterHavreSac + wait for jmw to hbMid
        setPhase("traveling", `bridge: enterHavreSac(${hbId})`);
        try {
            const r = await rpcCall<any>("enterHavreSac", [hbId]);
            if (r?.ok === false) return n1Fallback(region, `enterHavreSac: ${r.reason}`);
        } catch (e) { return n1Fallback(region, `enterHavreSac threw: ${String(e).slice(0, 60)}`); }
        const arrivedHb = await waitForMapId(hbMid, 10000);
        if (!arrivedHb) {
            // Sometimes jmw fires before we arm — fallback: poll currentMapId once.
            const cur = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
            if (cur !== hbMid) return n1Fallback(region, "did not arrive in haven-bag");
        }

        // 2. zaapTeleport — assumes spawn cell adjacent to zaap. If not,
        //    sender.ts:zaapTeleport returns ok:false with "no zaap on map"
        //    or "not on zaap cell" type reason → N1 fallback.
        setPhase("traveling", `bridge: zaapTeleport(${targetMid})`);
        try {
            const z = await rpcCall<any>("zaapTeleport", [targetMid]);
            if (z?.ok === false) return n1Fallback(region, `zaapTeleport: ${z.reason}`);
        } catch (e) { return n1Fallback(region, `zaapTeleport threw: ${String(e).slice(0, 60)}`); }
        const arrivedTarget = await waitForMapId(targetMid, 10000);
        if (!arrivedTarget) {
            const cur = await rpcCall<number>("getCurrentMapId", []).catch(() => 0);
            if (cur !== targetMid) return n1Fallback(region, "did not arrive at zaap dest");
        }

        return "ok";
    }

    function n1Fallback(region: Region, reason: string): "fallback-n1" {
        const center = manhattanCenter(region, adMapMeta);
        logRpcLine(`[adaptive] bridge fallback-n1: ${reason}`);
        adStatusEl.textContent =
            `cross-region needed (R${region.id} near ${center.x},${center.y}). ` +
            `Reason: ${reason}. Open havre-sac + zaap manually, runner will resume.`;
        // Arm a one-shot listener: when the player lands in target region,
        // flip adAwaitingResume = false and trigger resume button click.
        const unsub = onWsEvent((ev) => {
            if (ev.type !== "message") return;
            const m = (ev as any).message;
            if (m?.type !== "send") return;
            const p = m.payload;
            if (p?.type !== "socket" || p.cls !== "jmw") return;
            const mid = Number(p.fields?.ekry ?? 0);
            if (mid > 0 && region.mapIds.has(mid)) {
                unsub();
                if (adAwaitingResume) {
                    adAwaitingResume = false;
                    adResumeBtn.style.display = "none";
                    if (planMode === "adaptive" && !runRequested) {
                        runRequested = true;
                        adStartBtn.textContent = "STOP adaptive";
                        runPlanAdaptive().finally(() => {
                            runRequested = false;
                            adStartBtn.textContent = "▶ Start adaptive";
                        });
                    }
                }
            }
        });
        return "fallback-n1";
    }
```

- [ ] **Step 2: Type-check + build**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc`
Expected: no errors.

- [ ] **Step 3: Browser smoke (in-game)**

Prerequisites: Frida attached, player has at least one unlocked zaap in another region than the current one, havre-sac info filled in via auto-fill.

Trigger a cross-region scenario: filter to wm=-1 only when you're in wm=1 (or vice versa), Compute regions, Start adaptive. Verify:
- Status logs `bridge: enterHavreSac(...)` then `bridge: zaapTeleport(...)`.
- Player arrives in haven-bag, then teleports to a zaap dest in the target region.
- Runner resumes capture in the new region.

If `zaapTeleport` returns `ok:false` (not on zaap cell), status logs the N1 fallback and you can manually walk to the zaap NPC in your hb + use the zaap → runner auto-resumes on jmw.

- [ ] **Step 4: Commit**

```bash
cd f:/FridaIL2CPPToolkit && git add dofus-app/public/panels/coverage.ts && git commit -m "feat(coverage): cross-region bridge via enterHavreSac + zaapTeleport with N1 fallback"
```

---

## Task 10: Final verification & integration checks

**Files:** none modified.

- [ ] **Step 1: Full type-check**

Run: `cd f:/FridaIL2CPPToolkit/dofus-app && npx tsc`
Expected: zero errors.

- [ ] **Step 2: Regression — scored mode still works**

Reload coverage panel. Click `↻ reload plan`. Click `START` (the original runner button). Verify it picks the same map it would have picked before this PR (high-score map within MAX_HOP bubble).

- [ ] **Step 3: Regression — ordered mode still works**

Click `USE COVERAGE PLAN` with `coverage-plan.json` selected. Click `START`. Verify it walks the static plan order.

- [ ] **Step 4: Adaptive end-to-end**

Click `Compute regions`, `Start adaptive`. Run for ~5 minutes. Verify:
- Captures happen in the current region.
- When region exhausted (or unreachable maps tried), bridge fires automatically.
- `regionFails` count visible in setPhase messages, never reaches 5 unless real bricking.
- STOP adaptive cleanly stops the loop.

- [ ] **Step 5: Self-test re-run**

In DevTools console:
```js
import("/dist/lib/regions.js?t=" + Date.now()).then(m => m.runSelfTests())
```
Expected: passed=8 failed=0.

- [ ] **Step 6: Final commit if any cleanup needed**

If any small fix during smoke testing, commit it:
```bash
cd f:/FridaIL2CPPToolkit && git add -u && git commit -m "fix(coverage): smoke-test fixups for adaptive runner"
```

If nothing to fix, skip this step.

---

## Out of scope (Phase 2+)

- Zaap network as virtual edges in BFS (`computeRegionsWithZaapEdges`).
- Walk-to-cell primitive for cases where haven-bag spawn isn't adjacent to zaap.
- Auto-restart of Dofus / Frida re-attach on Tier-2 brick detection.
- Visual region map in the World tab.
