// Travel features for Dofus Unity IL2CPP + a handful of exploration RPCs.
//
//  autoTravelInstant(mapId)   — delegate to Dofus's native autopilot
//                               (dtt.tkc). Multi-hop BFS, walks, zaaps,
//                               minimap trace — all handled natively.
//  zaapTeleport(mapId)        — iee (open server zaap interaction) then
//                               gyr (request teleport). Requires player
//                               on zaap cell; works for any unlocked
//                               destination on the player's cache list.
//  installOutgoingHook(cls[]) — capture every ecu.xbe send. Pass ["*"]
//                               for backtrace on all, or specific class
//                               names for targeted BT. Also forces
//                               isp.efmg=false to bypass the sub check.
//
// Shared machinery:
//  - Main-thread dispatcher via Interceptor.attach(dtt.tjz). Work queued
//    onto pendingMainWork runs on the Unity main thread.
//  - IL2CPP method-address table for stack-frame → Cls.method+0xoff.
//  - Live-singleton cache to avoid repeat heap scans per call.
import "frida-il2cpp-bridge";

// -----------------------------------------------------------------------------
// Core helpers
// -----------------------------------------------------------------------------

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

// Class lookup — on first miss we build a single index of every class
// across all assemblies (one pass, ~13k classes). Subsequent getClass
// calls are O(1) map lookups. Without this each fresh lookup scans all
// assemblies again, and a cold zaapTeleport that needs 5 distinct names
// (ecu/dun/dbv/iee/dvi) would pay 5 full walks = visible freeze.
let classIndex: Map<string, Il2Cpp.Class> | null = null;

function buildClassIndex(): void {
    if (classIndex) return;
    const m = new Map<string, Il2Cpp.Class>();
    for (const asm of Il2Cpp.domain.assemblies) {
        try { for (const k of asm.image.classes) if (!m.has(k.name)) m.set(k.name, k); } catch {}
    }
    classIndex = m;
    console.log(`[sender] class index built: ${m.size} classes`);
}

function getClass(name: string): Il2Cpp.Class | null {
    if (!classIndex) buildClassIndex();
    return classIndex!.get(name) ?? null;
}

// Read a set of static enum values (e.g. dod.ddas, dod.ddat) as
// Il2Cpp.Object references. Needed because enum fields reject raw ints.
const enumValueCache = new Map<string, Il2Cpp.Object[]>();

function getEnumValues(className: string, valueNames: string[]): Il2Cpp.Object[] | null {
    const key = className + ":" + valueNames.join(",");
    const cached = enumValueCache.get(key);
    if (cached) return cached;
    const k = getClass(className);
    if (!k) return null;
    const out: Il2Cpp.Object[] = [];
    for (const n of valueNames) {
        try { out.push((k.field(n) as any).value); } catch {}
    }
    if (!out.length) return null;
    enumValueCache.set(key, out);
    return out;
}

// Resolve a singleton instance. Tries cached first with a cheap liveness
// probe (reading class name throws on dead handles). Falls back to a full
// `gc.choose` heap scan which is expensive (~100-500ms) but only runs
// once per session for true singletons.
function getLiveSingleton(klass: Il2Cpp.Class, cached: Il2Cpp.Object | null): Il2Cpp.Object | null {
    if (cached) {
        try { if (cached.class && cached.class.name) return cached; } catch {}
    }
    const live = Il2Cpp.gc.choose(klass);
    return live.length ? live[live.length - 1] : null;
}

// -----------------------------------------------------------------------------
// IL2CPP method-address table — resolves raw stack frames back to
// `Cls.method+0xoff`. Built lazily (once per session — ~349k entries).
// -----------------------------------------------------------------------------

interface MethodRef { addrHex: string; cls: string; name: string; }
let methodTable: MethodRef[] = [];

function hexPad(p: NativePointer): string {
    const s = p.toString();
    return (s.startsWith("0x") ? s.slice(2) : s).padStart(16, "0");
}

