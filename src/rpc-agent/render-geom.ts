// Render-geometry introspection for the running Dofus client.
//
// Goal: figure out the EXACT pixel-px-to-world-units ratio Dofus uses to
// project an iso map onto the screen. Compare this to the offline
// renderer's assumed 2080×1107 viewport so we can fix the continuous-region
// renderer's per-map crop bbox (per-map renders currently overlap because
// our crop = camera viewport, not the actual map's tileable extent).
//
// Reads:
//   - Camera.main: orthographicSize, pixelWidth/Height, transform position
//   - All Camera instances (in case main camera tag isn't set)
//   - MapRenderer transform + bounds (from Il2Cpp singletons we already
//     locate in mapstate.ts)
//   - The first sortable element's world position to triangulate the
//     map-coord-to-world-unit mapping.
//
// All reads happen in the Unity main thread (via scheduleMainThread)
// because Camera/Transform getters cross into Unity's render loop.
import "frida-il2cpp-bridge";
import { findClassExact as findClass } from "../lib/search";
import { scheduleMainThread } from "./sender";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

interface Vec3 { x: number; y: number; z: number; }

function readVec3(v: any): Vec3 | null {
    if (!v) return null;
    try {
        return {
            x: Number(v.field("x").value),
            y: Number(v.field("y").value),
            z: Number(v.field("z").value),
        };
    } catch { return null; }
}

// Reads a UnityEngine.Vector3 returned by-value from a method. The
// frida-il2cpp-bridge handles structs as Il2Cpp.ValueType; .field() works
// the same way on a struct value as on an Object's struct field.
function readVec3Value(v: any): Vec3 | null {
    if (!v) return null;
    try {
        return {
            x: Number(v.field("x").value),
            y: Number(v.field("y").value),
            z: Number(v.field("z").value),
        };
    } catch { return null; }
}

interface CameraInfo {
    orthographic: boolean;
    orthographicSize: number;
    aspect: number;
    pixelWidth: number;
    pixelHeight: number;
    nearClipPlane: number;
    farClipPlane: number;
    fieldOfView: number;
    cullingMask: number;
    enabled: boolean;
    depth: number;
    position: Vec3 | null;
    name: string;
    isMain: boolean;
}

