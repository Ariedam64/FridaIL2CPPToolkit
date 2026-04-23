// Autopilot-native travel + a handful of IL2CPP exploration RPCs.
//
// The travel feature delegates entirely to Dofus's native autopilot:
// - `autoTravelInstant(mapId)` schedules a call to `dtt.tkc(dch{mapId, true})`
//   on the Unity main thread. tkc is the handler behind the in-game
//   context-menu's "Voyager jusqu'à cette position" button, and invokes
//   the game's full multi-hop travel chain (BFS, per-hop pathfinder, walk,
//   zaaps, blue-line minimap trace).
// - Main-thread dispatch is achieved by `Interceptor.attach`-ing
//   `dtt.tjz` — a boolean getter polled every frame by the UI from the
//   main thread. Our onEnter observer runs pending work on that thread.
// - If no live dtt instance is found (player never opened the worldmap
//   this session), a synthetic one is constructed via the parameterless
//   ctor with its service fields populated from live heap instances.
//
// Debug/exploration exports kept: installOutgoingHook (socket-panel hook
// + auto-isp ARM-BT), hookAutopilot (trace all eli/foz/elg/dtt method
// calls during a native autopilot run), describeClass, findClassesContaining,
// scanArrowCandidates.
import "frida-il2cpp-bridge";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function findClassByName(name: string): Il2Cpp.Class | null {
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                if (k.name === name) return k;
            }
        } catch {}
    }
    return null;
}

// -----------------------------------------------------------------------------
// IL2CPP method-address table — resolves raw stack-frame addresses back to
// `Cls.method+0xoff`. Built lazily, used by the ecu.xbe backtrace capture.
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
// ecu.xbe hook — ring-buffers every outgoing IMessage class name, and
// emits a {type:"socket", direction:"out", cls} event for the UI's socket
// panel. Optionally resolves a backtrace for messages whose class matches
// a trace filter (used by the ARM BT debug button).
// -----------------------------------------------------------------------------

const outgoingLog: Array<{ ts: number; cls: string }> = [];
interface StackCapture { ts: number; cls: string; frames: string[]; fields?: Record<string, string>; }
const stackCaptures: StackCapture[] = [];
let traceClsSet = new Set<string>();
let xbeHookInstalled = false;

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