function buildIl2cppMethodTable(): number {
    if (methodTable.length) return methodTable.length;
    const list: MethodRef[] = [];
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                try {
                    for (const m of k.methods) {
                        try {
                            const va = m.virtualAddress;
                            if (!va || va.isNull()) continue;
                            list.push({ addrHex: hexPad(va), cls: k.name, name: m.name });
                        } catch {}
                    }
                } catch {}
            }
        } catch {}
    }
    list.sort((a, b) => a.addrHex < b.addrHex ? -1 : a.addrHex > b.addrHex ? 1 : 0);
    methodTable = list;
    console.log(`[il2cpp-stack] method table built: ${list.length} entries`);
    return list.length;
}

function resolveFrame(frame: NativePointer): string {
    if (!methodTable.length) return frame.toString();
    const target = hexPad(frame);
    let lo = 0, hi = methodTable.length - 1, best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (methodTable[mid].addrHex <= target) { best = mid; lo = mid + 1; }
        else { hi = mid - 1; }
    }
    if (best < 0) return frame.toString();
    const m = methodTable[best];
    const offset = BigInt("0x" + target) - BigInt("0x" + m.addrHex);
    if (offset < 0n || offset > 0x20000n) return frame.toString() + " (unresolved)";
    return `${m.cls}.${m.name}+0x${offset.toString(16)}`;
}

// -----------------------------------------------------------------------------
// Outgoing hook — ecu.xbe intercept
// -----------------------------------------------------------------------------
// Captures every outgoing IMessage in a ring buffer + broadcasts to the
// host socket panel. Supports:
//  - per-class backtrace capture via trace-class set
//  - "*" wildcard for BT on every message (discovery mode)
//  - isp.efmg=false bypass for non-sub accounts (autopilot fix)
//  - field extraction for low-freq travel messages (jmw/gyr/iee/isp/isl)

const outgoingLog: Array<{ ts: number; cls: string }> = [];
interface StackCapture { ts: number; cls: string; frames: string[]; fields?: Record<string, string>; }
const stackCaptures: StackCapture[] = [];
let traceClsSet = new Set<string>();
let traceAll = false;
let stackCaptureLimit = 60;
let xbeHookInstalled = false;

// High-freq classes (heartbeats / ticks) — skip the IPC `send()` to the
// host so the browser socket panel stays readable. outgoingLog still
// receives them. Override via setSocketBroadcastSkip([...]).
let socketBroadcastSkip = new Set<string>(["jrt", "jly"]);

// Travel/zaap classes whose fields are small and useful — extract and
// include on every broadcast. jmw ekry is load-bearing (UI arrival
// detection). Others are for observability in the socket panel.
const FIELD_EXTRACT_CLASSES = new Set<string>(["gyr", "iee", "isp", "isl"]);

export function setSocketBroadcastSkip(classes: string[]): Promise<{ skip: string[] }> {
    return inVm(() => {
        socketBroadcastSkip = new Set(classes);
        return { skip: [...socketBroadcastSkip] };
    });
}

function snapshotFields(obj: any): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        for (const f of obj.class.fields) {
            if (f.isStatic) continue;
            try {
                const v = obj.field(f.name).value;
                out[f.name] = v === null || v === undefined ? "<null>" : String(v);
            } catch { out[f.name] = "<err>"; }
        }
    } catch {}
    return out;
}