export function getRenderGeometry(): Promise<{
    ok: boolean; reason?: string;
    screen?: { width: number; height: number };
    cameras?: CameraInfo[];
    mainCamera?: CameraInfo;
    // Empirically derived: world-units shown vertically + horizontally.
    derived?: {
        worldUnitsHeight: number;
        worldUnitsWidth: number;
        pixelsPerWorldUnit: number;
    };
    // The Dofus map root if we can find it (Transform of the parent of
    // sortable elements). Useful to know where (0,0) of the map sits.
    mapRoot?: { name: string; position: Vec3 | null; localScale: Vec3 | null } | null;
    // Bounds inferred from sortable element positions (gives the actual
    // tileable extent rather than the 2080×1107 viewport).
    sortableBounds?: { minX: number; maxX: number; minY: number; maxY: number; count: number } | null;
}> {
    return inVm(() => new Promise((resolve) => {
        const cameraKlass = findClass("Camera");
        const screenKlass = findClass("Screen");
        if (!cameraKlass || !screenKlass) {
            resolve({ ok: false, reason: "missing Camera/Screen class" }); return;
        }
        const screenWidth  = screenKlass.methods.find(m => m.isStatic && m.name === "get_width");
        const screenHeight = screenKlass.methods.find(m => m.isStatic && m.name === "get_height");
        const getMain      = cameraKlass.methods.find(m => m.isStatic && m.name === "get_main");

        const scheduled = scheduleMainThread(() => {
            try {
                const sw = Number(screenWidth?.invoke() ?? 0);
                const sh = Number(screenHeight?.invoke() ?? 0);

                const main = getMain ? getMain.invoke() as any : null;
                const mainNotNull = main && (!main.isNull || !main.isNull());
                const mainAddr = mainNotNull ? Number(main.handle ?? 0) : 0;

                const cams = Il2Cpp.gc.choose(cameraKlass);
                const camInfos: CameraInfo[] = [];
                for (const c of cams) {
                    try {
                        const pos = (() => {
                            try {
                                const tr = c.method("get_transform").invoke() as any;
                                if (!tr || (tr.isNull && tr.isNull())) return null;
                                return readVec3Value(tr.method("get_position").invoke());
                            } catch { return null; }
                        })();
                        let name = "";
                        try {
                            const nm = c.method("get_name").invoke();
                            if (nm) name = String(nm).replace(/^"|"$/g, "");
                        } catch {}
                        const info: CameraInfo = {
                            orthographic:     Boolean(c.method("get_orthographic").invoke()),
                            orthographicSize: Number(c.method("get_orthographicSize").invoke()),
                            aspect:           Number(c.method("get_aspect").invoke()),
                            pixelWidth:       Number(c.method("get_pixelWidth").invoke()),
                            pixelHeight:      Number(c.method("get_pixelHeight").invoke()),
                            nearClipPlane:    Number(c.method("get_nearClipPlane").invoke()),
                            farClipPlane:     Number(c.method("get_farClipPlane").invoke()),
                            fieldOfView:      Number(c.method("get_fieldOfView").invoke()),
                            cullingMask:      Number(c.method("get_cullingMask").invoke()),
                            enabled:          Boolean(c.method("get_enabled").invoke()),
                            depth:            Number(c.method("get_depth").invoke()),
                            position:         pos,
                            name,
                            isMain:           Number(c.handle ?? 0) === mainAddr,
                        };
                        camInfos.push(info);
                    } catch {}
                }
                const mainInfo = camInfos.find(c => c.isMain);

                // Empirical derivation from the main ortho camera.
                let derived: any = undefined;
                if (mainInfo && mainInfo.orthographic) {
                    const worldUnitsHeight = mainInfo.orthographicSize * 2;
                    const worldUnitsWidth  = worldUnitsHeight * mainInfo.aspect;
                    const ppu = mainInfo.pixelHeight / worldUnitsHeight;
                    derived = {
                        worldUnitsHeight, worldUnitsWidth, pixelsPerWorldUnit: ppu,
                    };
                }

                // Try to find the map root via MapRenderer.
                let mapRoot: any = null;
                try {
                    const mrKlass = findClass("MapRenderer");
                    if (mrKlass) {
                        const arr = Il2Cpp.gc.choose(mrKlass);
                        if (arr.length) {
                            const mr = arr[0];
                            // Try a transform property on MapRenderer if it's a MonoBehaviour.
                            try {
                                const tr = mr.method("get_transform").invoke() as any;
                                if (tr && !(tr.isNull && tr.isNull())) {
                                    let nm = "";
                                    try { nm = String(mr.method("get_name").invoke()).replace(/^"|"$/g, ""); } catch {}
                                    mapRoot = {
                                        name: nm,
                                        position:   readVec3Value(tr.method("get_position").invoke()),
                                        localScale: readVec3Value(tr.method("get_localScale").invoke()),
                                    };
                                }
                            } catch {}
                        }
                    }
                } catch {}

                resolve({
                    ok: true,
                    screen: { width: sw, height: sh },
                    cameras: camInfos,
                    mainCamera: mainInfo,
                    derived,
                    mapRoot,
                });
            } catch (e) {
                resolve({ ok: false, reason: String(e).slice(0, 200) });
            }
        });
        if (!scheduled) resolve({ ok: false, reason: "main-thread dispatcher unavailable" });
    }));
}

