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
        const p = this.parent.get(x);
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
    for (const mid of graph.mapIdToUids.keys()) uf.add(mid);
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
    const groups = new Map<number, number[]>();
    for (const mid of graph.mapIdToUids.keys()) {
        const root = uf.find(mid);
        const list = groups.get(root) ?? [];
        list.push(mid);
        groups.set(root, list);
    }
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

// Directed mapId-level BFS. Mirrors sender.ts:isReachableMapIds — pushes
// ALL uids of a destination map into the frontier (the game treats all
// zone-vertices of a map as one logical node).
export function isReachableMid(
    src: number, dst: number, graph: WorldGraph, maxHops = 9999,
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

// Compute the full set of mapIds reachable from `src` via directed BFS.
// Same algorithm as isReachableMid but returns all visited mapIds. Used by
// the adaptive path builder to memoize reachability per zaap source.
export function reachableMidsFrom(
    src: number, graph: WorldGraph, maxHops = 9999,
): Set<number> {
    const visited = new Set<number>();
    const startUids = graph.mapIdToUids.get(src);
    if (!startUids || startUids.length === 0) return visited;
    visited.add(src);
    let frontier: number[] = [...startUids];
    for (let hop = 0; hop < maxHops; hop++) {
        if (frontier.length === 0) break;
        const next: number[] = [];
        for (const uid of frontier) {
            const dests = graph.adjacency.get(uid) ?? [];
            for (const d of dests) {
                const dm = graph.uidToMapId.get(d);
                if (dm === undefined || visited.has(dm)) continue;
                visited.add(dm);
                const dUids = graph.mapIdToUids.get(dm);
                if (dUids) for (const u of dUids) next.push(u);
            }
        }
        frontier = next;
    }
    return visited;
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