export function installOutgoingHook(traceClsList: string[] = []): Promise<{ ok: boolean; tableSize: number; traced: string[]; all: boolean }> {
    return inVm(() => {
        traceAll = traceClsList.includes("*");
        traceClsSet = new Set(traceClsList.filter(c => c !== "*"));
        stackCaptureLimit = traceAll ? 200 : 60;
        const needTable = traceAll || traceClsSet.size > 0;
        const tableSize = needTable ? buildIl2cppMethodTable() : 0;
        if (xbeHookInstalled) {
            return { ok: true, tableSize, traced: [...traceClsSet], all: traceAll };
        }
        const ecuKlass = getClass("ecu");
        if (!ecuKlass) return { ok: false, tableSize: 0, traced: [], all: false };
        const xbe = ecuKlass.tryMethod("xbe");
        if (!xbe) return { ok: false, tableSize: 0, traced: [], all: false };
        xbe.implementation = function (this: any, ...args: any[]): any {
            const self = this as Il2Cpp.Object;
            let cls = "?";
            try {
                cls = args[0]?.class?.name ?? "?";
                // Non-sub autopilot bypass — server treats the map change
                // as a manual walk when efmg is false.
                if (cls === "isp") {
                    try { args[0].field("efmg").value = false; } catch {}
                }
                outgoingLog.push({ ts: Date.now(), cls });
                if (outgoingLog.length > 200) outgoingLog.shift();

                const fields: Record<string, string> = {};
                if (cls === "jmw") {
                    try { fields.ekry = String(args[0].field("ekry").value); } catch {}
                } else if (FIELD_EXTRACT_CLASSES.has(cls)) {
                    try { Object.assign(fields, snapshotFields(args[0])); } catch {}
                }
                if (!socketBroadcastSkip.has(cls)) {
                    try { send({ type: "socket", direction: "out", cls, name: "?", fullName: "?", fields, ts: Date.now() }); } catch {}
                }
                if (traceAll || traceClsSet.has(cls)) {
                    const bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                    const frames: string[] = [];
                    for (let i = 0; i < Math.min(bt.length, 20); i++) frames.push(resolveFrame(bt[i]));
                    const snap = snapshotFields(args[0]);
                    stackCaptures.push({ ts: Date.now(), cls, frames, fields: snap });
                    if (stackCaptures.length > stackCaptureLimit) stackCaptures.shift();
                    try { send({ type: "out-stack", ts: Date.now(), cls, frames, fields: snap }); } catch {}
                }
            } catch {}
            return self.method("xbe").invoke(...args);
        };
        xbeHookInstalled = true;
        console.log(`[outhook] ecu.xbe installed (trace=[${traceAll ? "*" : [...traceClsSet].join(",")}])`);
        // Pre-warm the live singletons zaapTeleport depends on — each
        // gc.choose is a ~500ms heap scan, and running them here (once,
        // at UI load) avoids the cold-start freeze on the first zaap.
        try {
            const dunK = getClass("dun"); if (dunK) { const l = Il2Cpp.gc.choose(dunK); if (l.length) cachedLiveDun = l[l.length - 1]; }
            const dviK = getClass("dvi"); if (dviK) { const l = Il2Cpp.gc.choose(dviK); if (l.length) cachedLiveDvi = l[l.length - 1]; }
            const el = Il2Cpp.gc.choose(ecuKlass); if (el.length) cachedLiveEcu = el[el.length - 1];
            console.log(`[outhook] pre-warmed live dun/dvi/ecu`);
        } catch (e) { console.log(`[outhook] pre-warm skipped: ${String(e).slice(0, 80)}`); }
        return { ok: true, tableSize, traced: [...traceClsSet], all: traceAll };
    });
}

export function getOutgoingLog(): Promise<Array<{ ts: number; cls: string }>> {
    return inVm(() => [...outgoingLog]);
}
export function clearOutgoingLog(): Promise<number> {
    return inVm(() => { const n = outgoingLog.length; outgoingLog.length = 0; return n; });
}
export function getOutgoingStacks(): Promise<StackCapture[]> {
    return inVm(() => stackCaptures.map(s => ({ ts: s.ts, cls: s.cls, frames: [...s.frames], fields: s.fields ? { ...s.fields } : undefined })));
}
export function clearOutgoingStacks(): Promise<number> {
    return inVm(() => { const n = stackCaptures.length; stackCaptures.length = 0; return n; });
}