export function installOutgoingHook(traceClsList: string[] = []): Promise<{ ok: boolean; tableSize: number; traced: string[] }> {
    return inVm(() => {
        if (xbeHookInstalled) {
            traceClsSet = new Set(traceClsList);
            const tableSize = traceClsSet.size > 0 ? buildIl2cppMethodTable() : 0;
            return { ok: true, tableSize, traced: [...traceClsSet] };
        }
        traceClsSet = new Set(traceClsList);
        const tableSize = traceClsSet.size > 0 ? buildIl2cppMethodTable() : 0;
        const ecuKlass = findClassByName("ecu");
        if (!ecuKlass) return { ok: false, tableSize: 0, traced: [] };
        const xbe = ecuKlass.tryMethod("xbe");
        if (!xbe) return { ok: false, tableSize: 0, traced: [] };
        xbe.implementation = function (this: any, ...args: any[]): any {
            const self = this as Il2Cpp.Object;
            let cls = "?";
            try {
                cls = args[0]?.class?.name ?? "?";
                // Non-subscription autopilot bypass: Dofus's autopilot sets
                // isp.efmg=true which triggers a server-side sub check. We
                // force it back to false before the message is sent — the
                // server then treats the map-change as a "manual walk" (like
                // clicking a border arrow), no sub required. Works for both
                // sub and non-sub accounts identically.
                if (cls === "isp") {
                    try { args[0].field("efmg").value = false; } catch {}
                }
                outgoingLog.push({ ts: Date.now(), cls });
                if (outgoingLog.length > 200) outgoingLog.shift();
                // jmw = GameContextReadyMessage, fires once per map arrival
                // during autopilot. Include its mapId so the UI can detect
                // travel completion without having to poll from its side.
                const fields: Record<string, string> = {};
                if (cls === "jmw") {
                    try { fields.ekry = String(args[0].field("ekry").value); } catch {}
                }
                try { send({ type: "socket", direction: "out", cls, name: "?", fullName: "?", fields, ts: Date.now() }); } catch {}
                if (traceClsSet.has(cls)) {
                    const bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                    const frames: string[] = [];
                    for (let i = 0; i < Math.min(bt.length, 20); i++) frames.push(resolveFrame(bt[i]));
                    const fields = snapshotFields(args[0]);
                    stackCaptures.push({ ts: Date.now(), cls, frames, fields });
                    if (stackCaptures.length > 60) stackCaptures.shift();
                    try { send({ type: "out-stack", ts: Date.now(), cls, frames, fields }); } catch {}
                }
            } catch {}
            return self.method("xbe").invoke(...args);
        };
        xbeHookInstalled = true;
        console.log(`[outhook] ecu.xbe installed (trace=[${[...traceClsSet].join(",")}])`);
        return { ok: true, tableSize, traced: [...traceClsSet] };
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
// Native autopilot: autoTravelInstant(mapId)
// -----------------------------------------------------------------------------

let cachedDttClass: Il2Cpp.Class | null = null;
let cachedLiveDtt: Il2Cpp.Object | null = null;
let cachedDchKlass: Il2Cpp.Class | null = null;

// Main-thread dispatcher — Interceptor.attach (not .implementation) on
// dtt.tjz. tjz is a bool getter the UI polls every frame from the Unity
// main thread. We observe the address directly; no JIT-sharing issues,
// no class-name collisions with other same-signature methods.
let mainThreadDispatcher: any = null;
let pendingMainWork: (() => void) | null = null;

function ensureMainThreadDispatcher(): boolean {
    if (mainThreadDispatcher) return true;
    if (!cachedDttClass) cachedDttClass = findClassByName("dtt");
    if (!cachedDttClass) return false;
    const tjz = cachedDttClass.tryMethod("tjz");
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

function resolveOrSynthesizeDtt(): Il2Cpp.Object | null {
    if (!cachedDttClass) cachedDttClass = findClassByName("dtt");
    if (!cachedDttClass) return null;
    // Always re-scan for live dtt. Instance gets recreated on account
    // switch (new character → new dtt). Old cache → dead memory.
    const live = Il2Cpp.gc.choose(cachedDttClass);
    if (live.length) {
        cachedLiveDtt = live[live.length - 1];
        return cachedLiveDtt;
    }
    cachedLiveDtt = null;
    // No live dtt → build a fresh synth each call (services change per session).

    // Synthesize: parameterless ctor + populate service fields by finding
    // a live implementation of each field's interface type in the heap.
    let dtt: Il2Cpp.Object;
    try { dtt = (cachedDttClass as any).new() as Il2Cpp.Object; }
    catch (e) { console.log(`[autopilot] new dtt() throw: ${String(e).slice(0, 120)}`); return null; }
    const populated: string[] = [];
    const failed: string[] = [];
    for (const f of cachedDttClass.fields) {
        if (f.isStatic) continue;
        const ftype = f.type.name;
        if (ftype === "System.Int32" || ftype === "System.Int64" || ftype === "System.Boolean" || ftype === "System.Single") continue;
        if (ftype.startsWith("System.Collections")) continue;
        try {
            const tKlass = findClassByName(ftype);
            if (!tKlass) { failed.push(`${f.name}:${ftype}(cls?)`); continue; }
            let found = Il2Cpp.gc.choose(tKlass);
            if (!found.length) {
                // Interface type — scan for implementations.
                outer: for (const asm of Il2Cpp.domain.assemblies) {
                    try {
                        for (const k of asm.image.classes) {
                            let implementsIt = false;
                            try {
                                for (const iface of (k as any).interfaces ?? []) {
                                    if (iface.name === ftype) { implementsIt = true; break; }
                                }
                            } catch {}
                            if (!implementsIt) continue;
                            try {
                                const insts = Il2Cpp.gc.choose(k);
                                if (insts.length) { found = insts; break outer; }
                            } catch {}
                        }
                    } catch {}
                }
            }
            if (found.length) { dtt.field(f.name).value = found[0] as any; populated.push(f.name); }
            else failed.push(`${f.name}:${ftype}(none)`);
        } catch (e) { failed.push(`${f.name}:${ftype}(${String(e).slice(0, 30)})`); }
    }
    console.log(`[autopilot] synthetic dtt: populated=${populated.length}, failed=${failed.length}`);
    if (failed.length) console.log(`[autopilot] unpopulated: ${failed.slice(0, 8).join(", ")}`);
    return dtt;
}

export function autoTravelInstant(mapId: number | string): Promise<{ ok: boolean; reason?: string; targetMapId?: number }> {
    return inVm(() => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) return { ok: false, reason: `invalid mapId ${mapId}` };

        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) return { ok: false, reason: "dtt unavailable" };
        if (!cachedDchKlass) cachedDchKlass = findClassByName("dch");
        if (!cachedDchKlass) return { ok: false, reason: "dch class not found" };
        const dchKlass = cachedDchKlass;
        if (!ensureMainThreadDispatcher()) return { ok: false, reason: "main-thread dispatcher attach failed" };

        // Build the dch + invoke tkc INSIDE the main-thread callback — some
        // IL2CPP objects can't be safely constructed off-main.
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
                    // Extra diagnostic — which service fields are null?
                    const nullFields: string[] = [];
                    try {
                        for (const f of dtt.class.fields) {
                            if (f.isStatic) continue;
                            const ftype = f.type.name;
                            if (ftype.startsWith("System.")) continue;
                            try {
                                const v: any = dtt.field(f.name).value;
                                if (!v || !v.handle || v.handle.isNull()) nullFields.push(`${f.name}:${ftype}`);
                            } catch {}
                        }
                    } catch {}
                    if (nullFields.length) console.log(`[autopilot] null fields: ${nullFields.join(", ")}`);
                }
            } catch (e) { console.log(`[autopilot] dch build throw: ${String(e).slice(0, 120)}`); }
        };
        return { ok: true, targetMapId: mid };
    });
}

