// JS A* on Dofus's world graph. Sidesteps `bapj` entirely (which blows the
// Frida-thread stack on real searches — see notes in
// src/rpc-agent/plugins/dofus/actions/world-pathfinding.ts).
//
// The graph (vertices + outgoing edges with transitions) is extracted ONCE
// from the game via `extractWorldGraph` (RPC) and cached under
// data/world-graph.json. Subsequent /compute calls hit only this cache and
// the in-process A* below.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_FILE = path.resolve(_MODULE_DIR, "..", "data", "world-graph.json");
const MAPS_INFO_FILE = path.resolve(_MODULE_DIR, "..", "data", "maps-information.json");

export interface Vertex { mapId: string; zoneId: number; uid: string }
export interface Transition {
    cellId: number; direction: number | null; skillId: number;
    transitionMapId: string; type: number; criterion: string | null; id: string;
}
export interface Edge { fromUid: string; toUid: string; transitions: Transition[] }
export interface ExtractedWorldGraph {
    vertices: Record<string, Vertex>;
    outgoing: Record<string, Edge[]>;
    verticesByMap: Record<string, Record<string, string>>;
    counts?: { vertices: number; edges: number; transitions: number };
}

interface MapInfoEntry { mapId: number; posX: number; posY: number; worldMap: number; name: string }

let _graphCache: ExtractedWorldGraph | null = null;
let _mapsByIdCache: Map<number, MapInfoEntry> | null = null;

/** Load the cached graph from disk into memory. Cheap on second call. */
export function loadGraph(): ExtractedWorldGraph | null {
    if (_graphCache) return _graphCache;
    if (!fs.existsSync(GRAPH_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(GRAPH_FILE, "utf-8")) as ExtractedWorldGraph;
    _graphCache = raw;
    return raw;
}

export function saveGraph(g: ExtractedWorldGraph): void {
    fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true });
    fs.writeFileSync(GRAPH_FILE, JSON.stringify(g), "utf-8");
    _graphCache = g;
}

function loadMapsInfo(): Map<number, MapInfoEntry> {
    if (_mapsByIdCache) return _mapsByIdCache;
    const out = new Map<number, MapInfoEntry>();
    if (fs.existsSync(MAPS_INFO_FILE)) {
        const arr = JSON.parse(fs.readFileSync(MAPS_INFO_FILE, "utf-8")) as MapInfoEntry[];
        for (const m of arr) out.set(m.mapId, m);
    }
    _mapsByIdCache = out;
    return out;
}

/** Heuristic — L1 distance between two map positions. Same as DBI's. */
function distance(fromMapId: string, toMapId: string): number {
    const maps = loadMapsInfo();
    const a = maps.get(Number(fromMapId));
    const b = maps.get(Number(toMapId));
    if (!a || !b) return 0;
    return Math.abs(a.posX - b.posX) + Math.abs(a.posY - b.posY);
}

/** Resolve a mapId to a starting vertex UID. Prefers zoneId=1 (most maps
 *  have a single zone numbered 1); falls back to the first zone present. */
export function pickVertexForMap(graph: ExtractedWorldGraph, mapId: string, preferredZone = 1): Vertex | null {
    const byZone = graph.verticesByMap[mapId];
    if (!byZone) return null;
    const preferUid = byZone[String(preferredZone)];
    if (preferUid != null) return graph.vertices[preferUid] ?? null;
    const firstUid = Object.values(byZone)[0];
    return firstUid != null ? graph.vertices[firstUid] ?? null : null;
}

export interface AStarResult {
    /** UIDs forming the shortest path, source → dest inclusive. */
    pathUids: string[];
    /** Number of A* iterations consumed. */
    iterations: number;
    /** True when we hit the iteration cap without converging. */
    exhausted: boolean;
}

/** Plain A* over the extracted graph. Mirrors DBI.PathFinder.Strategies.AStar
 *  closely (open set keyed by node uid, openCosts for g-score, closed set,
 *  parent map, L1 heuristic). MaxIterations matches DBI's value. */
export function aStar(graph: ExtractedWorldGraph, sourceUid: string, targetUid: string, maxIterations = 100_000): AStarResult | null {
    if (sourceUid === targetUid) return { pathUids: [sourceUid], iterations: 0, exhausted: false };
    if (!graph.vertices[sourceUid] || !graph.vertices[targetUid]) return null;

    const targetMapId = graph.vertices[targetUid].mapId;
    const openF = new Map<string, number>();          // uid → f-score (g + h)
    const openG = new Map<string, number>();          // uid → g-score (cost so far)
    const closed = new Set<string>();
    const cameFrom = new Map<string, string>();

    openF.set(sourceUid, distance(graph.vertices[sourceUid].mapId, targetMapId));
    openG.set(sourceUid, 0);

    let iterations = 0;
    while (openF.size > 0 && iterations < maxIterations) {
        // Pick uid with min f-score. O(N) — for graphs ≤ ~15k nodes this is
        // ~ms-fast; a heap is only worth it if profiling demands.
        let curUid: string | null = null;
        let curF = Infinity;
        for (const [uid, f] of openF) {
            if (f < curF) { curF = f; curUid = uid; }
        }
        if (curUid == null) break;

        if (curUid === targetUid) {
            const pathUids: string[] = [curUid];
            while (cameFrom.has(pathUids[0])) pathUids.unshift(cameFrom.get(pathUids[0])!);
            return { pathUids, iterations, exhausted: false };
        }

        openF.delete(curUid);
        closed.add(curUid);
        const curG = openG.get(curUid) ?? 0;

        const outgoing = graph.outgoing[curUid] ?? [];
        for (const edge of outgoing) {
            const nbUid = edge.toUid;
            if (closed.has(nbUid)) continue;
            const tentativeG = curG + 1;
            const knownG = openG.get(nbUid);
            if (knownG != null && knownG <= tentativeG) continue;

            const nbVertex = graph.vertices[nbUid];
            if (!nbVertex) continue;
            openG.set(nbUid, tentativeG);
            openF.set(nbUid, tentativeG + distance(nbVertex.mapId, targetMapId));
            cameFrom.set(nbUid, curUid);
        }
        iterations++;
    }
    return { pathUids: [], iterations, exhausted: iterations >= maxIterations };
}

export interface PathEdgeOut {
    from: Vertex;
    to: Vertex;
    transitions: Transition[];
}

/** Materialize a UID path into the same `PathEdge[]` shape we used to return
 *  from `bapj`. For each consecutive pair, pull the matching outgoing edge. */
export function pathToEdges(graph: ExtractedWorldGraph, pathUids: string[]): PathEdgeOut[] {
    const out: PathEdgeOut[] = [];
    for (let i = 0; i < pathUids.length - 1; i++) {
        const from = graph.vertices[pathUids[i]];
        const to = graph.vertices[pathUids[i + 1]];
        if (!from || !to) continue;
        const outgoing = graph.outgoing[pathUids[i]] ?? [];
        // There can be multiple edges between two vertices (e.g. scroll + walk).
        // We pick the first that targets the right UID — matches the game's
        // own behaviour (it iterates outgoing in order).
        const edge = outgoing.find((e) => e.toUid === pathUids[i + 1]);
        out.push({ from, to, transitions: edge?.transitions ?? [] });
    }
    return out;
}