// -----------------------------------------------------------------------------
// Main-thread dispatcher
// -----------------------------------------------------------------------------
// `dtt.tjz` is a bool getter the Unity UI polls every frame. By attaching
// Interceptor (not method.implementation — that collides with same-name
// methods via JIT sharing) we get a main-thread tick we can piggyback to
// run IL2CPP work that requires the main thread.

let mainThreadDispatcher: any = null;
let pendingMainWork: (() => void) | null = null;

// Exposed for other modules that need to run IL2CPP work on the Unity
// main thread (e.g. catalog.ts texture export). Chains onto the same
// dtt.tjz interceptor so we don't install multiple.
export function scheduleMainThread(work: () => void): boolean {
    if (!ensureMainThreadDispatcher()) return false;
    const prev = pendingMainWork;
    pendingMainWork = prev ? () => { try { prev(); } catch {} work(); } : work;
    return true;
}

function ensureMainThreadDispatcher(): boolean {
    if (mainThreadDispatcher) return true;
    const dtt = getClass("dtt");
    if (!dtt) return false;
    const tjz = dtt.tryMethod("tjz");
    if (!tjz) return false;
    try {
        mainThreadDispatcher = (Interceptor as any).attach(tjz.virtualAddress, {
            onEnter(this: any, _args: any) {
                if (!pendingMainWork) return;
                const work = pendingMainWork;
                pendingMainWork = null;
                try { work(); }
                catch (e) { console.log(`[main-thread] work threw: ${String(e).slice(0, 120)}`); }
            },
        });
        console.log(`[main-thread] attached to dtt.tjz@${tjz.virtualAddress}`);
        return true;
    } catch (e) { console.log(`[main-thread] attach failed: ${e}`); return false; }
}

// -----------------------------------------------------------------------------
// Native autopilot: autoTravelInstant(mapId)
// -----------------------------------------------------------------------------

let cachedLiveDtt: Il2Cpp.Object | null = null;

function resolveOrSynthesizeDtt(): Il2Cpp.Object | null {
    const dttKlass = getClass("dtt");
    if (!dttKlass) return null;
    // Re-scan every call — dtt instance gets recreated on account switch.
    const live = Il2Cpp.gc.choose(dttKlass);
    if (live.length) { cachedLiveDtt = live[live.length - 1]; return cachedLiveDtt; }
    cachedLiveDtt = null;

    // Synthesize: parameterless ctor + populate service fields by
    // finding a live implementation of each field's interface in the heap.
    let dtt: Il2Cpp.Object;
    try { dtt = (dttKlass as any).new() as Il2Cpp.Object; }
    catch (e) { console.log(`[autopilot] new dtt() throw: ${String(e).slice(0, 120)}`); return null; }
    let populated = 0, failed = 0;
    for (const f of dttKlass.fields) {
        if (f.isStatic) continue;
        const ftype = f.type.name;
        if (ftype.startsWith("System.") && !ftype.startsWith("System.Object")) continue;
        try {
            const tKlass = getClass(ftype);
            if (!tKlass) { failed++; continue; }
            let found = Il2Cpp.gc.choose(tKlass);
            if (!found.length) {
                // Interface type — scan implementations.
                outer: for (const asm of Il2Cpp.domain.assemblies) {
                    try {
                        for (const k of asm.image.classes) {
                            let impls = false;
                            try { for (const iface of (k as any).interfaces ?? []) if (iface.name === ftype) { impls = true; break; } } catch {}
                            if (!impls) continue;
                            try { const insts = Il2Cpp.gc.choose(k); if (insts.length) { found = insts; break outer; } } catch {}
                        }
                    } catch {}
                }
            }
            if (found.length) { dtt.field(f.name).value = found[0] as any; populated++; }
            else failed++;
        } catch { failed++; }
    }
    console.log(`[autopilot] synthetic dtt: populated=${populated}, failed=${failed}`);
    return dtt;
}