// -----------------------------------------------------------------------------
// Debug / exploration utilities
// -----------------------------------------------------------------------------

export function describeClass(clsName: string): Promise<{
    cls: string; ns: string; parent: string;
    methods: Array<{ name: string; isStatic: boolean; params: string[]; ret: string; addr: string }>;
    fields: Array<{ name: string; type: string; isStatic: boolean }>;
} | null> {
    return inVm(() => {
        const k = findClassByName(clsName);
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

export function scanArrowCandidates(): Promise<{
    matched: Array<{ cls: string; ns: string; parent: string;
        methods: Array<{ name: string; isStatic: boolean; params: string[]; ret: string }>;
        fields: Array<{ name: string; type: string; isStatic: boolean }>;
    }>;
}> {
    return inVm(() => {
        const keywords = ["arrow", "border", "direction", "mapchange", "transition", "cellchange"];
        const matched: any[] = [];
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
    });
}

// -----------------------------------------------------------------------------
// Wide-net autopilot call-chain tracer. Used once, during reverse engineering,
// to identify dtt.tkc as the "Voyager" handler. Kept for future exploration
// of other game systems (inventory, fight, etc.) — same pattern works.
// -----------------------------------------------------------------------------

interface AutopilotHit { ts: number; method: string; args: string[]; edgesSize?: number; }
const autopilotHits: AutopilotHit[] = [];
let autopilotHooked = false;

export function hookAutopilot(): Promise<{ ok: boolean; hooked: string[]; reason?: string }> {
    return inVm(() => {
        if (autopilotHooked) return { ok: true, hooked: [], reason: "already hooked" };
        const hooked: string[] = [];
        const IGNORE = new Set(["dtt.tjz", "foz.bgtw", "foz.bgtv"]);
        const hookAll = (klassName: string) => {
            const klass = findClassByName(klassName);
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
        hookAll("eli");
        hookAll("foz");
        hookAll("elf");
        hookAll("elg");
        hookAll("dtt");
        hookAll("eld");
        hookAll("cod");
        autopilotHooked = true;
        console.log(`[autopilot] traced ${hooked.length} methods across eli/foz/elf/elg/dtt/eld/cod`);
        return { ok: true, hooked: [`${hooked.length} methods`] };
    });
}

export function getAutopilotHits(): Promise<AutopilotHit[]> {
    return inVm(() => autopilotHits.map(h => ({ ...h })));
}
export function clearAutopilotHits(): Promise<number> {
    return inVm(() => { const n = autopilotHits.length; autopilotHits.length = 0; return n; });
}