// Walk the Unity scene root to find any GameObject whose name contains
// "map" / "sortable" / etc — useful for locating the actual map render
// hierarchy when MapRenderer's own transform is just a logical parent.
export function dumpMapHierarchy(): Promise<{
    ok: boolean; reason?: string;
    fields?: Array<{ name: string; type: string; value: string }>;
    childTree?: any;
}> {
    return inVm(() => new Promise((resolve) => {
        const scheduled = scheduleMainThread(() => {
            try {
                const mrKlass = findClass("MapRenderer");
                if (!mrKlass) { resolve({ ok: false, reason: "no MapRenderer class" }); return; }
                const arr = Il2Cpp.gc.choose(mrKlass);
                if (!arr.length) { resolve({ ok: false, reason: "no MapRenderer instance" }); return; }
                const mr = arr[0];

                // Dump all fields and their (compact) values.
                const fields: Array<{ name: string; type: string; value: string }> = [];
                for (const f of mrKlass.fields) {
                    if (f.isStatic) continue;
                    let val = "?";
                    try {
                        const v = mr.field(f.name).value as any;
                        if (v == null) val = "null";
                        else if (typeof v === "object") {
                            try {
                                if (v.isNull && v.isNull()) val = "null";
                                else val = `<${f.type.name} @${v.handle ?? "?"}>`;
                            } catch { val = `<${f.type.name}>`; }
                        } else val = String(v).slice(0, 80);
                    } catch { val = "(read err)"; }
                    fields.push({ name: f.name, type: f.type.name, value: val });
                }

                // Walk transform tree up to depth 4, capturing GameObject names + positions.
                const treeOf = (tr: any, depth: number): any => {
                    if (!tr || (tr.isNull && tr.isNull()) || depth < 0) return null;
                    let name = "";
                    try { name = String(tr.method("get_name").invoke()).replace(/^"|"$/g, ""); } catch {}
                    const pos = readVec3Value(tr.method("get_position").invoke());
                    const localPos = readVec3Value(tr.method("get_localPosition").invoke());
                    const cc = Number(tr.method("get_childCount").invoke());
                    const node: any = { name, pos, localPos, childCount: cc, children: [] };
                    if (depth > 0 && cc > 0) {
                        const limit = Math.min(cc, 50);
                        for (let i = 0; i < limit; i++) {
                            try {
                                const c = tr.method("GetChild").invoke(i);
                                node.children.push(treeOf(c, depth - 1));
                            } catch {}
                        }
                        if (cc > 50) node.children.push({ name: `...(${cc-50} more)`, truncated: true });
                    }
                    return node;
                };

                let childTree: any = null;
                try {
                    const tr = mr.method("get_transform").invoke();
                    childTree = treeOf(tr, 3);
                } catch {}

                resolve({ ok: true, fields, childTree });
            } catch (e) {
                resolve({ ok: false, reason: String(e).slice(0, 200) });
            }
        });
        if (!scheduled) resolve({ ok: false, reason: "main-thread dispatcher unavailable" });
    }));
}

// Sample SpriteRenderer instances active in the scene, recording their
// world bounds. This bypasses MapRenderer's logical hierarchy and reads
// what Unity actually places in world space — useful to detect per-map
// scale/offset that differs from our offline assumption (1204x860 around
// origin). Returns a sample plus aggregated bbox.
export function dumpSpriteRendererBounds(): Promise<{
    ok: boolean; reason?: string;
    count?: number;
    bbox?: { minX: number; maxX: number; minY: number; maxY: number };
    samples?: Array<{ name: string; pos: Vec3; size: { x: number; y: number }; sortingOrder: number }>;
}> {
    return inVm(() => new Promise((resolve) => {
        const scheduled = scheduleMainThread(() => {
            try {
                const srKlass = findClass("SpriteRenderer");
                if (!srKlass) { resolve({ ok: false, reason: "no SpriteRenderer class" }); return; }
                const all = Il2Cpp.gc.choose(srKlass);
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                const samples: any[] = [];
                let visible = 0;
                for (const sr of all) {
                    try {
                        if (!Boolean(sr.method("get_enabled").invoke())) continue;
                        const sprite = sr.method("get_sprite").invoke() as any;
                        if (!sprite || (sprite.isNull && sprite.isNull())) continue;
                        const tr = sr.method("get_transform").invoke() as any;
                        if (!tr || (tr.isNull && tr.isNull())) continue;
                        const pos = readVec3Value(tr.method("get_position").invoke());
                        if (!pos) continue;
                        // Bounds.center + .size give world-space extent.
                        let size = { x: 0, y: 0 };
                        try {
                            const bounds = sr.method("get_bounds").invoke() as any;
                            const sz = bounds.method("get_size").invoke();
                            size = { x: Number(sz.field("x").value), y: Number(sz.field("y").value) };
                        } catch {}
                        let sortingOrder = 0;
                        try { sortingOrder = Number(sr.method("get_sortingOrder").invoke()); } catch {}
                        let name = "";
                        try {
                            const go = sr.method("get_gameObject").invoke() as any;
                            const nm = go.method("get_name").invoke();
                            if (nm) name = String(nm).replace(/^"|"$/g, "");
                        } catch {}
                        if (pos.x < minX) minX = pos.x;
                        if (pos.x > maxX) maxX = pos.x;
                        if (pos.y < minY) minY = pos.y;
                        if (pos.y > maxY) maxY = pos.y;
                        visible++;
                        if (samples.length < 30) samples.push({ name, pos, size, sortingOrder });
                    } catch {}
                }
                if (!visible) { resolve({ ok: false, reason: "no visible SpriteRenderer" }); return; }
                resolve({
                    ok: true,
                    count: visible,
                    bbox: { minX, maxX, minY, maxY },
                    samples,
                });
            } catch (e) {
                resolve({ ok: false, reason: String(e).slice(0, 200) });
            }
        });
        if (!scheduled) resolve({ ok: false, reason: "main-thread dispatcher unavailable" });
    }));
}