export function autoTravelInstant(mapId: number | string): Promise<{ ok: boolean; reason?: string; targetMapId?: number }> {
    return inVm(() => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) return { ok: false, reason: `invalid mapId ${mapId}` };

        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) return { ok: false, reason: "dtt unavailable" };
        const dchKlass = getClass("dch");
        if (!dchKlass) return { ok: false, reason: "dch class not found" };
        if (!ensureMainThreadDispatcher()) return { ok: false, reason: "main-thread dispatcher attach failed" };

        const dttKind = cachedLiveDtt === dtt ? "live" : "synth";
        pendingMainWork = () => {
            try {
                const dch = (dchKlass as any).new();
                dch.field("dbkk").value = mid;
                dch.field("dbkl").value = true;
                try {
                    dtt.method("tkc").invoke(dch);
                    console.log(`[autopilot] tkc(${mid}) on ${dttKind} dtt — ok`);
                } catch (e) {
                    console.log(`[autopilot] tkc(${mid}) on ${dttKind} dtt threw: ${String(e).slice(0, 150)}`);
                }
            } catch (e) { console.log(`[autopilot] dch build throw: ${String(e).slice(0, 120)}`); }
        };
        return { ok: true, targetMapId: mid };
    });
}

// -----------------------------------------------------------------------------
// Native zaap teleport: zaapTeleport(mapId)
// -----------------------------------------------------------------------------
// Reproduces the 2-step handshake Dofus uses when validating a zaap choice
// in the UI:
//   iee (UseInteractive)  — opens the server-side zaap interaction state
//   gyr (TeleportRequest) — picks the destination mapId
//
// Both IDs inside iee (eckt=skill catalog, eckv=element catalog) vary per
// map and are read from the live `dvi` singleton (which holds the current
// map's interactive state). dvi is a session singleton so we cache the
// instance — only its internal dict changes per map load.
//
// The 3 enum fields of gyr (dvdx/dvdz/dved) all hold `gyq.dvdo` in a
// normal zaap→zaap jump. We default to `dod[0]` for dbv's two dod fields.
// Player must be standing on (or adjacent to) the zaap cell, otherwise
// the server silently rejects.

let cachedLiveEcu: Il2Cpp.Object | null = null;
let cachedLiveDun: Il2Cpp.Object | null = null;
let cachedLiveDvi: Il2Cpp.Object | null = null;

// Find the zaap interactive (typeId 16) on the current map. Returns the
// catalog IDs iee expects (confirmed via live capture comparison).
function findCurrentMapZaap(): { elementCatalogId: number; skillCatalogId: number } | null {
    const dviKlass = getClass("dvi");
    if (!dviKlass) return null;
    // Liveness probe on cached instance — dvi is session-lifetime, so
    // this almost always hits without a rescan.
    let candidates: Il2Cpp.Object[];
    if (cachedLiveDvi) {
        try { candidates = (cachedLiveDvi.class && cachedLiveDvi.class.name) ? [cachedLiveDvi] : Il2Cpp.gc.choose(dviKlass); }
        catch { candidates = Il2Cpp.gc.choose(dviKlass); }
    } else {
        candidates = Il2Cpp.gc.choose(dviKlass);
    }
    for (const inst of candidates) {
        try {
            const dict = inst.field("<dexl>k__BackingField").value as any;
            if (!dict) continue;
            const count = Number(dict.field("_count").value);
            if (count <= 0) continue;
            const entries = dict.field("_entries").value as any;
            const N = Math.min(count, (entries && typeof entries.length === "number") ? entries.length : count);
            for (let i = 0; i < N; i++) {
                try {
                    const e = entries.get(i);
                    if (Number(e.field("hashCode").value) < 0) continue;
                    const val = e.field("value").value as any;
                    if (!val) continue;
                    const element = val.field("element").value as any;
                    if (!element) continue;
                    if (Number(element.field("cutn").value) !== 16) continue; // 16 = Zaap
                    const elementCatalogId = Number(element.field("cutm").value);
                    let skillCatalogId = 0;
                    try {
                        const cuto = element.field("cuto").value as any;
                        if (cuto && Number(cuto.method("get_Count").invoke()) > 0) {
                            const dc = cuto.method("get_Item").invoke(0) as any;
                            skillCatalogId = Number(dc.field("cutk").value);
                        }
                    } catch {}
                    if (elementCatalogId && skillCatalogId) {
                        cachedLiveDvi = inst;
                        return { elementCatalogId, skillCatalogId };
                    }
                } catch {}
            }
        } catch {}
    }
    return null;
}

export function zaapTeleport(
    mapId: number | string,
    overrideElementCatalog: number = 0,
    overrideSkillCatalog: number = 0,
    handshakeDelayMs: number = 1500,
): Promise<{ ok: boolean; reason?: string; targetMapId?: number; usedElementId?: number; usedSkillId?: number }> {
    return inVm(async () => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) return { ok: false, reason: `invalid mapId ${mapId}` };

        const ecuKlass = getClass("ecu");
        const dunKlass = getClass("dun");
        const dbvKlass = getClass("dbv");
        const ieeKlass = getClass("iee");
        if (!ecuKlass || !dunKlass || !dbvKlass || !ieeKlass) return { ok: false, reason: "ecu/dun/dbv/iee class not found" };

        const ecu = getLiveSingleton(ecuKlass, cachedLiveEcu);
        const dun = getLiveSingleton(dunKlass, cachedLiveDun);
        if (!ecu) return { ok: false, reason: "no live ecu" };
        if (!dun) return { ok: false, reason: "no live dun" };
        cachedLiveEcu = ecu;
        cachedLiveDun = dun;

        const dods = getEnumValues("dod", ["ddas", "ddat", "ddau", "ddav", "ddaw"]);
        if (!dods) return { ok: false, reason: "dod enum unavailable" };

        // 1. Resolve catalog IDs (caller can override — useful if dvi
        //    hasn't registered the zaap yet, e.g. just after a map load).
        let elementCat = overrideElementCatalog, skillCat = overrideSkillCatalog;
        if (!elementCat || !skillCat) {
            const found = findCurrentMapZaap();
            if (!found) return { ok: false, reason: "no zaap on current map (typeId 16 not in dvi)" };
            if (!elementCat) elementCat = found.elementCatalogId;
            if (!skillCat) skillCat = found.skillCatalogId;
        }

        // 2. Send iee — opens server zaap interaction.
        try {
            const iee = (ieeKlass as any).new();
            iee.field("eckt").value = skillCat;
            iee.field("eckv").value = elementCat;
            ecu.method("xbe").invoke(iee);
        } catch (e) { return { ok: false, reason: `iee send failed: ${String(e).slice(0, 150)}` }; }

        // 3. Wait for server roundtrip — the cdr handler updates dun's
        //    internal state so dun.tri's precondition passes.
        await new Promise<void>((r) => setTimeout(r, handshakeDelayMs));

        // 4. Build dbv + invoke dun.tri — builds gyr internally, sends
        //    via ecu.xbe, server does the actual teleport.
        try {
            const dbv = (dbvKlass as any).new();
            dbv.field("dbkg").value = mid;
            dbv.field("dbkh").value = dods[0] as any;
            dbv.field("dbki").value = dods[0] as any;
            dbv.field("dbkj").value = 0;
            dun.method("tri").invoke(dbv);
            return { ok: true, targetMapId: mid, usedElementId: elementCat, usedSkillId: skillCat };
        } catch (e) { return { ok: false, reason: `dun.tri failed: ${String(e).slice(0, 150)}` }; }
    });
}