// Sample sortable element world positions so we can compare against the
// transforms (m31, m32) stored in the bundle and figure out the
// render-px-per-world-unit conversion. Reads MapRenderer's sortable
// elements via the Unity scene, finds their actual Transform.position,
// and groups by extents to give a tileable bbox.
export function getCurrentMapWorldBounds(): Promise<{
    ok: boolean; reason?: string;
    bounds?: { minX: number; maxX: number; minY: number; maxY: number; count: number };
    samples?: Array<{ name: string; pos: Vec3 }>;
}> {
    return inVm(() => new Promise((resolve) => {
        const scheduled = scheduleMainThread(() => {
            try {
                // The MapRenderer holds references to sortable elements. We
                // walk its transform's children — most are SortableElement
                // GameObjects whose Transform.position is in world units.
                const mrKlass = findClass("MapRenderer");
                if (!mrKlass) { resolve({ ok: false, reason: "no MapRenderer class" }); return; }
                const arr = Il2Cpp.gc.choose(mrKlass);
                if (!arr.length) { resolve({ ok: false, reason: "no MapRenderer instance" }); return; }
                const mr = arr[0];

                let tr: any;
                try { tr = mr.method("get_transform").invoke(); } catch {
                    resolve({ ok: false, reason: "MapRenderer.transform threw" }); return;
                }
                if (!tr || (tr.isNull && tr.isNull())) { resolve({ ok: false, reason: "null transform" }); return; }

                // Walk children; record positions. Transform implements
                // GetChild(int) and childCount.
                const childCount = Number(tr.method("get_childCount").invoke());
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                const samples: Array<{ name: string; pos: Vec3 }> = [];
                let walked = 0;
                for (let i = 0; i < childCount; i++) {
                    try {
                        const child = tr.method("GetChild").invoke(i) as any;
                        if (!child || (child.isNull && child.isNull())) continue;
                        // Recurse one level to catch grouping containers (BG/Sortable/FG).
                        const cName = String(child.method("get_name").invoke()).replace(/^"|"$/g, "");
                        const cCount = Number(child.method("get_childCount").invoke());
                        if (cCount > 0) {
                            for (let j = 0; j < cCount; j++) {
                                try {
                                    const grand = child.method("GetChild").invoke(j) as any;
                                    if (!grand || (grand.isNull && grand.isNull())) continue;
                                    const pos = readVec3Value(grand.method("get_position").invoke());
                                    if (!pos) continue;
                                    walked++;
                                    if (pos.x < minX) minX = pos.x;
                                    if (pos.x > maxX) maxX = pos.x;
                                    if (pos.y < minY) minY = pos.y;
                                    if (pos.y > maxY) maxY = pos.y;
                                    if (samples.length < 12) {
                                        let nm = "";
                                        try { nm = String(grand.method("get_name").invoke()).replace(/^"|"$/g, ""); } catch {}
                                        samples.push({ name: `${cName}/${nm}`, pos });
                                    }
                                } catch {}
                            }
                        } else {
                            const pos = readVec3Value(child.method("get_position").invoke());
                            if (!pos) continue;
                            walked++;
                            if (pos.x < minX) minX = pos.x;
                            if (pos.x > maxX) maxX = pos.x;
                            if (pos.y < minY) minY = pos.y;
                            if (pos.y > maxY) maxY = pos.y;
                            if (samples.length < 12) samples.push({ name: cName, pos });
                        }
                    } catch {}
                }
                if (!walked) { resolve({ ok: false, reason: "no children with positions" }); return; }
                resolve({
                    ok: true,
                    bounds: { minX, maxX, minY, maxY, count: walked },
                    samples,
                });
            } catch (e) {
                resolve({ ok: false, reason: String(e).slice(0, 200) });
            }
        });
        if (!scheduled) resolve({ ok: false, reason: "main-thread dispatcher unavailable" });
    }));
}