// Dump the player's cached zaap destinations (`dun.deor`) — the list the
// server populates on login from the unlocked-zaap table. Each entry is
// a `duk` with mapId at field `denx`.
export function listKnownZaaps(): Promise<{ ok: boolean; count?: number; items?: Array<any>; reason?: string }> {
    return inVm(() => {
        const k = getClass("dun");
        if (!k) return { ok: false, reason: "dun not found" };
        const dun = getLiveSingleton(k, cachedLiveDun);
        if (!dun) return { ok: false, reason: "no live dun" };
        cachedLiveDun = dun;
        try {
            const deor = dun.field("deor").value as any;
            if (!deor) return { ok: true, count: 0, items: [] };
            const n = Number(deor.method("get_Count").invoke());
            const items: any[] = [];
            for (let i = 0; i < n; i++) {
                try {
                    const duk = deor.method("get_Item").invoke(i) as any;
                    items.push({
                        mapId: String(duk.field("denx").value),
                        denz: String(duk.field("denz").value),
                        deoa: Number(duk.field("deoa").value),
                        deob: Number(duk.field("deob").value),
                        deoc: Boolean(duk.field("deoc").value),
                        deoi: Number(duk.field("deoi").value),
                    });
                } catch {}
            }
            return { ok: true, count: n, items };
        } catch (e) { return { ok: false, reason: String(e).slice(0, 120) }; }
    });
}

// -----------------------------------------------------------------------------
// Exploration utilities
// -----------------------------------------------------------------------------

export function describeClass(clsName: string): Promise<{
    cls: string; ns: string; parent: string;
    methods: Array<{ name: string; isStatic: boolean; params: string[]; ret: string; addr: string }>;
    fields: Array<{ name: string; type: string; isStatic: boolean }>;
} | null> {
    return inVm(() => {
        const k = getClass(clsName);
        if (!k) return null;
        return {
            cls: k.name,
            ns: k.namespace ?? "",
            parent: k.parent?.name ?? "",
            methods: k.methods.map(m => {
                let addr = "";
                try { addr = m.virtualAddress.toString(); } catch {}
                return {
                    name: m.name, isStatic: m.isStatic,
                    params: m.parameters.map(p => `${p.name}:${p.type.name}`),
                    ret: m.returnType.name, addr,
                };
            }),
            fields: k.fields.map(f => ({ name: f.name, type: f.type.name, isStatic: f.isStatic })),
        };
    });
}

export function findClassesContaining(
    substrings: string[] = ["Arrow", "Border", "Direction"],
    limit: number = 200,
): Promise<Array<{ cls: string; ns: string; methodCount: number; fieldCount: number }>> {
    return inVm(() => {
        const out: Array<{ cls: string; ns: string; methodCount: number; fieldCount: number }> = [];
        const needles = substrings.map(s => s.toLowerCase());
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (!needles.some(n => k.name.toLowerCase().includes(n))) continue;
                    let mc = 0, fc = 0;
                    try { mc = k.methods.length; } catch {}
                    try { fc = k.fields.length; } catch {}
                    out.push({ cls: k.name, ns: k.namespace ?? "", methodCount: mc, fieldCount: fc });
                    if (out.length >= limit) break;
                }
            } catch {}
            if (out.length >= limit) break;
        }
        out.sort((a, b) => a.cls.localeCompare(b.cls));
        return out;
    });
}

interface ScanHit {
    cls: string; ns: string; parent: string;
    methods: Array<{ name: string; isStatic: boolean; params: string[]; ret: string }>;
    fields: Array<{ name: string; type: string; isStatic: boolean }>;
}

function scanKeywords(keywords: string[]): { matched: ScanHit[] } {
    const matched: ScanHit[] = [];
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                const lower = k.name.toLowerCase();
                if (!keywords.some(n => lower.includes(n))) continue;
                const ns = k.namespace ?? "";
                if (ns.startsWith("System") || ns.startsWith("UnityEngine")
                    || ns.startsWith("TMPro") || ns.startsWith("Mono.")) continue;
                matched.push({
                    cls: k.name, ns, parent: k.parent?.name ?? "",
                    methods: k.methods.map(m => ({
                        name: m.name, isStatic: m.isStatic,
                        params: m.parameters.map(p => p.type.name),
                        ret: m.returnType.name,
                    })),
                    fields: k.fields.map(f => ({ name: f.name, type: f.type.name, isStatic: f.isStatic })),
                });
            }
        } catch {}
    }
    matched.sort((a, b) => a.cls.localeCompare(b.cls));
    return { matched };
}

export function scanArrowCandidates(): Promise<{ matched: ScanHit[] }> {
    return inVm(() => scanKeywords(["arrow", "border", "direction", "mapchange", "transition", "cellchange"]));
}

export function scanZaapCandidates(): Promise<{ matched: ScanHit[] }> {
    return inVm(() => scanKeywords(["zaap", "teleport", "hyperlink", "subway", "zaapi", "warp"]));
}

// -----------------------------------------------------------------------------
// Wide-net call-chain tracer
// -----------------------------------------------------------------------------
// Used during reverse engineering to identify the "voyager" handler
// (dtt.tkc). Kept for future exploration of other game systems — same
// pattern works for inventory, fights, etc.

interface AutopilotHit { ts: number; method: string; args: string[]; edgesSize?: number; }
const autopilotHits: AutopilotHit[] = [];
let autopilotHooked = false;

export function hookAutopilot(): Promise<{ ok: boolean; hooked: string[]; reason?: string }> {
    return inVm(() => {
        if (autopilotHooked) return { ok: true, hooked: [], reason: "already hooked" };
        const hooked: string[] = [];
        const IGNORE = new Set(["dtt.tjz", "foz.bgtw", "foz.bgtv"]);
        const hookAll = (klassName: string) => {
            const klass = getClass(klassName);
            if (!klass) return;
            for (const m of klass.methods) {
                if (m.name.startsWith(".") || m.name === "ToString" || m.name === "Equals"
                    || m.name === "GetHashCode" || m.name === "GetType") continue;
                const tag = klassName + "." + m.name;
                if (IGNORE.has(tag)) continue;
                try {
                    m.implementation = function (this: any, ...args: any[]): any {
                        const self = this as Il2Cpp.Object;
                        const argsStr: string[] = [];
                        let edgesSize: number | undefined;
                        try {
                            for (const a of args) {
                                if (a == null) { argsStr.push("null"); continue; }
                                if (typeof a === "object" && a.class) {
                                    const cn = a.class.name;
                                    if (/^List/.test(cn)) {
                                        try {
                                            const n = Number(a.method("get_Count").invoke());
                                            if (edgesSize === undefined) edgesSize = n;
                                            argsStr.push(`${cn}[${n}]`);
                                        } catch { argsStr.push(cn); }
                                    } else argsStr.push(cn);
                                } else argsStr.push(String(a).slice(0, 22));
                            }
                        } catch {}
                        autopilotHits.push({ ts: Date.now(), method: tag, args: argsStr, edgesSize });
                        if (autopilotHits.length > 500) autopilotHits.shift();
                        if (m.isStatic) return (klass as any).method(m.name).invoke(...args);
                        return self.method(m.name).invoke(...args);
                    };
                    hooked.push(tag);
                } catch {}
            }
        };
        for (const c of ["eli", "foz", "elf", "elg", "dtt", "eld", "cod"]) hookAll(c);
        autopilotHooked = true;
        console.log(`[autopilot] traced ${hooked.length} methods`);
        return { ok: true, hooked: [`${hooked.length} methods`] };
    });
}

export function getAutopilotHits(): Promise<AutopilotHit[]> {
    return inVm(() => autopilotHits.map(h => ({ ...h })));
}
export function clearAutopilotHits(): Promise<number> {
    return inVm(() => { const n = autopilotHits.length; autopilotHits.length = 0; return n; });
}
