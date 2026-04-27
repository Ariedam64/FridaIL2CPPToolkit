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
const FIELD_EXTRACT_CLASSES = new Set<string>(["gyr", "iee", "isp", "isl", "igd"]);

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

// Hook dtt.tkl(bool, bool) — fires AFTER the final arrival of an autopilot,
// once dtt has acked the server response and cleaned up. Empirically traced
// (hookAutopilot full trace showed: ... → kwd(dci) → tkk(finalMapId) → TKL → tlc()).
// The plan orchestrator listens for this event to barrier between back-to-back
// autopilots, avoiding client/server desync.
//
// IMPORTANT: uses `method.implementation = wrapper` (NOT Interceptor.attach).
// On Dofus 3 IL2CPP, Interceptor.attach(virtualAddress) does NOT fire — proven
// by 10-call probe with 0 hits. Only the implementation override fires reliably,
// for both UI-triggered and agent-invoked autopilot chains.
// =============================================================================
// Autopilot lifecycle hooks + control RPCs.
// See dofus-app/docs/dofus-reverse-engineering.md §4 for the protocol details.
// =============================================================================

let autopilotDoneHooked = false;

/**
 * Install a wrapper on dtt.tkl(bool, bool) — the FINAL completion callback of
 * an autopilot journey (fires once after the last hop's server ack). Each fire
 * broadcasts a Frida `send({type:"autopilot-done", ts})` event, which surfaces
 * to host WS clients as `{message: {type:"send", payload:{type:"autopilot-done"}}}`.
 *
 * IMPORTANT: uses `method.implementation = wrapper` (NOT Interceptor.attach).
 * On Dofus 3 IL2CPP, Interceptor.attach silently misses tkl events even when
 * triggered natively by the game. The implementation override is the only
 * pattern that fires reliably for both UI and agent-driven autopilot chains.
 *
 * Idempotent — calling more than once is a no-op.
 */
export function hookAutopilotDone(): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        if (autopilotDoneHooked) return { ok: true, reason: "already hooked" };
        const dttKlass = getClass("dtt");
        if (!dttKlass) return { ok: false, reason: "dtt not found" };
        let tklMethod: any = null;
        for (const m of dttKlass.methods) {
            if (m.name === "tkl") { tklMethod = m; break; }
        }
        if (!tklMethod) return { ok: false, reason: "dtt.tkl not found" };
        try {
            tklMethod.implementation = function (this: any, ...args: any[]): any {
                try { send({ type: "autopilot-done", ts: Date.now() }); } catch {}
                return (this as Il2Cpp.Object).method("tkl").invoke(...args);
            };
            autopilotDoneHooked = true;
            return { ok: true };
        } catch (e) { return { ok: false, reason: String(e).slice(0, 120) }; }
    });
}

/**
 * Cancel any in-flight autopilot — replicates the UI's click-on-place behavior.
 * Empirically discovered by tracing the user's manual cancel via hookAutopilot:
 *
 *   [user clicks on current cell]
 *     → dtt.fob(dck)        ← THIS is what we replicate
 *       → dtt.tkj(false)    (auto-cascade: SetActive false)
 *       → dtt.tlc()         (auto-cascade: cleanup)
 *       → elg.baof(...)     (auto-cascade: reset local-map walk)
 *
 * `dck` is a struct/class with zero serialized fields — instantiating with
 * `(dckKlass).new()` and passing it suffices. After fob() returns,
 * dtt.<deiy>k__BackingField === false and the server has been informed.
 * Safe to fire the next bbd immediately (no desync).
 *
 * Returns `ok:true reason:"already idle"` if dtt was already idle (e.g. the
 * autopilot self-rejected an unreachable target — no abort needed).
 */
export function abortAutoTravel(): Promise<{
    ok: boolean;
    deiyBefore: string;
    deiyAfter: string;
    reason?: string;
}> {
    return inVm(() => {
        const dttKlass = getClass("dtt");
        const dckKlass = getClass("dck");
        if (!dttKlass) return { ok: false, deiyBefore: "?", deiyAfter: "?", reason: "dtt class not found" };
        if (!dckKlass) return { ok: false, deiyBefore: "?", deiyAfter: "?", reason: "dck class not found" };
        const dttInsts = Il2Cpp.gc.choose(dttKlass);
        if (!dttInsts.length) return { ok: false, deiyBefore: "?", deiyAfter: "?", reason: "no dtt instance" };
        const dtt = dttInsts[0]!;

        const readDeiy = (): string => {
            try { return String((dtt as any).field("<deiy>k__BackingField").value); } catch { return "<err>"; }
        };
        const deiyBefore = readDeiy();
        // Always call fob — the "already idle" shortcut was wrong: even when deiy=false,
        // the elg/foz pathfinder state can carry residual cache from a failed bbd that
        // poisons subsequent attempts. fob's cascade (tkj(false) + tlc + baof) appears
        // to clean this. Diagnosed: 1st unreachable bbd → 2nd reachable bbd fails
        // (deiy=false) until fob is called even though dtt was "idle".
        try {
            const dck = (dckKlass as any).new();
            (dtt as any).method("fob").invoke(dck);
            return { ok: true, deiyBefore, deiyAfter: readDeiy() };
        } catch (e) {
            // fob can throw "system error" cosmetically (same Frida marshaling
            // quirk as bbd) but the cancel STILL succeeds. Re-read deiy to
            // confirm and report success if the state actually transitioned.
            const after = readDeiy();
            return { ok: after === "false", deiyBefore, deiyAfter: after, reason: "fob threw cosmetic: " + String(e).slice(0, 80) };
        }
    });
}

// Hook dtt.bbd via m.implementation to dump dch field values whenever it's
// called from the GAME (UI, context menu). m.implementation is bypassed by
// method.invoke from agent — so this hook ONLY fires for game-internal callers.
// Each fire broadcasts a `bbd-call` WS event with the full dch field dump.
let bbdArgsHooked = false;

export function hookBbdArgs(): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        if (bbdArgsHooked) return { ok: true, reason: "already hooked" };
        const dttKlass = getClass("dtt");
        const dchKlass = getClass("dch");
        if (!dttKlass || !dchKlass) return { ok: false, reason: "dtt or dch not found" };
        const bbd = dttKlass.methods.find(m => m.name === "bbd");
        if (!bbd) return { ok: false, reason: "dtt.bbd not found" };

        const dumpDch = (dch: any): Record<string, string> => {
            const out: Record<string, string> = {};
            for (const f of dchKlass.fields) {
                if ((f as any).isStatic) continue;
                try { out[f.name] = String(dch.field(f.name).value); } catch (e) { out[f.name] = "<err>"; }
            }
            return out;
        };
        try {
            (bbd as any).implementation = function (this: any, dch: any, ...rest: any[]): any {
                try {
                    const fields = dumpDch(dch);
                    console.log(`[BBD-UI] dch{${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}}`);
                    try { send({ type: "bbd-call", source: "ui", fields, ts: Date.now() }); } catch {}
                } catch (e) { console.log(`[BBD-UI] dump threw: ${String(e).slice(0, 60)}`); }
                return (this as Il2Cpp.Object).method("bbd").invoke(dch, ...rest);
            };
            bbdArgsHooked = true;
            return { ok: true };
        } catch (e) { return { ok: false, reason: String(e).slice(0, 120) }; }
    });
}

export function unhookBbdArgs(): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        if (!bbdArgsHooked) return { ok: true, reason: "not hooked" };
        const dttKlass = getClass("dtt");
        if (!dttKlass) return { ok: false, reason: "dtt not found" };
        const bbd = dttKlass.methods.find(m => m.name === "bbd");
        if (!bbd) return { ok: false, reason: "dtt.bbd not found" };
        try { (bbd as any).implementation = null; bbdArgsHooked = false; return { ok: true }; }
        catch (e) { return { ok: false, reason: String(e).slice(0, 120) }; }
    });
}

export function unhookAutopilotDone(): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        if (!autopilotDoneHooked) return { ok: true, reason: "not hooked" };
        const dttKlass = getClass("dtt");
        if (!dttKlass) return { ok: false, reason: "dtt not found" };
        const tkl = dttKlass.methods.find(m => m.name === "tkl");
        if (!tkl) return { ok: false, reason: "dtt.tkl not found" };
        try { (tkl as any).implementation = null; autopilotDoneHooked = false; return { ok: true }; }
        catch (e) { return { ok: false, reason: String(e).slice(0, 120) }; }
    });
}

// Defensive cleanup of the world pathfinder (`foz`) state. Subagent investigation
// (2026-04-26) found that a single silent-reject bbd does NOT pollute foz fields
// (the worldgraph solver isn't even invoked) — but cumulative bbd+abort cycles
// can leave artifacts: a stale CancellationTokenSource in "Notifying" state, a
// non-null pending callback (`dpgq`), or stale dictionary entries.
//
// This RPC is safe to call between bbd invocations as a belt-and-suspenders
// reset. It only mutates well-known fields and Clear()s collections — no
// side-effect on the engaged autopilot path.
export function resetPathfinderState(): Promise<{ ok: boolean; cleaned: string[]; reason?: string }> {
    return inVm(() => {
        const cleaned: string[] = [];
        const fozK = getClass("foz");
        if (!fozK) return { ok: false, cleaned, reason: "foz class not found" };
        const fozInsts = Il2Cpp.gc.choose(fozK);
        if (!fozInsts.length) return { ok: false, cleaned, reason: "no foz instance" };
        const foz = fozInsts[fozInsts.length - 1]!;  // last = most recent

        // 1. Force the CTS out of any "cancellation requested" state.
        try {
            const cts = (foz as any).field("dpgl").value;
            if (cts) {
                const state = Number(cts.field("_state").value);
                if (state !== 0) {
                    cts.field("_state").value = 0;
                    cleaned.push(`foz.dpgl._state ${state}->0`);
                }
            }
        } catch {}
        // 2. Drop the stale callback ref.
        try {
            if ((foz as any).field("dpgq").value !== null) {
                (foz as any).field("dpgq").value = null;
                cleaned.push("foz.dpgq=null");
            }
        } catch {}
        // 3. Clear the working dictionaries/lists so a fresh search starts empty.
        for (const f of ["dpgn", "dpgp", "dpgo", "dpgr", "dpgs"]) {
            try {
                const coll = (foz as any).field(f).value;
                if (coll) {
                    (coll as any).method("Clear").invoke();
                    cleaned.push(`foz.${f}.Clear`);
                }
            } catch {}
        }
        return { ok: true, cleaned };
    });
}

// Live debug snapshot — designed to be CHEAP enough to poll ~1Hz without
// freezing the Unity main thread. Hot-path optimisations:
//   - Cache dtt + foz instance pointers (no gc.choose)
//   - Read primitive fields (bool, Int32) directly — Frida bridge already
//     does this as native pointer reads, not main-thread method calls
//   - For collections, read the underlying `_size`/`_count` field instead
//     of calling get_Count() method (saves a runtime_invoke per field)
//   - For object refs, just check null vs. set (no class introspection)
export function getAutopilotDebugState(): Promise<any> {
    return inVm(() => {
        const out: Record<string, any> = { dtt: {}, foz: {} };
        // ---- dtt (cached singleton) ----
        try {
            const dtt = resolveOrSynthesizeDtt();
            if (dtt) {
                const d = out.dtt;
                try { d["deiy"] = String((dtt as any).field("<deiy>k__BackingField").value); } catch { d["deiy"] = "<err>"; }
                try { d["deiz"] = String((dtt as any).field("deiz").value); } catch { d["deiz"] = "<err>"; }
                try { d["dejo"] = (dtt as any).field("dejo").value === null ? "null" : "set (target)"; } catch { d["dejo"] = "<err>"; }
                try {
                    const path = (dtt as any).field("dejp").value;
                    if (path === null) d["dejp"] = "null";
                    else { try { d["dejp"] = `List[${Number((path as any).field("_size").value)}]`; } catch { d["dejp"] = "set"; } }
                } catch { d["dejp"] = "<err>"; }
            }
        } catch {}
        // ---- foz (cached singleton) ----
        try {
            let foz = cachedFoz;
            if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
            if (!foz) {
                const fK = getClass("foz");
                if (fK) {
                    const arr = Il2Cpp.gc.choose(fK);
                    // Pick LAST instance — multiple foz can coexist in the heap
                    // (older ones from prior autopilot cycles); the game uses
                    // the most recently created one. Picking [0] gave us a
                    // stale instance whose collections never updated.
                    if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; }
                }
            }
            if (foz) {
                const f = out.foz;
                try {
                    const cts = (foz as any).field("dpgl").value;
                    f["dpgl._state"] = cts ? Number(cts.field("_state").value) : "null";
                } catch { f["dpgl._state"] = "<err>"; }
                try { f["dpgq"] = (foz as any).field("dpgq").value === null ? "null" : "set"; }
                catch { f["dpgq"] = "<err>"; }
                // Read Dictionary `_count` field directly instead of get_Count() method.
                for (const fn of ["dpgn", "dpgp", "dpgo", "dpgr", "dpgs"]) {
                    try {
                        const v = (foz as any).field(fn).value;
                        if (v === null) { f[fn] = "null"; continue; }
                        try { f[fn] = `[${Number((v as any).field("_count").value)}]`; }
                        catch { try { f[fn] = `[${Number((v as any).field("_size").value)}]`; } catch { f[fn] = "set"; } }
                    } catch { f[fn] = "<err>"; }
                }
            }
        } catch {}
        return out;
    });
}

// Lightweight engagement probe — reads ONLY `<deiy>k__BackingField` (the
// "autopilot is active" bool) instead of the full 25-field snapshot. Coverage
// orchestrator polls this frequently; the heavy version was freezing the
// game's main thread on each check.
export function isAutopilotActive(): Promise<{ active: boolean; reason?: string }> {
    return inVm(() => {
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) return { active: false, reason: "dtt unavailable" };
        try {
            const v = String((dtt as any).field("<deiy>k__BackingField").value);
            return { active: v === "true" };
        } catch (e) { return { active: false, reason: String(e).slice(0, 80) }; }
    });
}

// Snapshot all fields of the live dtt instance — used to diagnose the state
// drift that eventually breaks long-range autopilot.
export function snapshotDttState(): Promise<{ ok: boolean; fields?: Record<string, string>; reason?: string }> {
    return inVm(() => {
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) return { ok: false, reason: "dtt unavailable" };
        const out: Record<string, string> = {};
        for (const f of dtt.class.fields) {
            if (f.isStatic) continue;
            try {
                const v = dtt.field(f.name).value as any;
                if (v === null || v === undefined) { out[f.name] = "null"; continue; }
                if (typeof v === "object" && v.class) {
                    const cn = v.class.name;
                    // For collections, include count
                    if (/^(List|Dictionary|HashSet|Queue|Stack)/.test(cn)) {
                        try {
                            const n = Number(v.method("get_Count").invoke());
                            out[f.name] = `${cn}[${n}]`;
                        } catch { out[f.name] = cn; }
                    } else out[f.name] = cn;
                } else out[f.name] = String(v).slice(0, 40);
            } catch (e) { out[f.name] = `<err:${String(e).slice(0, 30)}>`; }
        }
        return { ok: true, fields: out };
    });
}

/**
 * Diagnostic: enumerate ALL live `dtt` instances in the heap and report which
 * fields are valid vs <access violation> on each. Used to detect whether the
 * game has a real (UI-created) dtt we should prefer over our synthetic one.
 *
 * "Healthy" = no access-violation on the canary fields (dejn/dejo/dejp/dejr).
 * If a healthy one exists, autoTravelInstant should target THAT instance.
 */
export function listAllDttInstances(): Promise<{
    count: number;
    instances: Array<{ index: number; healthy: boolean; sampleFields: Record<string, string> }>;
}> {
    return inVm(() => {
        const dttKlass = getClass("dtt");
        if (!dttKlass) return { count: 0, instances: [] };
        const all = Il2Cpp.gc.choose(dttKlass);
        const canary = ["dejn", "dejo", "dejp", "dejr", "dejv", "dejw"];
        const out: Array<{ index: number; healthy: boolean; sampleFields: Record<string, string> }> = [];
        for (let i = 0; i < all.length; i++) {
            const inst = all[i]!;
            const sf: Record<string, string> = {};
            let healthy = true;
            for (const fn of canary) {
                try {
                    const v = (inst as any).field(fn).value;
                    if (v === null || v === undefined) { sf[fn] = "null"; healthy = false; continue; }
                    if (typeof v === "object" && v.class) {
                        const cn = v.class.name;
                        if (/^(List|Dictionary|HashSet|Queue|Stack)/.test(cn)) {
                            try {
                                const n = Number(v.method("get_Count").invoke());
                                sf[fn] = `${cn}[${n}]`;
                            } catch { sf[fn] = cn; }
                        } else sf[fn] = cn;
                    } else sf[fn] = String(v).slice(0, 30);
                } catch (e) {
                    sf[fn] = `<err:${String(e).slice(0, 25)}>`;
                    healthy = false;
                }
            }
            out.push({ index: i, healthy, sampleFields: sf });
        }
        return { count: all.length, instances: out };
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
let mainThreadDispatcherFireCount = 0;
let mainThreadDispatcherWorkCount = 0;

export function getMainThreadDispatcherStats(): Promise<{ attached: boolean; fireCount: number; workCount: number; pending: boolean }> {
    return inVm(() => ({
        attached: !!mainThreadDispatcher,
        fireCount: mainThreadDispatcherFireCount,
        workCount: mainThreadDispatcherWorkCount,
        pending: !!pendingMainWork,
    }));
}

/**
 * EXPERIMENTAL — call dtt.bbd via NativeFunction (raw native call) instead of
 * Frida-bridge's method.invoke. Hypothesis: method.invoke routes via
 * il2cpp_runtime_invoke which bypasses our `m.implementation` hooks. NativeFunction
 * calls the JIT entry directly, which IS the entry our hooks patch — so the chain
 * inside bbd should fire normally.
 *
 * IL2CPP x64 calling convention for instance methods:
 *   Foo(thisPtr, args..., methodInfo*)
 *   → RCX = this, RDX = arg0, R8 = methodInfo (optional)
 *   → return in EAX
 *
 * For non-generic methods, methodInfo can be null.
 */
export function autoTravelInstantNative(mapId: number | string): Promise<{ ok: boolean; reason?: string; returnValue?: number; targetMapId?: number }> {
    return inVm(() => new Promise((resolve) => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) { resolve({ ok: false, reason: `invalid mapId ${mapId}` }); return; }

        const dttKlass = getClass("dtt");
        const dchKlass = getClass("dch");
        if (!dttKlass) { resolve({ ok: false, reason: "dtt class not found" }); return; }
        if (!dchKlass) { resolve({ ok: false, reason: "dch class not found" }); return; }

        const dttInsts = Il2Cpp.gc.choose(dttKlass);
        if (!dttInsts.length) { resolve({ ok: false, reason: "no dtt instance" }); return; }
        const dtt = dttInsts[0]!;

        let bbdMethod: any = null;
        for (const m of dttKlass.methods) {
            if (m.name === "bbd") { bbdMethod = m; break; }
        }
        if (!bbdMethod) { resolve({ ok: false, reason: "dtt.bbd not found" }); return; }

        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "dispatcher fail" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const dch = (dchKlass as any).new();
                dch.field("dbkk").value = mid;
                dch.field("dbkl").value = true;

                // Raw native call via NativeFunction
                const fn = new NativeFunction(
                    bbdMethod.virtualAddress,
                    'uint8',                       // returns Boolean
                    ['pointer', 'pointer', 'pointer'],  // this, dch, methodInfo
                    'win64',
                );
                // dtt and dch are Il2Cpp.Object — use .handle for the raw pointer
                const ret = fn((dtt as any).handle, (dch as any).handle, NULL);
                console.log(`[autopilot-native] bbd(${mid}) returned ${ret}`);
                settle({ ok: true, returnValue: Number(ret), targetMapId: mid });
            } catch (e) {
                settle({ ok: false, reason: 'native: ' + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "dispatch timeout" }), 3000);
    }));
}

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
            // onLeave runs AFTER tjz finishes — calling dtt methods like bbd during
            // onEnter is re-entrant into dtt (bad: "system error" after a few calls).
            // onLeave lets tjz fully unwind first, so our bbd call has a clean dtt frame.
            onLeave(this: any, _retval: any) {
                mainThreadDispatcherFireCount++;
                if (!pendingMainWork) return;
                mainThreadDispatcherWorkCount++;
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
let cachedFoz: Il2Cpp.Object | null = null;

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

// Fire dtt.bbd(dch{mapId, true}) on the Unity main thread and propagate the
// IL2CPP call result back so the panel knows whether the autopilot actually
// started or threw. We use bbd (not tkc) because bbd is the high-level entry
// the UI uses — it registers the arrival callback chain that resets dtt's
// state machine when the player arrives.
//
// Frida-side limitation: after ~10-30 successive bbd invocations, IL2CPP
// throws "system error" until the agent is reloaded. The world panel's plan
// orchestrator handles this by auto-reloading the agent after 3 consecutive
// failures (see panels/world.ts).
export function autoTravelInstant(mapId: number | string, instantFlag: boolean | null = true): Promise<{ ok: boolean; reason?: string; targetMapId?: number; bfsHops?: number }> {
    return inVm(() => new Promise((resolve) => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) { resolve({ ok: false, reason: `invalid mapId ${mapId}` }); return; }

        // Pre-check via BFS on cached worldgraph adjacency. Reaching for a
        // non-reachable map (cross-component, isolated island, etc.) corrupts
        // foz state Tier 2 (per 2026-04-27 user observation). Skipping these
        // before bbd dispatch keeps the worldgraph clean.
        try {
            const mr = getClass("MapRenderer");
            if (mr) {
                const arr = Il2Cpp.gc.choose(mr);
                if (arr.length) {
                    const curMid = Number((arr[arr.length - 1] as any).field("cywa").value);
                    if (Number.isFinite(curMid) && curMid > 0 && curMid !== mid) {
                        const reach = isReachableMapIds(curMid, mid);
                        if (!reach.reachable) {
                            resolve({ ok: false, reason: `non-reachable in worldgraph (BFS pre-check from ${curMid})`, targetMapId: mid });
                            return;
                        }
                        // Stash hops in a local for inclusion in success result below.
                        (resolve as any)._bfsHops = reach.hops;
                    }
                }
            }
        } catch { /* pre-check best-effort, never block bbd if probe fails */ }

        // The RPC layer marshals missing optional args as JS `null` (not undefined),
        // which sidesteps the function default. Coerce explicitly so dbkl=true
        // remains the safe default — `dbkl=false` triggers the "Voyage auto" popup.
        const dbkl = instantFlag === null || instantFlag === undefined ? true : !!instantFlag;
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) { resolve({ ok: false, reason: "dtt unavailable" }); return; }
        const dchKlass = getClass("dch");
        if (!dchKlass) { resolve({ ok: false, reason: "dch class not found" }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            // No pre-bbd manipulation. The autopilotHits trace (2026-04-27)
            // confirmed:
            //   1. The UI calls dtt.bbd(dch) directly — NOT tkc.
            //   2. bbd internally orchestrates the entire setup: tkh, tkr,
            //      elg.baoh/baoj/baok, foz.bgtt, eli.baot, eli.baos, dtt.cwi,
            //      tlc, tkm, then elg.baoi(target, callback, async) which is
            //      the actual pathfind launcher.
            //   3. Pre-firing eli.baot or clearing foz fields PUTS THE STATE
            //      IN A POSITION WHERE BBD'S INTERNAL GUARD EARLY-RETURNS,
            //      and the elg.baoi cascade never runs → silent reject.
            // The minimal correct sequence is just bbd(dch). bbd handles
            // everything itself, exactly like the manual UI click path.
            try {
                const dch = (dchKlass as any).new();
                dch.field("dbkk").value = mid;
                dch.field("dbkl").value = dbkl;
                try { dtt.method("bbd").invoke(dch); }
                catch { /* cosmetic Frida throw on UniTask return — bbd still ran */ }
                settle({ ok: true, targetMapId: mid });
            } catch (e) {
                settle({ ok: false, reason: `dch build: ${String(e).slice(0, 120)}`, targetMapId: mid });
            }
        };
        // Bail if the main-thread dispatcher never picks up the work.
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 3000);
    }));
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

// Dump the player's unlocked zaap destinations. Each entry is a `duk` with
// mapId at field `denx`. Source preference:
//   1. `dun.lqq()` — STATIC method returning the master List<duk>. Observed
//      2026-04-27 to be the actual source (47 entries on test character).
//      `dun` has 5 such static methods (lqq, fxr, trm, eie, mjs) all
//      returning the same backing list.
//   2. `dun.deor` — instance field. Used to be the source but is empty in
//      current builds (likely a UI-state cache populated only when the
//      worldmap is open). Kept as fallback.
export function listKnownZaaps(): Promise<{ ok: boolean; count?: number; items?: Array<any>; reason?: string; source?: string }> {
    return inVm(() => {
        const k = getClass("dun");
        if (!k) return { ok: false, reason: "dun not found" };
        let list: any = null;
        let source = "";
        try { list = (k as any).method("lqq").invoke(); if (list) source = "static:lqq"; } catch {}
        if (!list) {
            const dun = getLiveSingleton(k, cachedLiveDun);
            if (dun) {
                cachedLiveDun = dun;
                try { list = dun.field("deor").value as any; if (list) source = "instance:deor"; } catch {}
            }
        } else {
            const dun = getLiveSingleton(k, cachedLiveDun);
            if (dun) cachedLiveDun = dun;
        }
        if (!list) return { ok: true, count: 0, items: [], source: "none" };
        try {
            const n = Number(list.method("get_Count").invoke());
            const items: any[] = [];
            for (let i = 0; i < n; i++) {
                try {
                    const duk = list.method("get_Item").invoke(i) as any;
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
            return { ok: true, count: n, items, source };
        } catch (e) { return { ok: false, reason: String(e).slice(0, 120), source }; }
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
// Tracks hooked methods so unhookAutopilot can restore originals via
// `m.implementation = null`. Frida-il2cpp-bridge supports null-restore
// per https://github.com/vfsfitvnm/frida-il2cpp-bridge#hooking.
const hookedAutopilotMethods: Array<{ tag: string; method: any }> = [];

/**
 * Diagnostic-only — installs an Interceptor on every method of dtt + 6 autopilot
 * services (165 methods total) that records each call to the autopilotHits ring
 * buffer. Useful for tracing the bbd → tkh → elg.baoi → … chain when reverse
 * engineering. NOT recommended for prod runs: every hooked method now bounces
 * through JS, which adds overhead and can degrade the IL2CPP state machine
 * over many calls. Always pair with `unhookAutopilot()` when done.
 */
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
                    hookedAutopilotMethods.push({ tag, method: m });
                } catch {}
            }
        };
        for (const c of ["eli", "foz", "elf", "elg", "dtt", "eld", "cod"]) hookAll(c);
        autopilotHooked = true;
        console.log(`[autopilot] traced ${hooked.length} methods`);
        return { ok: true, hooked: [`${hooked.length} methods`] };
    });
}

/**
 * Restore originals of every method hooked by hookAutopilot. Setting
 * `method.implementation = null` removes the Frida wrapper and the game
 * calls the native code directly again. Also clears the hits buffer.
 *
 * Use after a diagnostic session before launching long-running tasks
 * (coverage plan, batch teleports) to avoid the IL2CPP state degradation
 * that can build up when 165 methods bounce through JS for thousands of calls.
 */
export function unhookAutopilot(): Promise<{ ok: boolean; restored: number; reason?: string }> {
    return inVm(() => {
        if (!autopilotHooked) return { ok: true, restored: 0, reason: "not hooked" };
        let restored = 0, failed = 0;
        for (const { method } of hookedAutopilotMethods) {
            try { method.implementation = null; restored++; }
            catch { failed++; }
        }
        hookedAutopilotMethods.length = 0;
        autopilotHits.length = 0;
        autopilotHooked = false;
        console.log(`[autopilot] unhooked: ${restored} restored, ${failed} failed`);
        return { ok: true, restored, reason: failed ? `${failed} methods failed restore` : undefined };
    });
}

export function getAutopilotHits(): Promise<AutopilotHit[]> {
    return inVm(() => autopilotHits.map(h => ({ ...h })));
}
export function clearAutopilotHits(): Promise<number> {
    return inVm(() => { const n = autopilotHits.length; autopilotHits.length = 0; return n; });
}

// -----------------------------------------------------------------------------
// deiz watcher — focused hook for finding the method that flips dtt.deiz
// -----------------------------------------------------------------------------
// Runtime observation 2026-04-27: bbd on unreachable target sets deiz=true.
// `autoTravelInstant`'s defensive `deiz=false` write does NOT unstick subsequent
// bbds — they keep silent-rejecting. The in-game UI CAN unstick by some manual
// action. This hook traces all dtt instance-methods and logs whenever any of
// them flips deiz, so we can identify the unsticking method.

interface DeizHit { ts: number; method: string; before: string; after: string; }
const deizHits: DeizHit[] = [];
let deizWatcherHooked = false;
const hookedDeizMethods: Array<{ tag: string; method: any }> = [];

export function hookDeizWatcher(): Promise<{ ok: boolean; hooked: number; reason?: string }> {
    return inVm(() => {
        if (deizWatcherHooked) return { ok: true, hooked: 0, reason: "already hooked" };
        const dttKlass = getClass("dtt");
        if (!dttKlass) return { ok: false, hooked: 0, reason: "dtt class not found" };
        let hooked = 0;
        // Skip every-frame methods (tjz fires once per Update tick → spam) and
        // Object basics that never touch fields.
        const SKIP = new Set(["tjz", "ToString", "Equals", "GetHashCode", "GetType", "MemberwiseClone", "Finalize"]);
        for (const m of dttKlass.methods) {
            if (m.isStatic) continue;
            if (m.name.startsWith(".")) continue;
            if (SKIP.has(m.name)) continue;
            const methodName = m.name;
            try {
                m.implementation = function (this: any, ...args: any[]): any {
                    const self = this as Il2Cpp.Object;
                    let beforeDeiz = "?";
                    try { beforeDeiz = String(self.field("deiz").value); } catch {}
                    // Re-invoke via .method().invoke() — same pattern as hookAutopilot
                    let ret: any;
                    try { ret = self.method(methodName).invoke(...args); }
                    catch (e) {
                        // Re-throw after capturing post-deiz so we still see the flip
                        let afterDeiz = "?";
                        try { afterDeiz = String(self.field("deiz").value); } catch {}
                        if (beforeDeiz !== afterDeiz) {
                            console.log(`[deiz] *** FLIP ${beforeDeiz} → ${afterDeiz} via dtt.${methodName} (THREW)`);
                            deizHits.push({ ts: Date.now(), method: methodName + " [threw]", before: beforeDeiz, after: afterDeiz });
                            if (deizHits.length > 200) deizHits.shift();
                        }
                        throw e;
                    }
                    let afterDeiz = "?";
                    try { afterDeiz = String(self.field("deiz").value); } catch {}
                    if (beforeDeiz !== afterDeiz) {
                        console.log(`[deiz] *** FLIP ${beforeDeiz} → ${afterDeiz} via dtt.${methodName}`);
                        deizHits.push({ ts: Date.now(), method: methodName, before: beforeDeiz, after: afterDeiz });
                        if (deizHits.length > 200) deizHits.shift();
                    }
                    return ret;
                };
                hookedDeizMethods.push({ tag: methodName, method: m });
                hooked++;
            } catch {}
        }
        deizWatcherHooked = true;
        console.log(`[deiz] watcher attached on ${hooked} dtt methods — fire test now, watch console for FLIP lines`);
        return { ok: true, hooked };
    });
}

export function unhookDeizWatcher(): Promise<{ ok: boolean; restored: number; reason?: string }> {
    return inVm(() => {
        if (!deizWatcherHooked) return { ok: true, restored: 0, reason: "not hooked" };
        let restored = 0, failed = 0;
        for (const { method } of hookedDeizMethods) {
            try { method.implementation = null; restored++; }
            catch { failed++; }
        }
        hookedDeizMethods.length = 0;
        deizWatcherHooked = false;
        console.log(`[deiz] watcher detached: ${restored} restored, ${failed} failed`);
        return { ok: true, restored, reason: failed ? `${failed} methods failed restore` : undefined };
    });
}

export function getDeizHits(): Promise<DeizHit[]> {
    return inVm(() => deizHits.map(h => ({ ...h })));
}

export function clearDeizHits(): Promise<number> {
    return inVm(() => { const n = deizHits.length; deizHits.length = 0; return n; });
}

// -----------------------------------------------------------------------------
// foz watcher — trace every foz method call with internal state snapshots
// -----------------------------------------------------------------------------
// User reports (2026-04-27): after a silent-reject poisons deiz, even calling
// CLEAR DEIZ (cwi) + a fresh bbd to a reachable target re-sets deiz=true,
// because bbd's internal call to foz STILL doesn't compute a path. We need to
// see what foz methods are (or aren't) being called by a poisoned bbd vs a
// healthy one, to identify what guards/state is preventing the solver from
// running.

interface FozHit { ts: number; method: string; argsBrief: string; dpgqWasSet: boolean; dpglState: string; }
const fozHits: FozHit[] = [];
let fozWatcherHooked = false;
const hookedFozMethods: Array<{ tag: string; method: any }> = [];

export function hookFozWatcher(opts?: { quiet?: boolean }): Promise<{ ok: boolean; hooked: number; reason?: string }> {
    return inVm(() => {
        if (fozWatcherHooked) return { ok: true, hooked: 0, reason: "already hooked" };
        const fozKlass = getClass("foz");
        if (!fozKlass) return { ok: false, hooked: 0, reason: "foz class not found" };
        const quiet = !!(opts && opts.quiet);
        // Skip per-frame methods that would spam (none confirmed for foz, but
        // the existing IGNORE list excludes bgtw/bgtv as cache management —
        // include them here since we WANT to see when cache mgmt fires).
        const SKIP = new Set(["ToString", "Equals", "GetHashCode", "GetType", "MemberwiseClone", "Finalize"]);
        let hooked = 0;
        for (const m of fozKlass.methods) {
            if (m.isStatic) continue;
            if (m.name.startsWith(".")) continue;
            if (SKIP.has(m.name)) continue;
            const methodName = m.name;
            try {
                m.implementation = function (this: any, ...args: any[]): any {
                    const self = this as Il2Cpp.Object;
                    let dpgqWasSet = false;
                    let dpglState = "?";
                    try { dpgqWasSet = (self as any).field("dpgq").value !== null; } catch {}
                    try {
                        const cts = (self as any).field("dpgl").value;
                        dpglState = cts ? String(Number(cts.field("_state").value)) : "null";
                    } catch {}
                    const argsBrief: string[] = [];
                    try {
                        for (const a of args) {
                            if (a == null) { argsBrief.push("null"); continue; }
                            if (typeof a === "object" && (a as any).class) {
                                argsBrief.push((a as any).class.name);
                            } else argsBrief.push(String(a).slice(0, 16));
                        }
                    } catch {}
                    if (!quiet) console.log(`[foz] ${methodName}(${argsBrief.join(",")})  dpgq=${dpgqWasSet ? "set" : "null"}  dpgl._state=${dpglState}`);
                    fozHits.push({ ts: Date.now(), method: methodName, argsBrief: argsBrief.join(","), dpgqWasSet, dpglState });
                    if (fozHits.length > 300) fozHits.shift();
                    return self.method(methodName).invoke(...args);
                };
                hookedFozMethods.push({ tag: methodName, method: m });
                hooked++;
            } catch {}
        }
        fozWatcherHooked = true;
        console.log(`[foz] watcher attached on ${hooked} methods${quiet ? " (quiet — buffer only, no console)" : ""}`);
        return { ok: true, hooked };
    });
}

export function unhookFozWatcher(): Promise<{ ok: boolean; restored: number; reason?: string }> {
    return inVm(() => {
        if (!fozWatcherHooked) return { ok: true, restored: 0, reason: "not hooked" };
        let restored = 0, failed = 0;
        for (const { method } of hookedFozMethods) {
            try { method.implementation = null; restored++; }
            catch { failed++; }
        }
        hookedFozMethods.length = 0;
        fozWatcherHooked = false;
        console.log(`[foz] watcher detached: ${restored} restored, ${failed} failed`);
        return { ok: true, restored, reason: failed ? `${failed} methods failed restore` : undefined };
    });
}

export function getFozHits(): Promise<FozHit[]> {
    return inVm(() => fozHits.map(h => ({ ...h })));
}

export function clearFozHits(): Promise<number> {
    return inVm(() => { const n = fozHits.length; fozHits.length = 0; return n; });
}

// -----------------------------------------------------------------------------
// Synthetic deiz clear via dtt.cwi
// -----------------------------------------------------------------------------
// hookDeizWatcher confirmed (2026-04-27) that `dtt.cwi(List<Edge>, false)` is
// the only method that flips deiz from true → false. Hypothesis: the field
// semantics are "no valid route exists", and `cwi` clears it because being
// handed a path means "we DO have a route".
//
// This RPC tests whether we can synthetically invoke cwi with an existing
// (possibly empty) List<Edge> to clear deiz without running a full pathfind.
// If it works, this becomes the proper recovery primitive vs. the current
// naive deiz=false write that doesn't actually unstick subsequent bbds.

export function clearDeizViaCwi(): Promise<{
    ok: boolean;
    deizBefore: string;
    deizAfter: string;
    listSource?: string;
    listSize?: number;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) { resolve({ ok: false, deizBefore: "?", deizAfter: "?", reason: "dtt unavailable" }); return; }

        const readDeiz = (): string => {
            try { return String((dtt as any).field("deiz").value); } catch { return "<err>"; }
        };
        const deizBefore = readDeiz();

        // Pick a List<Edge> to pass. Priority: dtt.dejp (current path, same
        // type guaranteed) → foz.dpgs (resolver output, also List<Edge>).
        let list: any = null;
        let listSource = "";
        try {
            const dejp = (dtt as any).field("dejp").value;
            if (dejp !== null) { list = dejp; listSource = "dtt.dejp"; }
        } catch {}
        if (!list) {
            try {
                let foz = cachedFoz;
                if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
                if (!foz) {
                    const fK = getClass("foz");
                    if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
                }
                if (foz) {
                    const dpgs = (foz as any).field("dpgs").value;
                    if (dpgs !== null) { list = dpgs; listSource = "foz.dpgs"; }
                }
            } catch {}
        }
        if (!list) { resolve({ ok: false, deizBefore, deizAfter: deizBefore, reason: "no List<Edge> instance found in dejp or dpgs" }); return; }

        let listSize: number | undefined;
        try { listSize = Number((list as any).field("_size").value); } catch {}

        // cwi must run on the main thread.
        if (!ensureMainThreadDispatcher()) {
            resolve({ ok: false, deizBefore, deizAfter: deizBefore, listSource, listSize, reason: "main-thread dispatcher attach failed" });
            return;
        }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                (dtt as any).method("cwi").invoke(list, false);
                const deizAfter = readDeiz();
                settle({ ok: deizAfter !== "true", deizBefore, deizAfter, listSource, listSize });
            } catch (e) {
                const deizAfter = readDeiz();
                settle({ ok: deizAfter !== "true", deizBefore, deizAfter, listSource, listSize, reason: "cwi threw: " + String(e).slice(0, 100) });
            }
        };
        setTimeout(() => settle({ ok: false, deizBefore, deizAfter: deizBefore, listSource, listSize, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// -----------------------------------------------------------------------------
// Manual primitives — for step-by-step debugging without auto-defenses
// -----------------------------------------------------------------------------
// `autoTravelInstant` does several defensive operations (deiz=false, dpgl reset,
// conditional fob) before invoking bbd. Those defenses were written under
// hypotheses that turned out wrong, and they may be contributing to the freezes
// the user sees. These primitives let you do each step manually so you can
// observe and isolate which one matters.

// Pure bbd invocation — NO defensive cleanup. Just builds dch and fires bbd.
export function dttBbdRaw(mapId: number | string, dbkl: boolean = true): Promise<{
    ok: boolean;
    deizBefore?: string;
    deizAfter?: string;
    deiyBefore?: string;
    deiyAfter?: string;
    targetMapId?: number;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) { resolve({ ok: false, reason: `invalid mapId ${mapId}` }); return; }

        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) { resolve({ ok: false, reason: "dtt unavailable" }); return; }
        const dchKlass = getClass("dch");
        if (!dchKlass) { resolve({ ok: false, reason: "dch class not found" }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        const readDeiz = (): string => { try { return String((dtt as any).field("deiz").value); } catch { return "<err>"; } };
        const readDeiy = (): string => { try { return String((dtt as any).field("<deiy>k__BackingField").value); } catch { return "<err>"; } };
        const deizBefore = readDeiz();
        const deiyBefore = readDeiy();

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const dch = (dchKlass as any).new();
                dch.field("dbkk").value = mid;
                dch.field("dbkl").value = dbkl;
                try { (dtt as any).method("bbd").invoke(dch); }
                catch { /* cosmetic Frida throw, ignore */ }
                settle({ ok: true, deizBefore, deizAfter: readDeiz(), deiyBefore, deiyAfter: readDeiy(), targetMapId: mid });
            } catch (e) {
                settle({ ok: false, deizBefore, deizAfter: readDeiz(), deiyBefore, deiyAfter: readDeiy(), targetMapId: mid, reason: "build/invoke threw: " + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, deizBefore, deizAfter: deizBefore, deiyBefore, deiyAfter: deiyBefore, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Just write dtt.deiz = value. No bbd, no fob, nothing else.
export function writeDeiz(value: boolean): Promise<{ ok: boolean; before: string; after: string; reason?: string }> {
    return inVm(() => {
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) return { ok: false, before: "?", after: "?", reason: "dtt unavailable" };
        let before = "?", after = "?";
        try { before = String((dtt as any).field("deiz").value); } catch {}
        try { (dtt as any).field("deiz").value = !!value; } catch (e) { return { ok: false, before, after: before, reason: String(e).slice(0, 100) }; }
        try { after = String((dtt as any).field("deiz").value); } catch {}
        return { ok: true, before, after };
    });
}

// Just write foz.dpgl._state = value (the UniTaskCompletionSource state).
export function writeDpglState(value: number): Promise<{ ok: boolean; before: string; after: string; reason?: string }> {
    return inVm(() => {
        let foz = cachedFoz;
        if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
        if (!foz) {
            const fK = getClass("foz");
            if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
        }
        if (!foz) return { ok: false, before: "?", after: "?", reason: "no foz instance" };
        let before = "?", after = "?";
        try {
            const cts = (foz as any).field("dpgl").value;
            if (!cts) return { ok: false, before: "null", after: "null", reason: "dpgl is null" };
            try { before = String(Number(cts.field("_state").value)); } catch {}
            cts.field("_state").value = value;
            try { after = String(Number(cts.field("_state").value)); } catch {}
            return { ok: true, before, after };
        } catch (e) { return { ok: false, before, after: before, reason: String(e).slice(0, 100) }; }
    });
}

// Sample the first N entries of a foz collection field. Handles both
// Dictionary<TKey,TValue> (_count + _entries) and List<T> (_size + _items).
export function inspectFozDict(fieldName: string, limit: number = 10): Promise<{
    ok: boolean;
    fieldName: string;
    collectionKind?: "dict" | "list";
    count?: number;
    sample?: Array<{ key?: string; valueClass?: string; entry?: string }>;
    reason?: string;
}> {
    return inVm(() => {
        let foz = cachedFoz;
        if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
        if (!foz) {
            const fK = getClass("foz");
            if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
        }
        if (!foz) return { ok: false, fieldName, reason: "no foz instance" };
        try {
            const coll = (foz as any).field(fieldName).value;
            if (!coll) return { ok: false, fieldName, reason: "field is null" };
            // Try Dictionary first (_count + _entries), fall back to List (_size + _items)
            let isDict = false, isList = false, count = 0;
            try { count = Number((coll as any).field("_count").value); isDict = true; } catch {}
            if (!isDict) {
                try { count = Number((coll as any).field("_size").value); isList = true; } catch {}
            }
            const cn = (coll as any).class?.name ?? "?";
            if (!isDict && !isList) return { ok: false, fieldName, reason: `unknown collection kind: ${cn}` };
            const sample: Array<{ key?: string; valueClass?: string; entry?: string }> = [];
            const len = Math.min(limit, count);
            if (isDict) {
                const entries = (coll as any).field("_entries").value;
                if (entries) {
                    for (let i = 0; i < len; i++) {
                        try {
                            const entry = (entries as any).get(i);
                            const key = entry.field("key").value;
                            const value = entry.field("value").value;
                            let keyStr = "?";
                            try {
                                if (key === null || key === undefined) keyStr = "null";
                                else if (typeof key === "object" && (key as any).class) {
                                    const kc = (key as any).class.name;
                                    let extra = "";
                                    try { extra = " m_uid=" + Number((key as any).field("m_uid").value); } catch {}
                                    keyStr = kc + extra;
                                } else keyStr = String(key).slice(0, 40);
                            } catch {}
                            let valueClass: string | undefined;
                            try { if (value && typeof value === "object" && (value as any).class) valueClass = (value as any).class.name; } catch {}
                            sample.push({ key: keyStr, valueClass });
                        } catch {}
                    }
                }
            } else if (isList) {
                const items = (coll as any).field("_items").value;
                if (items) {
                    for (let i = 0; i < len; i++) {
                        try {
                            const it = (items as any).get(i);
                            let entry = "?";
                            if (it === null || it === undefined) entry = "null";
                            else if (typeof it === "object" && (it as any).class) {
                                const cc = (it as any).class.name;
                                let extra = "";
                                try { extra = " m_uid=" + Number((it as any).field("m_uid").value); } catch {}
                                entry = cc + extra;
                            } else entry = String(it).slice(0, 40);
                            sample.push({ entry });
                        } catch {}
                    }
                }
            }
            return { ok: true, fieldName, collectionKind: isDict ? "dict" : "list", count, sample };
        } catch (e) { return { ok: false, fieldName, reason: String(e).slice(0, 100) }; }
    });
}

// Maximum-strength foz reset: invoke .ctor() (resets dpgn/dpgp Dictionaries to
// empty) then Clear() the three Lists (dpgo/dpgr/dpgs) which ctor doesn't
// touch — dpgr in particular seems to block long-distance bbds when it carries
// state from a previous failed search. Plus write dtt.deiz=false to clear the
// silent-reject latch.
export function fullFozReset(): Promise<{
    ok: boolean;
    cleaned: string[];
    fieldsBefore?: Record<string, string>;
    fieldsAfter?: Record<string, string>;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        let foz = cachedFoz;
        if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
        if (!foz) {
            const fK = getClass("foz");
            if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
        }
        if (!foz) { resolve({ ok: false, cleaned: [], reason: "no foz instance" }); return; }
        const dtt = resolveOrSynthesizeDtt();
        const eli = resolveEli();
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, cleaned: [], reason: "main-thread dispatcher attach failed" }); return; }

        const snapshot = (): Record<string, string> => {
            const out: Record<string, string> = {};
            for (const fname of ["dpgl", "dpgq", "dpgn", "dpgp", "dpgo", "dpgr", "dpgs"]) {
                try {
                    const v = (foz as any).field(fname).value;
                    if (v === null) { out[fname] = "null"; continue; }
                    if (typeof v === "object" && (v as any).class) {
                        const cn = (v as any).class.name;
                        let cnt: number | null = null;
                        try { cnt = Number((v as any).field("_count").value); } catch {}
                        if (cnt === null) { try { cnt = Number((v as any).field("_size").value); } catch {} }
                        out[fname] = cnt === null ? cn : `${cn}[${cnt}]`;
                    } else out[fname] = String(v).slice(0, 30);
                } catch (e) { out[fname] = `<err:${String(e).slice(0, 25)}>`; }
            }
            try { if (dtt) out["dtt.deiz"] = String((dtt as any).field("deiz").value); } catch {}
            try { if (eli) out["eli.djzh"] = String((eli as any).field("djzh").value); } catch {}
            return out;
        };

        const fieldsBefore = snapshot();
        const cleaned: string[] = [];
        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                // Advance eli's state machine first if it's stuck mid-solve.
                // baot(true) drives djzh 2→3 (clears djze callback) — this is
                // what the game itself calls after each hop completes. Without
                // it, the next bbd will see djzh=2 and silent-reject.
                if (eli) {
                    try {
                        const djzh = Number((eli as any).field("djzh").value);
                        if (djzh === 2) {
                            (eli as any).method("baot").invoke(true);
                            cleaned.push(`eli.baot(true) [djzh was 2]`);
                        } else cleaned.push(`eli.baot skipped [djzh=${djzh}]`);
                    } catch (e) { cleaned.push("eli.baot threw: " + String(e).slice(0, 60)); }
                }
                try { (foz as any).method(".ctor").invoke(); cleaned.push("foz.ctor()"); }
                catch (e) { cleaned.push(".ctor threw: " + String(e).slice(0, 60)); }
                for (const f of ["dpgo", "dpgr", "dpgs"]) {
                    try {
                        const lst = (foz as any).field(f).value;
                        if (lst) { (lst as any).method("Clear").invoke(); cleaned.push(`${f}.Clear`); }
                    } catch (e) { cleaned.push(`${f}.Clear threw: ${String(e).slice(0, 40)}`); }
                }
                try { if (dtt) { (dtt as any).field("deiz").value = false; cleaned.push("deiz=false"); } } catch {}
                settle({ ok: true, cleaned, fieldsBefore, fieldsAfter: snapshot() });
            } catch (e) {
                settle({ ok: false, cleaned, fieldsBefore, fieldsAfter: snapshot(), reason: String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, cleaned, fieldsBefore, fieldsAfter: snapshot(), reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Instantiate a brand-new foz via .new() WITHOUT touching the live one.
// Returns the dict sizes of the fresh instance.
export function createFreshFoz(): Promise<{
    ok: boolean;
    fields?: Record<string, string>;
    reason?: string;
}> {
    return inVm(() => {
        try {
            const fK = getClass("foz");
            if (!fK) return { ok: false, reason: "foz class not found" };
            const fresh = (fK as any).new() as Il2Cpp.Object;
            const out: Record<string, string> = {};
            for (const fname of ["dpgl", "dpgq", "dpgn", "dpgp", "dpgo", "dpgr", "dpgs"]) {
                try {
                    const v = (fresh as any).field(fname).value;
                    if (v === null) { out[fname] = "null"; continue; }
                    if (typeof v === "object" && (v as any).class) {
                        const cn = (v as any).class.name;
                        try { const cnt = Number((v as any).field("_count").value); out[fname] = `${cn}[${cnt}]`; }
                        catch { try { const sz = Number((v as any).field("_size").value); out[fname] = `${cn}[${sz}]`; } catch { out[fname] = cn; } }
                    } else out[fname] = String(v).slice(0, 30);
                } catch (e) { out[fname] = `<err:${String(e).slice(0, 25)}>`; }
            }
            return { ok: true, fields: out };
        } catch (e) { return { ok: false, reason: "new foz() threw: " + String(e).slice(0, 100) }; }
    });
}

// Invoke .ctor() on the EXISTING foz instance to re-initialize fields in-place.
// HIGH RISK — may corrupt subscriber state or double-initialize.
export function callFozCtor(): Promise<{
    ok: boolean;
    fieldsBefore?: Record<string, string>;
    fieldsAfter?: Record<string, string>;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        let foz = cachedFoz;
        if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
        if (!foz) {
            const fK = getClass("foz");
            if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
        }
        if (!foz) { resolve({ ok: false, reason: "no foz instance" }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        const snapshot = (): Record<string, string> => {
            const out: Record<string, string> = {};
            for (const fname of ["dpgl", "dpgq", "dpgn", "dpgp", "dpgo", "dpgr", "dpgs"]) {
                try {
                    const v = (foz as any).field(fname).value;
                    if (v === null) { out[fname] = "null"; continue; }
                    if (typeof v === "object" && (v as any).class) {
                        const cn = (v as any).class.name;
                        try { const cnt = Number((v as any).field("_count").value); out[fname] = `${cn}[${cnt}]`; }
                        catch { out[fname] = cn; }
                    } else out[fname] = String(v).slice(0, 30);
                } catch (e) { out[fname] = `<err:${String(e).slice(0, 25)}>`; }
            }
            return out;
        };

        const fieldsBefore = snapshot();
        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                (foz as any).method(".ctor").invoke();
                settle({ ok: true, fieldsBefore, fieldsAfter: snapshot() });
            } catch (e) {
                settle({ ok: false, fieldsBefore, fieldsAfter: snapshot(), reason: ".ctor threw: " + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, fieldsBefore, fieldsAfter: snapshot(), reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Surgical recovery: null the stuck callback fields that snapshot diff
// (2026-04-27) identified as the actual culprit after a silent-reject.
//   - eli.djze (Action`2) — pathfinding builder's installed callback
//   - eli.djzg (int) — last queried vertex/mapId
//   - foz.dpgq (Action`2) — solver's pending callback
//   - dtt.deiz (bool) — silent-reject latch
// Does NOT touch the bigger collections (dpgn/dpgp/dpgr/dpgs etc.) which
// were never the actual problem. Avoids .ctor() which crashes the game.
export function clearStuckCallbacks(): Promise<{
    ok: boolean;
    cleaned: string[];
    before: Record<string, string>;
    after: Record<string, string>;
    reason?: string;
}> {
    return inVm(() => {
        const cleaned: string[] = [];
        const snap = (): Record<string, string> => {
            const out: Record<string, string> = {};
            try {
                const dtt = resolveOrSynthesizeDtt();
                if (dtt) try { out["dtt.deiz"] = String((dtt as any).field("deiz").value); } catch {}
            } catch {}
            try {
                const fK = getClass("foz");
                const fInsts = fK ? Il2Cpp.gc.choose(fK) : [];
                if (fInsts.length) {
                    const f = fInsts[fInsts.length - 1]!;
                    try {
                        const v = (f as any).field("dpgq").value;
                        out["foz.dpgq"] = v === null ? "null" : (typeof v === "object" && (v as any).class ? (v as any).class.name : String(v).slice(0, 30));
                    } catch (e) { out["foz.dpgq"] = `<err:${String(e).slice(0, 20)}>`; }
                }
            } catch {}
            try {
                const eK = getClass("eli");
                const eInsts = eK ? Il2Cpp.gc.choose(eK) : [];
                if (eInsts.length) {
                    const e = eInsts[eInsts.length - 1]!;
                    try {
                        const v = (e as any).field("djze").value;
                        out["eli.djze"] = v === null ? "null" : (typeof v === "object" && (v as any).class ? (v as any).class.name : String(v).slice(0, 30));
                    } catch (er) { out["eli.djze"] = `<err:${String(er).slice(0, 20)}>`; }
                    try { out["eli.djzg"] = String((e as any).field("djzg").value); } catch (er) { out["eli.djzg"] = `<err:${String(er).slice(0, 20)}>`; }
                }
            } catch {}
            return out;
        };

        const before = snap();
        try {
            const dtt = resolveOrSynthesizeDtt();
            if (dtt) { (dtt as any).field("deiz").value = false; cleaned.push("dtt.deiz=false"); }
        } catch (e) { cleaned.push(`dtt.deiz threw: ${String(e).slice(0, 50)}`); }
        try {
            const fK = getClass("foz");
            const fInsts = fK ? Il2Cpp.gc.choose(fK) : [];
            if (fInsts.length) {
                const f = fInsts[fInsts.length - 1]!;
                try { (f as any).field("dpgq").value = null; cleaned.push("foz.dpgq=null"); }
                catch (e) { cleaned.push(`foz.dpgq threw: ${String(e).slice(0, 50)}`); }
            }
        } catch (e) { cleaned.push(`foz lookup threw: ${String(e).slice(0, 50)}`); }
        try {
            const eK = getClass("eli");
            const eInsts = eK ? Il2Cpp.gc.choose(eK) : [];
            if (eInsts.length) {
                const e = eInsts[eInsts.length - 1]!;
                try { (e as any).field("djze").value = null; cleaned.push("eli.djze=null"); }
                catch (er) { cleaned.push(`eli.djze threw: ${String(er).slice(0, 50)}`); }
                try { (e as any).field("djzg").value = 0; cleaned.push("eli.djzg=0"); }
                catch (er) { cleaned.push(`eli.djzg threw: ${String(er).slice(0, 50)}`); }
            }
        } catch (e) { cleaned.push(`eli lookup threw: ${String(e).slice(0, 50)}`); }

        return { ok: true, cleaned, before, after: snap() };
    });
}

// Set a foz field to null (to force lazy re-population if there's a null
// guard). Useful for testing whether `dpgr` (suspected reachability cache)
// gets recomputed when nullified instead of just Clear()ed.
export function nullFozField(fieldName: string): Promise<{
    ok: boolean;
    fieldName: string;
    before?: string;
    reason?: string;
}> {
    return inVm(() => {
        let foz = cachedFoz;
        if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
        if (!foz) {
            const fK = getClass("foz");
            if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
        }
        if (!foz) return { ok: false, fieldName, reason: "no foz instance" };
        let before = "?";
        try {
            const v = (foz as any).field(fieldName).value;
            if (v === null) before = "null";
            else if (typeof v === "object" && (v as any).class) {
                let cnt: number | null = null;
                try { cnt = Number((v as any).field("_count").value); } catch {}
                if (cnt === null) { try { cnt = Number((v as any).field("_size").value); } catch {} }
                before = (v as any).class.name + (cnt === null ? "" : `[${cnt}]`);
            } else before = String(v).slice(0, 40);
        } catch {}
        try { (foz as any).field(fieldName).value = null; return { ok: true, fieldName, before }; }
        catch (e) { return { ok: false, fieldName, before, reason: String(e).slice(0, 100) }; }
    });
}

// Wide trace of every "safe-to-hook" autopilot method (no-arg void or simple
// Boolean return — anything else risks UniTask marshaling crashes). Used to
// capture the full call sequence during a healthy bbd then compare against
// the sequence in a bricked state — the divergence point identifies which
// method/state is missing.
interface TraceHit { ts: number; cls: string; method: string; argsBrief: string; ret: string; }
const traceHits: TraceHit[] = [];
let traceHooked = false;
const traceHookedMethods: Array<{ tag: string; m: any }> = [];
// Methods we KNOW crash when wrapped (return UniTask or internally await one).
const TRACE_BANLIST = new Set([
    "foz.bgtq", "foz.bgtu", "foz.csz", "eli.baom", "elg.baoj", "elg.baoi",
    "dtt.bbd", "dtt.tkc", // entry points — hooking them on the UI bbd path crashes too
    "dtt.tjz", // our main-thread dispatcher attach point — tracing it crashes the dispatcher
]);

export function traceAutopilotChain(): Promise<{ ok: boolean; hooked: number; reason?: string }> {
    return inVm(() => {
        if (traceHooked) return { ok: true, hooked: 0, reason: "already hooked" };
        let count = 0;
        for (const className of ["dtt", "foz", "eli", "elg", "elf", "eld", "cod"]) {
            const k = getClass(className);
            if (!k) continue;
            for (const m of k.methods) {
                if (m.isStatic) continue;
                if (m.name.startsWith(".")) continue;
                const tag = `${className}.${m.name}`;
                if (TRACE_BANLIST.has(tag)) continue;
                const rt = m.returnType.name;
                // Only hook methods returning void / bool / int / string — these
                // marshal cleanly back to JS without UniTask drama.
                if (rt !== "System.Void" && rt !== "System.Boolean" && rt !== "System.Int32" && rt !== "System.Int64" && rt !== "System.String") continue;
                // Skip methods with weird parameter types (anything not a primitive
                // or a known-safe ref type) — invoking via wrapper requires we pass
                // args through, and exotic types may also crash on marshaling.
                let safeParams = true;
                for (const p of m.parameters) {
                    const pn = p.type.name;
                    if (!pn.startsWith("System.") && !pn.includes("MapInformationData") && !pn.includes("Edge") && !pn.includes("Vertex") && !pn.includes("Action")) {
                        safeParams = false; break;
                    }
                }
                if (!safeParams) continue;
                const methodName = m.name;
                try {
                    m.implementation = function (this: any, ...args: any[]): any {
                        const self = this as Il2Cpp.Object;
                        const argsBrief: string[] = [];
                        try {
                            for (const a of args) {
                                if (a == null) argsBrief.push("null");
                                else if (typeof a === "object" && (a as any).class) argsBrief.push((a as any).class.name);
                                else argsBrief.push(String(a).slice(0, 14));
                            }
                        } catch {}
                        let ret: any;
                        try {
                            ret = self.method(methodName).invoke(...args);
                        } catch (e) {
                            traceHits.push({ ts: Date.now(), cls: className, method: methodName, argsBrief: argsBrief.join(","), ret: "THREW:" + String(e).slice(0, 60) });
                            if (traceHits.length > 1000) traceHits.shift();
                            throw e;
                        }
                        let retBrief = "void";
                        try {
                            if (ret == null) retBrief = String(ret);
                            else if (typeof ret === "boolean") retBrief = String(ret);
                            else if (typeof ret === "number") retBrief = String(ret);
                            else if (typeof ret === "string") retBrief = JSON.stringify(ret).slice(0, 30);
                            else if (typeof ret === "object" && (ret as any).class) retBrief = (ret as any).class.name;
                        } catch {}
                        traceHits.push({ ts: Date.now(), cls: className, method: methodName, argsBrief: argsBrief.join(","), ret: retBrief });
                        if (traceHits.length > 1000) traceHits.shift();
                        return ret;
                    };
                    traceHookedMethods.push({ tag, m });
                    count++;
                } catch {}
            }
        }
        traceHooked = true;
        return { ok: true, hooked: count };
    });
}

export function untraceAutopilotChain(): Promise<{ ok: boolean; restored: number }> {
    return inVm(() => {
        if (!traceHooked) return { ok: true, restored: 0 };
        let restored = 0;
        for (const { m } of traceHookedMethods) {
            try { (m as any).implementation = null; restored++; } catch {}
        }
        traceHookedMethods.length = 0;
        traceHooked = false;
        return { ok: true, restored };
    });
}

export function getAutopilotTrace(clear: boolean = false): Promise<TraceHit[]> {
    return inVm(() => {
        const copy = traceHits.slice();
        if (clear) traceHits.length = 0;
        return copy;
    });
}

// Minimal whitelist version of traceAutopilotChain — hooks ONLY the ~17 core
// methods observed in healthy bbd traces (no foz.bgtv counter spam, no scan
// of every method on every class). Far less IL2CPP state-machine pollution
// than the full traceAutopilotChain. Use for debug runs in production sessions.
const TRACE_MINIMAL_WHITELIST: Array<[string, string]> = [
    ["dtt", "tlc"], ["dtt", "tkr"], ["dtt", "tkq"], ["dtt", "tkh"],
    ["dtt", "tkv"], ["dtt", "tkk"], ["dtt", "tkl"], ["dtt", "cwi"],
    ["dtt", "tks"], ["dtt", "tkt"], ["dtt", "tla"], ["dtt", "tky"],
    ["foz", "bgts"], ["foz", "bgtt"],
    ["elg", "baoh"], ["elg", "baok"],
    ["eli", "baot"],
];

export function traceAutopilotMinimal(): Promise<{ ok: boolean; hooked: number; reason?: string }> {
    return inVm(() => {
        if (traceHooked) return { ok: true, hooked: 0, reason: "already hooked (call untraceAutopilotChain first)" };
        let count = 0;
        for (const [className, methodName] of TRACE_MINIMAL_WHITELIST) {
            const k = getClass(className);
            if (!k) continue;
            const m = k.methods.find(mm => mm.name === methodName);
            if (!m) continue;
            const tag = `${className}.${methodName}`;
            try {
                m.implementation = function (this: any, ...args: any[]): any {
                    const self = this as Il2Cpp.Object;
                    const argsBrief: string[] = [];
                    try {
                        for (const a of args) {
                            if (a == null) argsBrief.push("null");
                            else if (typeof a === "object" && (a as any).class) argsBrief.push((a as any).class.name);
                            else argsBrief.push(String(a).slice(0, 14));
                        }
                    } catch {}
                    let ret: any;
                    try {
                        ret = self.method(methodName).invoke(...args);
                    } catch (e) {
                        traceHits.push({ ts: Date.now(), cls: className, method: methodName, argsBrief: argsBrief.join(","), ret: "THREW:" + String(e).slice(0, 60) });
                        if (traceHits.length > 1000) traceHits.shift();
                        throw e;
                    }
                    let retBrief = "void";
                    try {
                        if (ret == null) retBrief = String(ret);
                        else if (typeof ret === "boolean") retBrief = String(ret);
                        else if (typeof ret === "number") retBrief = String(ret);
                        else if (typeof ret === "object" && (ret as any).class) retBrief = (ret as any).class.name;
                    } catch {}
                    traceHits.push({ ts: Date.now(), cls: className, method: methodName, argsBrief: argsBrief.join(","), ret: retBrief });
                    if (traceHits.length > 1000) traceHits.shift();
                    return ret;
                };
                traceHookedMethods.push({ tag, m });
                count++;
            } catch {}
        }
        traceHooked = true;
        return { ok: true, hooked: count };
    });
}

// Bypass bbd's guard by invoking elg.baoi(mapId, callback, false) directly,
// REUSING the stuck Action`2 from eli.djze as the callback. Theory: when bbd
// previously dispatched, it installed a real callback in eli.djze; the solver
// then died (CTS Notifying, etc.) without firing it, leaving djze stuck. If
// we relaunch baoi with that same callback, the solver fires it on completion
// → the game's natural cleanup chain runs (clears djze, deiz, dejo, etc.).
// We need a real Action`2 because passing null crashes the solver on the
// final invoke.
export function dispatchBaoiWithStuckCallback(mapId: number | string): Promise<{
    ok: boolean;
    mapId?: number;
    callbackSource?: string;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) { resolve({ ok: false, reason: `invalid mapId ${mapId}` }); return; }

        const eK = getClass("eli");
        if (!eK) { resolve({ ok: false, reason: "eli class not found" }); return; }
        const eliInsts = Il2Cpp.gc.choose(eK);
        if (!eliInsts.length) { resolve({ ok: false, reason: "no live eli instance" }); return; }
        const eli = eliInsts[eliInsts.length - 1]!;
        let stuckCb: any;
        try { stuckCb = (eli as any).field("djze").value; }
        catch (e) { resolve({ ok: false, reason: "read djze: " + String(e).slice(0, 60) }); return; }
        if (!stuckCb) { resolve({ ok: false, reason: "eli.djze is null — no stuck callback to reuse" }); return; }

        const elgK = getClass("elg");
        if (!elgK) { resolve({ ok: false, reason: "elg class not found" }); return; }
        const elgInsts = Il2Cpp.gc.choose(elgK);
        if (!elgInsts.length) { resolve({ ok: false, reason: "no live elg instance" }); return; }
        const elg = elgInsts[elgInsts.length - 1]!;

        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                (elg as any).method("baoi").invoke(mid, stuckCb, false);
                settle({ ok: true, mapId: mid, callbackSource: "eli.djze (reused)" });
            } catch (e) {
                settle({ ok: false, mapId: mid, callbackSource: "eli.djze (reused)", reason: "baoi threw: " + String(e).slice(0, 150) });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 5000);
    }));
}

// Narrow probes on the two methods identified as gatekeepers of the solve
// dispatch chain:
//   - elg.baoi(mapId, callback, async)  — UI/bbd entry that launches the
//     pathfind. If bbd's clean+dispatch doesn't reach baoi → guard early-return.
//   - foz.bgtq(fromV, toV, callback, force)  — the actual worldgraph solver.
//     If baoi is reached but bgtq isn't → eli.baop rejected the call.
//     If bgtq is reached but its `callback` is never invoked → solver runs
//     forever or fails silently.
// We also wrap the callback passed to bgtq so we observe when (if) the solve
// completes and with what success flag.
interface SolverHit {
    ts: number;
    method: string;
    args: string;
    ret?: string;
    threw?: string;
    note?: string;
}
const solverHits: SolverHit[] = [];
let solverProbesHooked = false;
const solverHookedMethods: Array<{ tag: string; m: any }> = [];

export function hookSolverProbes(): Promise<{ ok: boolean; hooked: string[]; reason?: string }> {
    return inVm(() => {
        if (solverProbesHooked) return { ok: true, hooked: [], reason: "already hooked" };
        const out: string[] = [];

        const tryHook = (klassName: string, methodName: string, wrapCallbackArgIdx: number = -1) => {
            try {
                const k = getClass(klassName);
                if (!k) { solverHits.push({ ts: Date.now(), method: `${klassName}.${methodName}`, args: "", note: "class not found" }); return; }
                const m = k.methods.find(mm => mm.name === methodName);
                if (!m) { solverHits.push({ ts: Date.now(), method: `${klassName}.${methodName}`, args: "", note: "method not found" }); return; }
                m.implementation = function (this: any, ...args: any[]): any {
                    const self = this as Il2Cpp.Object;
                    const tag = `${klassName}.${methodName}`;
                    const argsBrief: string[] = [];
                    for (let i = 0; i < args.length; i++) {
                        const a = args[i];
                        try {
                            if (a == null) argsBrief.push("null");
                            else if (typeof a === "object" && (a as any).class) argsBrief.push((a as any).class.name);
                            else argsBrief.push(String(a).slice(0, 18));
                        } catch { argsBrief.push("<?>"); }
                    }
                    solverHits.push({ ts: Date.now(), method: tag + " ENTRY", args: argsBrief.join(",") });
                    if (solverHits.length > 200) solverHits.shift();
                    let ret: any;
                    try {
                        if (m.isStatic) ret = (k as any).method(methodName).invoke(...args);
                        else ret = self.method(methodName).invoke(...args);
                    } catch (e) {
                        solverHits.push({ ts: Date.now(), method: tag + " THREW", args: argsBrief.join(","), threw: String(e).slice(0, 100) });
                        if (solverHits.length > 200) solverHits.shift();
                        throw e;
                    }
                    let retBrief = "<void>";
                    try {
                        if (ret == null) retBrief = String(ret);
                        else if (typeof ret === "object" && (ret as any).class) retBrief = (ret as any).class.name;
                        else retBrief = String(ret).slice(0, 50);
                    } catch {}
                    solverHits.push({ ts: Date.now(), method: tag + " RETURN", args: argsBrief.join(","), ret: retBrief });
                    if (solverHits.length > 200) solverHits.shift();
                    return ret;
                };
                solverHookedMethods.push({ tag: `${klassName}.${methodName}`, m });
                out.push(`${klassName}.${methodName}`);
            } catch (e) {
                solverHits.push({ ts: Date.now(), method: `${klassName}.${methodName}`, args: "", note: "hook err: " + String(e).slice(0, 60) });
            }
        };

        // Methods that internally call UniTask-returning code (bgtq) cannot be
        // hooked via m.implementation — our wrapper's invoke() crashes on the
        // UniTask marshaling, which breaks the UI's bbd chain. Confirmed broken:
        //   - foz.bgtq (returns UniTask directly)
        //   - elg.baoi (returns void but internally awaits bgtq → same crash)
        // Receiver candidates — pure void leaves, safe to hook. If any fires
        // we know the solve completed via callback.
        for (const m of ["cko", "jka", "baor", "cpr"]) tryHook("eli", m);

        solverProbesHooked = true;
        return { ok: true, hooked: out };
    });
}

export function unhookSolverProbes(): Promise<{ ok: boolean; restored: number }> {
    return inVm(() => {
        if (!solverProbesHooked) return { ok: true, restored: 0 };
        let restored = 0;
        for (const { m } of solverHookedMethods) {
            try { (m as any).implementation = null; restored++; } catch {}
        }
        solverHookedMethods.length = 0;
        solverProbesHooked = false;
        return { ok: true, restored };
    });
}

export function getSolverProbeHits(clear: boolean = false): Promise<SolverHit[]> {
    return inVm(() => {
        const copy = solverHits.slice();
        if (clear) solverHits.length = 0;
        return copy;
    });
}

// Read & optionally write foz.dpgl._state (the CancellationTokenSource).
// State semantics (from System.Threading source): 0=NotCanceled, 1=Notifying,
// 2=NotifyingComplete, 3=Canceled. If a previous bbd ended with the CTS in
// 1 or 2, every subsequent solve dispatched on this CTS short-circuits as
// "cancellation requested" → no path returned → no walk. This RPC reads
// the state and lets us force it back to 0 for testing.
export function probeFozCts(forceTo?: number | null): Promise<{
    ok: boolean;
    before?: number;
    after?: number;
    reason?: string;
}> {
    return inVm(() => {
        let foz = cachedFoz;
        if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
        if (!foz) {
            const fK = getClass("foz");
            if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
        }
        if (!foz) return { ok: false, reason: "no foz instance" };
        let cts: any;
        try { cts = (foz as any).field("dpgl").value; }
        catch (e) { return { ok: false, reason: "read dpgl: " + String(e).slice(0, 60) }; }
        if (!cts) return { ok: false, reason: "dpgl is null" };
        let before = -1;
        try { before = Number(cts.field("_state").value); }
        catch (e) { return { ok: false, reason: "read _state: " + String(e).slice(0, 60) }; }
        if (forceTo === undefined || forceTo === null) return { ok: true, before, after: before };
        try { cts.field("_state").value = forceTo; return { ok: true, before, after: forceTo }; }
        catch (e) { return { ok: false, before, reason: "write _state: " + String(e).slice(0, 60) }; }
    });
}

// Generic: invoke a method on the LAST live instance of `className` with args,
// dispatched on the Unity main thread. Args support primitives (number/bool/
// string) and JS null (for reference-typed parameters). Used to probe e.g.
// elg.baoi(mapId, null, false) directly — bypassing bbd's guard.
export function callOnLive(className: string, methodName: string, args: any[] = []): Promise<{
    ok: boolean;
    result?: string;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const klass = getClass(className);
        if (!klass) { resolve({ ok: false, reason: `class ${className} not found` }); return; }
        const arr = Il2Cpp.gc.choose(klass);
        if (!arr.length) { resolve({ ok: false, reason: `no live instance of ${className}` }); return; }
        const inst = arr[arr.length - 1]!;
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const method = (inst as any).method(methodName);
                // Coerce JS null on reference params → ptr(0); leave primitives as-is.
                const coerced = (args || []).map((a, i) => {
                    if (a === null || a === undefined) {
                        const pt = method.parameters[i]?.type?.name;
                        if (pt && (pt === "System.Int32" || pt === "System.Int64" || pt === "System.Boolean")) return 0;
                        return ptr(0);
                    }
                    return a;
                });
                const ret = method.invoke(...coerced);
                let out = "<void>";
                try {
                    if (ret === null || ret === undefined) out = String(ret);
                    else if (typeof ret === "object" && (ret as any).class) out = (ret as any).class.name;
                    else out = String(ret).slice(0, 100);
                } catch {}
                settle({ ok: true, result: out });
            } catch (e) {
                settle({ ok: false, reason: `${methodName} threw: ${String(e).slice(0, 150)}` });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Read (or write) a STATIC field on a class. Used to inspect foz.dpgi
// (the static System.Exception that catches solver exceptions — if non-null,
// every subsequent bgtq throws and returns empty path) and foz.dpgh / eli.djzd
// (the static cached PathFindingData, possibly the worldgraph instance).
export function probeStaticField(className: string, fieldName: string, writeNull: boolean = false): Promise<{
    ok: boolean;
    before?: any;
    wrote?: string;
    reason?: string;
}> {
    return inVm(() => {
        const k = getClass(className);
        if (!k) return { ok: false, reason: `class ${className} not found` };
        const f = k.fields.find(ff => ff.name === fieldName && ff.isStatic);
        if (!f) return { ok: false, reason: `static field ${fieldName} not found` };
        let before: any = "?";
        try {
            const v = (k as any).field(fieldName).value;
            if (v == null) before = String(v);
            else if (typeof v === "object" && (v as any).class) {
                const out: any = { _class: (v as any).class.name };
                // For Exception, dump Message + StackTrace.
                if ((v as any).class.name.includes("Exception")) {
                    try { out.Message = String((v as any).field("_message").value).slice(0, 200); } catch {}
                    try { out.StackTrace = String((v as any).field("_stackTraceString").value).slice(0, 400); } catch {}
                }
                // For other ref types, dump primitive fields.
                for (const ff of (v as any).class.fields) {
                    if (ff.isStatic) continue;
                    if (!ff.type.name.startsWith("System.") || ff.type.name === "System.Object") continue;
                    if (out[ff.name]) continue;
                    try { out[ff.name] = String((v as any).field(ff.name).value).slice(0, 80); } catch {}
                }
                before = out;
            } else before = String(v).slice(0, 80);
        } catch (e) { return { ok: false, reason: "read: " + String(e).slice(0, 80) }; }
        if (writeNull) {
            try { (k as any).field(fieldName).value = ptr(0); return { ok: true, before, wrote: "null" }; }
            catch (e) { return { ok: false, before, reason: "write: " + String(e).slice(0, 80) }; }
        }
        return { ok: true, before };
    });
}

// Invoke a STATIC method on a class. Used to call eli.baos(mapId, zone)
// which returns the canonical Vertex for a map — if the live cached vertex
// (eli.djzf, foz.dpgk) has a different m_uid than the canonical one, the
// worldgraph was regenerated under us and our cached Vertex is stale.
export function callStaticOnClass(className: string, methodName: string, args: any[] = []): Promise<{
    ok: boolean;
    result?: any;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const k = getClass(className);
        if (!k) { resolve({ ok: false, reason: `class ${className} not found` }); return; }
        const m = k.methods.find(mm => mm.name === methodName && mm.isStatic);
        if (!m) { resolve({ ok: false, reason: `static method ${methodName} not found` }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const coerced = (args || []).map((a, i) => {
                    if (a === null || a === undefined) {
                        const pt = m.parameters[i]?.type?.name;
                        if (pt && (pt === "System.Int32" || pt === "System.Int64" || pt === "System.Boolean")) return 0;
                        return ptr(0);
                    }
                    return a;
                });
                const ret = (k as any).method(methodName).invoke(...coerced);
                // For Vertex / PathFindingData / similar reference returns, dump fields.
                const out: any = {};
                if (ret == null) { settle({ ok: true, result: String(ret) }); return; }
                if (typeof ret !== "object") { settle({ ok: true, result: String(ret) }); return; }
                if (!(ret as any).class) { settle({ ok: true, result: "<unknown>" }); return; }
                out._class = (ret as any).class.name;
                for (const f of (ret as any).class.fields) {
                    if (f.isStatic) continue;
                    if (!f.type.name.startsWith("System.")) continue;
                    try { out[f.name] = String((ret as any).field(f.name).value).slice(0, 50); }
                    catch { out[f.name] = "<err>"; }
                }
                settle({ ok: true, result: out });
            } catch (e) {
                settle({ ok: false, reason: `${methodName} threw: ${String(e).slice(0, 120)}` });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 5000);
    }));
}

// Worldgraph cache for the in-agent pre-bbd reachability check.
// Built lazily on first call by reading foz.dpgh.m_outgoingEdges. Stays
// valid for the entire Frida session — the worldgraph is loaded once at
// Dofus login and never mutated by gameplay.
let _wgAdj: Record<string, number[]> | null = null;
let _wgUidToMid: Record<string, number> | null = null;
let _wgMidToUids: Map<number, number[]> | null = null;

function buildWorldgraphCacheInline(): boolean {
    const fK = getClass("foz");
    if (!fK) return false;
    let dpgh: any;
    try { dpgh = (fK as any).field("dpgh").value; } catch { return false; }
    if (!dpgh) return false;
    let outDict: any;
    try { outDict = (dpgh as any).field("m_outgoingEdges").value; } catch { return false; }
    if (!outDict) return false;
    let count = 0;
    try { count = Number((outDict as any).field("_count").value); } catch { return false; }
    const entries = (outDict as any).field("_entries").value as any;
    if (!entries) return false;
    const adj: Record<string, number[]> = {};
    const uidToMid: Record<string, number> = {};
    const N = Math.min(count, (entries as any).length ?? count);
    for (let i = 0; i < N; i++) {
        try {
            const e = (entries as any).get(i);
            if (Number(e.field("hashCode").value) < 0) continue;
            const srcUid = String(e.field("key").value);
            const wrapper = e.field("value").value as any;
            if (!wrapper) continue;
            const edgeList = (wrapper as any).field("m_edgeList").value as any;
            if (!edgeList) continue;
            const size = Number((edgeList as any).field("_size").value);
            const items = (edgeList as any).field("_items").value as any;
            if (!items) continue;
            const dests: number[] = [];
            for (let j = 0; j < size; j++) {
                try {
                    const edge = (items as any).get(j);
                    const fromV = (edge as any).field("m_from").value as any;
                    const toV = (edge as any).field("m_to").value as any;
                    if (!toV) continue;
                    const destUid = Number((toV as any).field("m_uid").value);
                    if (Number.isFinite(destUid)) {
                        dests.push(destUid);
                        try { uidToMid[String(destUid)] = Number((toV as any).field("m_mapId").value); } catch {}
                    }
                    if (fromV) {
                        try {
                            const fUid = Number((fromV as any).field("m_uid").value);
                            if (Number.isFinite(fUid)) uidToMid[String(fUid)] = Number((fromV as any).field("m_mapId").value);
                        } catch {}
                    }
                } catch {}
            }
            adj[srcUid] = dests;
        } catch {}
    }
    _wgAdj = adj;
    _wgUidToMid = uidToMid;
    _wgMidToUids = new Map();
    for (const [uidStr, mid] of Object.entries(uidToMid)) {
        const uid = Number(uidStr);
        const arr = _wgMidToUids.get(mid);
        if (arr) arr.push(uid); else _wgMidToUids.set(mid, [uid]);
    }
    console.log(`[worldgraph] cached ${Object.keys(adj).length} vertices, ${Object.keys(uidToMid).length} mapped uids`);
    return true;
}

function isReachableMapIds(srcMid: number, dstMid: number): { reachable: boolean; hops: number } {
    if (!_wgMidToUids) {
        if (!buildWorldgraphCacheInline()) return { reachable: false, hops: -1 };
    }
    if (srcMid === dstMid) return { reachable: true, hops: 0 };
    const startUids = _wgMidToUids!.get(srcMid) ?? [];
    if (!startUids.length) return { reachable: false, hops: -1 };
    const visitedMids = new Set<number>([srcMid]);
    let frontier = [...startUids];
    let hops = 0;
    while (frontier.length) {
        hops++;
        const next: number[] = [];
        for (const uid of frontier) {
            for (const destUid of _wgAdj![String(uid)] ?? []) {
                const destMid = _wgUidToMid![String(destUid)];
                if (!destMid || visitedMids.has(destMid)) continue;
                if (destMid === dstMid) return { reachable: true, hops };
                visitedMids.add(destMid);
                const allUids = _wgMidToUids!.get(destMid) ?? [];
                for (const u of allUids) next.push(u);
            }
        }
        frontier = next;
    }
    return { reachable: false, hops: -1 };
}

// Return all mapIds 1-hop reachable from `mapId` in the worldgraph (collapses
// zone-vertices, dedups by mapId). Used by the coverage panel's oscillation-
// unsticker: when the autopilot ping-pongs the player between two maps, pick
// a NEIGHBOR (not the bouncing pair) and route there to break the loop.
export function getNeighborMapIds(mapId: number | string): Promise<{
    ok: boolean;
    mapId?: number;
    neighbors?: number[];
    reason?: string;
}> {
    return inVm(() => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) return { ok: false, reason: `invalid mapId ${mapId}` };
        if (!_wgMidToUids) {
            if (!buildWorldgraphCacheInline()) return { ok: false, reason: "worldgraph cache build failed" };
        }
        const uids = _wgMidToUids!.get(mid) ?? [];
        if (!uids.length) return { ok: false, mapId: mid, reason: "mapId not in worldgraph" };
        const seen = new Set<number>();
        for (const u of uids) {
            for (const d of _wgAdj![String(u)] ?? []) {
                const dm = _wgUidToMid![String(d)];
                if (dm && dm !== mid) seen.add(dm);
            }
        }
        return { ok: true, mapId: mid, neighbors: Array.from(seen) };
    });
}

// Synthetic autopilot: compute path via pure BFS on the worldgraph adjacency,
// reuse the existing Edge instances from m_outgoingEdges (so m_transitions
// stay valid), inject them into foz.dpgs (the path list dtt.cwi reads),
// then call dtt.cwi(foz.dpgs, false) + dtt.tkh(targetMapId, true) to bypass
// the broken solver and trigger the walk. Last-resort recovery when the
// solver foz keeps returning empty paths despite the graph being reachable.
export function injectBfsPathAndWalk(targetMapId: number | string): Promise<{
    ok: boolean;
    srcUid?: number;
    dstUid?: number;
    pathSize?: number;
    edgeMissingAt?: number;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const tmid = typeof targetMapId === "string" ? parseInt(targetMapId, 10) : targetMapId;
        if (!Number.isFinite(tmid) || tmid <= 0) { resolve({ ok: false, reason: `invalid mapId ${targetMapId}` }); return; }

        // 1. Get the current map's vertex via baos (eli.djzf is the LAST query
        // target, not necessarily the player's current position).
        const eK = getClass("eli");
        if (!eK) { resolve({ ok: false, reason: "eli class not found" }); return; }
        // Read currentMapId from MapDisplayService — same source as
        // getCurrentMapId RPC.
        let curMid = -1;
        try {
            const mds = getClass("ecu");
            if (mds) {
                const arr = Il2Cpp.gc.choose(mds);
                if (arr.length) {
                    const inst = arr[arr.length - 1]!;
                    try { curMid = Number((inst as any).field("<eyc>k__BackingField").value); } catch {}
                }
            }
        } catch {}
        if (curMid < 0) {
            // Fallback: try eli.djzf's mapId — at least gives us SOMETHING
            try {
                const eliInsts = Il2Cpp.gc.choose(eK);
                if (eliInsts.length) {
                    const v = (eliInsts[eliInsts.length - 1]! as any).field("djzf").value;
                    if (v) curMid = Number((v as any).field("m_mapId").value);
                }
            } catch {}
        }
        if (curMid < 0) { resolve({ ok: false, reason: "could not resolve current map id" }); return; }

        let srcUid = -1;
        try {
            const baosSrc = (eK as any).method("baos").invoke(curMid as any, 1);
            if (baosSrc) srcUid = Number((baosSrc as any).field("m_uid").value);
        } catch (e) { resolve({ ok: false, reason: "baos(src): " + String(e).slice(0, 60) }); return; }
        if (srcUid < 0) { resolve({ ok: false, reason: "baos returned null vertex for src" }); return; }

        // 2. Resolve target via static baos
        let dstUid = -1;
        try {
            const baos = (eK as any).method("baos").invoke(tmid as any, 1);
            if (baos) dstUid = Number((baos as any).field("m_uid").value);
        } catch (e) { resolve({ ok: false, reason: "baos(dst): " + String(e).slice(0, 60) }); return; }
        if (dstUid < 0) { resolve({ ok: false, reason: "baos returned null vertex for target" }); return; }

        // 3. Read foz.dpgh.m_outgoingEdges (DictionaryUlongEdgeList)
        const fK = getClass("foz");
        if (!fK) { resolve({ ok: false, reason: "foz class not found" }); return; }
        const dpgh = (fK as any).field("dpgh").value;
        if (!dpgh) { resolve({ ok: false, reason: "foz.dpgh is null" }); return; }
        const outDict = (dpgh as any).field("m_outgoingEdges").value as any;
        if (!outDict) { resolve({ ok: false, reason: "m_outgoingEdges null" }); return; }

        // Build a JS map of uid → Edge[] (reusing existing Edge instances).
        // Iterate Dictionary entries.
        const adjEdges = new Map<number, Array<{ destUid: number; edge: any }>>();
        try {
            const count = Number((outDict as any).field("_count").value);
            const entries = (outDict as any).field("_entries").value as any;
            const N = Math.min(count, (entries as any).length ?? count);
            for (let i = 0; i < N; i++) {
                try {
                    const e = (entries as any).get(i);
                    if (Number(e.field("hashCode").value) < 0) continue;
                    const srcU = Number(e.field("key").value);
                    const wrapper = e.field("value").value as any;
                    if (!wrapper) continue;
                    const edgeList = (wrapper as any).field("m_edgeList").value as any;
                    if (!edgeList) continue;
                    const sz = Number((edgeList as any).field("_size").value);
                    const items = (edgeList as any).field("_items").value as any;
                    if (!items) continue;
                    const arr: Array<{ destUid: number; edge: any }> = [];
                    for (let j = 0; j < sz; j++) {
                        try {
                            const edge = (items as any).get(j);
                            const toV = (edge as any).field("m_to").value as any;
                            if (!toV) continue;
                            const destU = Number((toV as any).field("m_uid").value);
                            if (Number.isFinite(destU)) arr.push({ destUid: destU, edge });
                        } catch {}
                    }
                    adjEdges.set(srcU, arr);
                } catch {}
            }
        } catch (e) { resolve({ ok: false, reason: "adj scan: " + String(e).slice(0, 60) }); return; }

        // 4. BFS srcUid → dstUid, recording parent edges.
        if (srcUid === dstUid) { resolve({ ok: false, srcUid, dstUid, reason: "src == dst, nothing to do" }); return; }
        const parent = new Map<number, { from: number; edge: any }>();
        const visited = new Set<number>([srcUid]);
        const queue: number[] = [srcUid];
        let found = false;
        let it = 0;
        while (queue.length && it < 100000) {
            it++;
            const cur = queue.shift()!;
            for (const { destUid: nx, edge } of adjEdges.get(cur) ?? []) {
                if (visited.has(nx)) continue;
                visited.add(nx);
                parent.set(nx, { from: cur, edge });
                if (nx === dstUid) { found = true; break; }
                queue.push(nx);
            }
            if (found) break;
        }
        if (!found) { resolve({ ok: false, srcUid, dstUid, reason: "BFS: no path on adjacency" }); return; }

        // 5. Reconstruct path edges in order src→dst.
        const pathEdges: any[] = [];
        let cur = dstUid;
        while (cur !== srcUid) {
            const p = parent.get(cur)!;
            pathEdges.unshift(p.edge);
            cur = p.from;
        }

        // 6. Inject: Clear foz.dpgs then Add each Edge in order.
        const fozInsts = Il2Cpp.gc.choose(fK);
        if (!fozInsts.length) { resolve({ ok: false, reason: "no live foz" }); return; }
        const foz = fozInsts[fozInsts.length - 1]!;
        const dpgs = (foz as any).field("dpgs").value as any;
        if (!dpgs) { resolve({ ok: false, reason: "foz.dpgs null" }); return; }
        try {
            (dpgs as any).method("Clear").invoke();
            for (let i = 0; i < pathEdges.length; i++) {
                try { (dpgs as any).method("Add").invoke(pathEdges[i]); }
                catch (e) { resolve({ ok: false, srcUid, dstUid, edgeMissingAt: i, reason: "Add edge " + i + ": " + String(e).slice(0, 60) }); return; }
            }
        } catch (e) { resolve({ ok: false, reason: "inject: " + String(e).slice(0, 60) }); return; }

        // 7. Trigger the walk:
        //    a. Set dtt.dejp = foz.dpgs DIRECTLY so dtt sees the path as
        //       "expected hops" — without this, every map change triggered by
        //       cwi triggers the "Annulation du voyage suite à un changement
        //       de carte manuel" message and dtt cancels the autopilot.
        //    b. dtt.cwi(dpgs, false) — internal setup
        //    c. dtt.tkh(targetMapId, true) — first hop launcher
        const dK = getClass("dtt");
        if (!dK) { resolve({ ok: false, reason: "dtt class not found" }); return; }
        const dttInsts = Il2Cpp.gc.choose(dK);
        if (!dttInsts.length) { resolve({ ok: false, reason: "no live dtt" }); return; }
        const dtt = dttInsts[dttInsts.length - 1]!;
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                (dtt as any).field("dejp").value = dpgs;
            } catch (e) { settle({ ok: false, srcUid, dstUid, pathSize: pathEdges.length, reason: "set dejp: " + String(e).slice(0, 80) }); return; }
            try {
                (dtt as any).method("cwi").invoke(dpgs, false);
            } catch (e) { settle({ ok: false, srcUid, dstUid, pathSize: pathEdges.length, reason: "cwi: " + String(e).slice(0, 80) }); return; }
            try {
                (dtt as any).method("tkh").invoke(tmid as any, true);
            } catch (e) { settle({ ok: false, srcUid, dstUid, pathSize: pathEdges.length, reason: "tkh: " + String(e).slice(0, 80) }); return; }
            settle({ ok: true, srcUid, dstUid, pathSize: pathEdges.length });
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 5000);
    }));
}

// Dump the full worldgraph adjacency list from foz.dpgh.m_outgoingEdges.
// Returns { srcUid: [destUid, ...], ... } as a JSON-friendly Record.
// Used by the coverage panel to BFS-check reachability before firing bbd —
// avoids dispatching to non-reachable maps which (per user observation)
// corrupts the worldgraph state and triggers Tier 2 bricking.
// Pure read of static field + dict iteration. Does NOT touch solver state.
export function dumpOutgoingEdges(): Promise<{
    ok: boolean;
    adjacency?: Record<string, number[]>;
    uidToMapId?: Record<string, number>;
    vertexCount?: number;
    edgeCount?: number;
    mappedUids?: number;
    reason?: string;
}> {
    return inVm(() => {
        const fK = getClass("foz");
        if (!fK) return { ok: false, reason: "foz class not found" };
        let dpgh: any;
        try { dpgh = (fK as any).field("dpgh").value; }
        catch (e) { return { ok: false, reason: "read dpgh: " + String(e).slice(0, 60) }; }
        if (!dpgh) return { ok: false, reason: "foz.dpgh is null" };
        let outDict: any;
        try { outDict = (dpgh as any).field("m_outgoingEdges").value; }
        catch (e) { return { ok: false, reason: "read m_outgoingEdges: " + String(e).slice(0, 60) }; }
        if (!outDict) return { ok: false, reason: "m_outgoingEdges is null" };

        let count = 0;
        try { count = Number((outDict as any).field("_count").value); }
        catch (e) { return { ok: false, reason: "_count: " + String(e).slice(0, 60) }; }
        const entries = (outDict as any).field("_entries").value as any;
        if (!entries) return { ok: false, reason: "no _entries" };

        const adjacency: Record<string, number[]> = {};
        // uid → mapId mapping. The game pathfinder treats all zone-vertices
        // of a map as a single logical map node, so we need this to BFS at
        // mapId level (any-to-any) for symmetric reachability.
        const uidToMapId: Record<string, number> = {};
        let edgeCount = 0;
        const N = Math.min(count, (entries as any).length ?? count);
        for (let i = 0; i < N; i++) {
            try {
                const e = (entries as any).get(i);
                if (Number(e.field("hashCode").value) < 0) continue;
                const srcUid = String(e.field("key").value);
                const wrapper = e.field("value").value as any;
                if (!wrapper) continue;
                const edgeList = (wrapper as any).field("m_edgeList").value as any;
                if (!edgeList) continue;
                const size = Number((edgeList as any).field("_size").value);
                const items = (edgeList as any).field("_items").value as any;
                if (!items) continue;
                const dests: number[] = [];
                for (let j = 0; j < size; j++) {
                    try {
                        const edge = (items as any).get(j);
                        const fromV = (edge as any).field("m_from").value as any;
                        const toV = (edge as any).field("m_to").value as any;
                        if (!toV) continue;
                        const destUid = Number((toV as any).field("m_uid").value);
                        if (Number.isFinite(destUid)) {
                            dests.push(destUid);
                            try { uidToMapId[String(destUid)] = Number((toV as any).field("m_mapId").value); } catch {}
                        }
                        if (fromV) {
                            try {
                                const fUid = Number((fromV as any).field("m_uid").value);
                                if (Number.isFinite(fUid)) uidToMapId[String(fUid)] = Number((fromV as any).field("m_mapId").value);
                            } catch {}
                        }
                    } catch {}
                }
                adjacency[srcUid] = dests;
                edgeCount += dests.length;
            } catch {}
        }

        return {
            ok: true, adjacency, uidToMapId,
            vertexCount: Object.keys(adjacency).length,
            edgeCount,
            mappedUids: Object.keys(uidToMapId).length,
        };
    });
}

// Scan every class in every assembly and find methods whose return type or
// parameter list mentions one of the given type names. Used to find every
// entry point that constructs / consumes a PathFindingData — likely yields
// the loader/initializer we cannot find via field scan.
export function findMethodsWithType(typeNames: string[], limit: number = 100): Promise<Array<{
    cls: string; ns: string; method: string; isStatic: boolean; ret: string; params: string;
}>> {
    return inVm(() => {
        const needles = typeNames.map(t => t.toLowerCase());
        const out: Array<{ cls: string; ns: string; method: string; isStatic: boolean; ret: string; params: string }> = [];
        const matchType = (n: string) => {
            const lo = n.toLowerCase();
            return needles.some(nd => lo === nd || lo.endsWith("." + nd) || lo.endsWith("/" + nd) || lo.includes(nd));
        };
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    const ns = k.namespace ?? "";
                    if (ns.startsWith("System") || ns.startsWith("UnityEngine") || ns.startsWith("Mono.")) continue;
                    try {
                        for (const m of k.methods) {
                            const retName = m.returnType.name;
                            const retMatch = matchType(retName);
                            const paramTypes = m.parameters.map(p => p.type.name);
                            const paramMatch = paramTypes.some(p => matchType(p));
                            if (!retMatch && !paramMatch) continue;
                            out.push({
                                cls: k.name, ns, method: m.name, isStatic: m.isStatic,
                                ret: retName.replace(/^.+\./, ""),
                                params: paramTypes.map(p => p.replace(/^.+\./, "")).join(","),
                            });
                            if (out.length >= limit) return out;
                        }
                    } catch {}
                }
            } catch {}
        }
        return out;
    });
}

// Scan every class in every assembly and find ones that have a field whose
// type matches one of the given type names (full name or simple name).
// Used to find consumer/loader classes for PathFindingData (worldgraph) so
// we can identify a re-init / re-load entry point — without restart.
export function findClassesWithFieldType(typeNames: string[], limit: number = 100): Promise<Array<{
    cls: string; ns: string; field: string; isStatic: boolean; methods: number;
}>> {
    return inVm(() => {
        const needles = typeNames.map(t => t.toLowerCase());
        const out: Array<{ cls: string; ns: string; field: string; isStatic: boolean; methods: number }> = [];
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    const ns = k.namespace ?? "";
                    if (ns.startsWith("System") || ns.startsWith("UnityEngine") || ns.startsWith("Mono.")) continue;
                    try {
                        for (const f of k.fields) {
                            const tn = f.type.name.toLowerCase();
                            if (needles.some(n => tn === n || tn.endsWith("." + n) || tn.endsWith("/" + n))) {
                                out.push({ cls: k.name, ns, field: f.name, isStatic: f.isStatic, methods: k.methods.length });
                                if (out.length >= limit) return out;
                                break;
                            }
                        }
                    } catch {}
                }
            } catch {}
        }
        return out;
    });
}

// When foz solver has resolved a path (foz.dpgs = List[N]) but the callback
// `eli.djze` failed to fire and transfer it into dtt.dejp, we can manually
// invoke `dtt.cwi(path, false)` which is what the callback would normally do.
// This reads foz.dpgs and pipes it to dtt.cwi on the main thread.
export function triggerWalkFromFozPath(): Promise<{
    ok: boolean;
    pathSize?: number;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const fK = getClass("foz");
        if (!fK) { resolve({ ok: false, reason: "foz class not found" }); return; }
        const fInsts = Il2Cpp.gc.choose(fK);
        if (!fInsts.length) { resolve({ ok: false, reason: "no live foz" }); return; }
        const foz = fInsts[fInsts.length - 1]!;
        let path: any;
        try { path = (foz as any).field("dpgs").value; }
        catch (e) { resolve({ ok: false, reason: "read dpgs: " + String(e).slice(0, 60) }); return; }
        if (!path) { resolve({ ok: false, reason: "foz.dpgs is null — no path to trigger" }); return; }
        let pathSize = -1;
        try { pathSize = Number((path as any).field("_size").value); }
        catch {}
        if (pathSize === 0) { resolve({ ok: false, pathSize, reason: "foz.dpgs is empty" }); return; }

        const dK = getClass("dtt");
        if (!dK) { resolve({ ok: false, reason: "dtt class not found" }); return; }
        const dInsts = Il2Cpp.gc.choose(dK);
        if (!dInsts.length) { resolve({ ok: false, reason: "no live dtt" }); return; }
        const dtt = dInsts[dInsts.length - 1]!;

        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                (dtt as any).method("cwi").invoke(path, false);
                settle({ ok: true, pathSize });
            } catch (e) {
                settle({ ok: false, pathSize, reason: "cwi threw: " + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 5000);
    }));
}

// Surgical: Clear() the two big foz dictionaries dpgn + dpgp that fullFozReset
// doesn't touch. Hypothesis (2026-04-27): these are the A* closed/open lists,
// pre-bloated from a stuck previous solve, causing the solver to return
// "path empty" because it thinks all nodes were already visited.
export function clearFozOpenClosed(): Promise<{ ok: boolean; cleared: string[]; reason?: string }> {
    return inVm(() => {
        const fozK = getClass("foz");
        if (!fozK) return { ok: false, cleared: [], reason: "foz class not found" };
        const arr = Il2Cpp.gc.choose(fozK);
        if (!arr.length) return { ok: false, cleared: [], reason: "no live foz" };
        const foz = arr[arr.length - 1]!;
        const cleared: string[] = [];
        for (const fname of ["dpgn", "dpgp"]) {
            try {
                const coll = (foz as any).field(fname).value;
                if (!coll) { cleared.push(`${fname}=null skip`); continue; }
                let sizeBefore = -1;
                try { sizeBefore = Number((coll as any).field("_count").value); }
                catch { try { sizeBefore = Number((coll as any).field("_size").value); } catch {} }
                (coll as any).method("Clear").invoke();
                cleared.push(`${fname} ${sizeBefore}→0`);
            } catch (e) { cleared.push(`${fname} threw: ${String(e).slice(0, 40)}`); }
        }
        return { ok: true, cleared };
    });
}

// Dump the start/end Vertex + MapInformationData currently held by the
// pathfinder. Vertex has m_mapId/m_zoneId/m_uid (per RE doc); MapInformationData
// has a Long mapId field. Used to verify that bbd is actually solving from
// the player's CURRENT map to the requested target — corrupted cached vertices
// could explain "no path found" on a reachable destination.
export function dumpFozPathEnds(): Promise<{ ok: boolean; data?: any; reason?: string }> {
    return inVm(() => {
        const out: any = {};
        const readVertex = (label: string, v: any) => {
            if (!v) { out[label] = "null"; return; }
            try {
                const fs: Record<string, any> = {};
                for (const f of (v as any).class.fields) {
                    if (f.isStatic) continue;
                    try { fs[f.name] = String((v as any).field(f.name).value).slice(0, 60); }
                    catch (e) { fs[f.name] = "<read err>"; }
                }
                out[label] = fs;
            } catch (e) { out[label] = "<err: " + String(e).slice(0, 50) + ">"; }
        };
        const readMid = (label: string, m: any) => {
            if (!m) { out[label] = "null"; return; }
            try {
                const fs: Record<string, any> = {};
                for (const f of (m as any).class.fields) {
                    if (f.isStatic) continue;
                    const fn = f.name;
                    // Only dump primitive-typed fields to avoid recursion / huge dumps.
                    if (!f.type.name.startsWith("System.")) continue;
                    try { fs[fn] = String((m as any).field(fn).value).slice(0, 60); }
                    catch { fs[fn] = "<err>"; }
                }
                out[label] = fs;
            } catch (e) { out[label] = "<err: " + String(e).slice(0, 50) + ">"; }
        };
        try {
            const fK = getClass("foz");
            if (fK) {
                const arr = Il2Cpp.gc.choose(fK);
                if (arr.length) {
                    const foz = arr[arr.length - 1]!;
                    try { readMid("foz.dpgj_MapInformationData", (foz as any).field("dpgj").value); } catch {}
                    try { readVertex("foz.dpgk_Vertex", (foz as any).field("dpgk").value); } catch {}
                }
            }
        } catch {}
        try {
            const eK = getClass("eli");
            if (eK) {
                const arr = Il2Cpp.gc.choose(eK);
                if (arr.length) {
                    const eli = arr[arr.length - 1]!;
                    try { readVertex("eli.djzf_Vertex", (eli as any).field("djzf").value); } catch {}
                    try { out["eli.djzg_targetMapId"] = String((eli as any).field("djzg").value); } catch {}
                    try { out["eli.djzh_state"] = String((eli as any).field("djzh").value); } catch {}
                }
            }
        } catch {}
        try {
            const dK = getClass("dtt");
            if (dK) {
                const arr = Il2Cpp.gc.choose(dK);
                if (arr.length) {
                    const dtt = arr[arr.length - 1]!;
                    try { readMid("dtt.dejo_MapInformationData", (dtt as any).field("dejo").value); } catch {}
                }
            }
        } catch {}
        return { ok: true, data: out };
    });
}

// Generic: write an integer value into ANY int-typed field of any class's
// last live instance. Used to probe eli.djzh (the suspected state machine
// that bbd checks before dispatching) — empirical observation 2026-04-27 is
// that djzh=3 after a stuck solve, while healthy idle is djzh=0 (untested
// but plausible). Setting to 0 should let bbd dispatch a fresh solve.
export function setIntField(className: string, fieldName: string, value: number): Promise<{
    ok: boolean;
    before?: number;
    after?: number;
    reason?: string;
}> {
    return inVm(() => {
        const k = getClass(className);
        if (!k) return { ok: false, reason: `class ${className} not found` };
        const arr = Il2Cpp.gc.choose(k);
        if (!arr.length) return { ok: false, reason: `no live ${className}` };
        const inst = arr[arr.length - 1]!;
        let before = -1;
        try { before = Number((inst as any).field(fieldName).value); }
        catch (e) { return { ok: false, reason: "read: " + String(e).slice(0, 60) }; }
        try { (inst as any).field(fieldName).value = value; return { ok: true, before, after: value }; }
        catch (e) { return { ok: false, before, reason: "write: " + String(e).slice(0, 60) }; }
    });
}

// Surgical: write `null` into one of dtt's fields. Use to test which field
// gates the "Une recherche d'itinéraire est déjà en cours" reject — empirical
// suspicion is `dejo` (current target MapInformationData) since neither
// abortAutoTravel nor a havre-sac round-trip clears it once a previous
// autopilot was interrupted without a clean tkl callback.
export function nullDttField(fieldName: string): Promise<{
    ok: boolean;
    fieldName: string;
    before?: string;
    reason?: string;
}> {
    return inVm(() => {
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) return { ok: false, fieldName, reason: "dtt unavailable" };
        let before = "?";
        try {
            const v = (dtt as any).field(fieldName).value;
            if (v === null) before = "null";
            else if (typeof v === "object" && (v as any).class) before = (v as any).class.name;
            else before = String(v).slice(0, 40);
        } catch (e) { before = `<read err: ${String(e).slice(0, 40)}>`; }
        // Frida-il2cpp-bridge wants a NativePointer for Object fields, not JS null.
        // Try the JS-null path first (works for List<T> fields), fall back to a
        // NULL pointer wrapped as Il2Cpp.Object for plain reference fields.
        try { (dtt as any).field(fieldName).value = null; return { ok: true, fieldName, before, via: "js-null" }; }
        catch {}
        try {
            (dtt as any).field(fieldName).value = ptr(0) as any;
            return { ok: true, fieldName, before, via: "ptr(0)" };
        } catch (e2) {
            return { ok: false, fieldName, before, reason: `null:expected-ptr; NULL:${String(e2).slice(0, 80)}` };
        }
    });
}

// Snapshot all instance fields of every autopilot-related class. Use to diff
// clean vs stuck state and identify which class holds the leaking state.
export function snapshotAutopilotState(): Promise<{
    ok: boolean;
    classes: Record<string, Record<string, string>>;
    reason?: string;
}> {
    return inVm(() => {
        const classes: Record<string, Record<string, string>> = {};
        const names = ["dtt", "foz", "elg", "eli", "elf", "eld", "cod"];
        for (const cn of names) {
            try {
                const k = getClass(cn);
                if (!k) { classes[cn] = { _err: "class not found" }; continue; }
                const insts = Il2Cpp.gc.choose(k);
                if (!insts.length) { classes[cn] = { _err: "no instance" }; continue; }
                const inst = insts[insts.length - 1]!;
                const out: Record<string, string> = {};
                out["_instCount"] = String(insts.length);
                for (const f of inst.class.fields) {
                    if (f.isStatic) continue;
                    try {
                        const v = inst.field(f.name).value as any;
                        if (v === null || v === undefined) { out[f.name] = "null"; continue; }
                        if (typeof v === "object" && v.class) {
                            const tn = v.class.name;
                            let cnt: number | null = null;
                            try { cnt = Number(v.field("_count").value); } catch {}
                            if (cnt === null) { try { cnt = Number(v.field("_size").value); } catch {} }
                            out[f.name] = cnt === null ? tn : `${tn}[${cnt}]`;
                        } else out[f.name] = String(v).slice(0, 40);
                    } catch (e) { out[f.name] = `<err:${String(e).slice(0, 25)}>`; }
                }
                classes[cn] = out;
            } catch (e) { classes[cn] = { _err: String(e).slice(0, 60) }; }
        }
        return { ok: true, classes };
    });
}

// MEGA RESET — invoke .ctor() on each live autopilot service instance, then
// Clear() every Dict/List field. Maximum agent-side reset short of a Dofus
// restart. HIGH RISK — may crash the game. Use only when stuck.
export function megaAutopilotReset(): Promise<{
    ok: boolean;
    cleaned: string[];
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, cleaned: [], reason: "main-thread dispatcher attach failed" }); return; }
        const cleaned: string[] = [];
        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            // Order matters: reset solver/builder first, then orchestrator last.
            for (const cn of ["foz", "eli", "elg", "elf", "eld", "cod"]) {
                try {
                    const k = getClass(cn);
                    if (!k) { cleaned.push(`${cn}: no class`); continue; }
                    const insts = Il2Cpp.gc.choose(k);
                    if (!insts.length) { cleaned.push(`${cn}: no instance`); continue; }
                    const inst = insts[insts.length - 1]!;
                    try { (inst as any).method(".ctor").invoke(); cleaned.push(`${cn}.ctor()`); }
                    catch (e) { cleaned.push(`${cn}.ctor threw: ${String(e).slice(0, 50)}`); }
                    try {
                        for (const f of inst.class.fields) {
                            if (f.isStatic) continue;
                            try {
                                const v = (inst as any).field(f.name).value;
                                if (!v || typeof v !== "object" || !(v as any).class) continue;
                                const tn = (v as any).class.name;
                                if (/^List`|^Dictionary`|^HashSet`|^Queue`|^Stack`/.test(tn)) {
                                    try { (v as any).method("Clear").invoke(); cleaned.push(`${cn}.${f.name}.Clear`); } catch {}
                                }
                            } catch {}
                        }
                    } catch {}
                } catch (e) { cleaned.push(`${cn}: ${String(e).slice(0, 50)}`); }
            }
            try {
                const dtt = resolveOrSynthesizeDtt();
                if (dtt) { (dtt as any).field("deiz").value = false; cleaned.push("dtt.deiz=false"); }
            } catch {}
            settle({ ok: true, cleaned });
        };
        setTimeout(() => settle({ ok: false, cleaned, reason: "main-thread dispatch timeout" }), 5000);
    }));
}

// Test variant: reuse an existing dch instance from the heap instead of
// allocating a new one. Theory: a dch created by the game's natural cascade
// has correct internal metadata (vtable, gc-class, etc) while (dchKlass).new()
// might miss something subtle that bbd's internals rely on.
export function autoTravelReuseDch(mapId: number | string, instantFlag: boolean | null = true): Promise<{
    ok: boolean;
    reason?: string;
    targetMapId?: number;
    dchHandleUsed?: string;
    dchCount?: number;
}> {
    return inVm(() => new Promise((resolve) => {
        const mid = typeof mapId === "string" ? parseInt(mapId, 10) : mapId;
        if (!Number.isFinite(mid) || mid <= 0) { resolve({ ok: false, reason: `invalid mapId ${mapId}` }); return; }
        const dbkl = instantFlag === null || instantFlag === undefined ? true : !!instantFlag;
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) { resolve({ ok: false, reason: "dtt unavailable" }); return; }
        const dchKlass = getClass("dch");
        if (!dchKlass) { resolve({ ok: false, reason: "dch class not found" }); return; }
        // Find existing dch instances in the heap.
        const existing = Il2Cpp.gc.choose(dchKlass);
        if (!existing.length) { resolve({ ok: false, reason: "no existing dch in heap — game hasn't created any yet" }); return; }
        const dch = existing[existing.length - 1]!;
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                (dch as any).field("dbkk").value = mid;
                (dch as any).field("dbkl").value = dbkl;
                try { (dtt as any).method("bbd").invoke(dch); }
                catch { /* cosmetic Frida throw */ }
                settle({ ok: true, targetMapId: mid, dchHandleUsed: String((dch as any).handle), dchCount: existing.length });
            } catch (e) {
                settle({ ok: false, reason: "build/invoke threw: " + String(e).slice(0, 120), targetMapId: mid });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Resolve a raw IL2CPP address against the full method table — returns the
// closest method regardless of offset, so we can identify "near matches" that
// resolveFrame's strict threshold rejects. Useful for triaging stack frames
// captured by hookBbdEntry that fall in IL2CPP space but didn't pin a method.
export function resolveAddress(addrHex: string): Promise<{
    ok: boolean;
    nearestMethod?: { cls: string; name: string; offsetHex: string };
    reason?: string;
    tableSize?: number;
    tableFirst?: string;
    tableLast?: string;
    targetNormalized?: string;
}> {
    return inVm(() => {
        if (!methodTable.length) buildIl2cppMethodTable();
        let target = addrHex.toLowerCase();
        if (target.startsWith("0x")) target = target.slice(2);
        target = target.padStart(16, "0");
        const diag = {
            tableSize: methodTable.length,
            tableFirst: methodTable.length ? methodTable[0].addrHex : "",
            tableLast: methodTable.length ? methodTable[methodTable.length - 1].addrHex : "",
            targetNormalized: target,
        };
        let lo = 0, hi = methodTable.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (methodTable[mid].addrHex <= target) { best = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        if (best < 0) return { ok: false, reason: "no method below this address", ...diag };
        const m = methodTable[best];
        const offset = BigInt("0x" + target) - BigInt("0x" + m.addrHex);
        return { ok: true, nearestMethod: { cls: m.cls, name: m.name, offsetHex: "0x" + offset.toString(16) }, ...diag };
    });
}

// Capture every dtt.bbd call with its arg + a resolved backtrace, into a
// retrievable buffer. Single-method hook (NOT hookAutopilot's 165-wrapper
// blanket) so the cascade isn't poisoned — confirmed live: with this single
// hook installed, manual UI clicks still trigger movement normally. Goal:
// identify the UI handler that calls dtt.bbd in the natural flow, so we can
// invoke that handler from agent code (a higher-level entry that's outside
// the async cascade and thus safe to runtime_invoke).
interface BbdEntry { ts: number; mapId: number; dbkl: string; frames: string[]; }
const bbdEntries: BbdEntry[] = [];
let bbdEntryHooked = false;
let bbdEntryMethod: any = null;

export function hookBbdEntry(maxFrames: number = 30): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        if (bbdEntryHooked) return { ok: true, reason: "already hooked" };
        const dttKlass = getClass("dtt");
        if (!dttKlass) return { ok: false, reason: "dtt not found" };
        let bbd: any = null;
        for (const m of dttKlass.methods) { if (m.name === "bbd") { bbd = m; break; } }
        if (!bbd) return { ok: false, reason: "dtt.bbd not found" };
        // Need the method-address table for resolveFrame to give Cls.method+0xN names.
        if (!methodTable.length) buildIl2cppMethodTable();

        try {
            bbd.implementation = function (this: any, dch: any): any {
                let mapId = -1, dbkl = "?";
                try { mapId = Number((dch as any).field("dbkk").value); } catch {}
                try { dbkl = String((dch as any).field("dbkl").value); } catch {}
                const frames: string[] = [];
                try {
                    const bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                    for (let i = 0; i < Math.min(bt.length, maxFrames); i++) {
                        frames.push(resolveFrame(bt[i]));
                    }
                } catch {}
                bbdEntries.push({ ts: Date.now(), mapId, dbkl, frames });
                if (bbdEntries.length > 50) bbdEntries.shift();
                // Re-invoke original — re-entrant via Frida's bypass of the wrapper.
                return (this as Il2Cpp.Object).method("bbd").invoke(dch);
            };
            bbdEntryHooked = true;
            bbdEntryMethod = bbd;
            console.log("[bbd-entry] hooked dtt.bbd with stack capture");
            return { ok: true };
        } catch (e) { return { ok: false, reason: String(e).slice(0, 120) }; }
    });
}

export function unhookBbdEntry(): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        if (!bbdEntryHooked) return { ok: true, reason: "not hooked" };
        try { if (bbdEntryMethod) bbdEntryMethod.implementation = null; } catch {}
        bbdEntryHooked = false;
        bbdEntryMethod = null;
        return { ok: true };
    });
}

export function getBbdEntries(): Promise<BbdEntry[]> {
    return inVm(() => bbdEntries.map(e => ({ ...e })));
}

export function clearBbdEntries(): Promise<number> {
    return inVm(() => { const n = bbdEntries.length; bbdEntries.length = 0; return n; });
}

// Programmatically enter the player's havre-sac by building + sending the
// `igd` outgoing packet — same as pressing the H key in-game. Confirmed
// 2026-04-27 via H-keystroke trace: pressing H sent `igd{ecxt=havreSacId}`
// followed by `jmw{ekry=havreSacMapId}` from the server. This is the
// recovery primitive for hard-stuck pathfind: real map change triggers
// `dtt.kwd(dci)` cascade which cancels the hung async solve. Pass a
// havreSacId (72182268199 for the test user). Returns whether the send
// succeeded — but the actual recovery needs a return-trip too (use the
// game UI to come back, or call this again with the same id which Dofus
// uses as a toggle).
export function enterHavreSac(havreSacId: number | string): Promise<{
    ok: boolean;
    havreSacId?: number;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const id = typeof havreSacId === "string" ? Number(havreSacId) : havreSacId;
        if (!Number.isFinite(id) || id <= 0) {
            resolve({ ok: false, reason: `invalid havreSacId ${havreSacId}` }); return;
        }
        const igdK = getClass("igd");
        if (!igdK) { resolve({ ok: false, reason: "igd class not found" }); return; }
        const ecuK = getClass("ecu");
        if (!ecuK) { resolve({ ok: false, reason: "ecu class not found" }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "dispatcher attach failed" }); return; }

        // Find a live ecu instance (the network socket).
        let ecu = cachedLiveEcu;
        if (ecu) { try { ecu.class.name; } catch { ecu = null; cachedLiveEcu = null; } }
        if (!ecu) {
            const arr = Il2Cpp.gc.choose(ecuK);
            if (arr.length) { ecu = arr[arr.length - 1]!; cachedLiveEcu = ecu; }
        }
        if (!ecu) { resolve({ ok: false, reason: "no ecu instance" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const igd = (igdK as any).new();
                (igd as any).field("ecxt").value = id;
                (ecu as any).method("xbe").invoke(igd);
                settle({ ok: true, havreSacId: id });
            } catch (e) {
                settle({ ok: false, havreSacId: id, reason: "xbe threw: " + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Trigger a synthetic dtt.kwd(dci) call to force the in-flight async solve
// to resolve/cancel, releasing the hard-stuck lock without needing a real
// map change. Confirmed 2026-04-27: the havre-sac round-trip recovery works
// because each map arrival fires kwd(dci), which is what unsticks foz.bgtq.
// This RPC fires kwd directly with a dci{dbkm=mapId} event — same effect,
// no actual teleport needed.
export function triggerKwd(mapId?: number): Promise<{
    ok: boolean;
    mapIdUsed?: number;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const dtt = resolveOrSynthesizeDtt();
        if (!dtt) { resolve({ ok: false, reason: "dtt unavailable" }); return; }
        const dciK = getClass("dci");
        if (!dciK) { resolve({ ok: false, reason: "dci class not found" }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "dispatcher attach failed" }); return; }

        // Default to current map if no mapId given (reload-arrival semantics).
        let mid = mapId;
        if (mid === undefined || mid === null) {
            try {
                const mrK = getClass("MapRenderer");
                if (mrK) {
                    const mrInsts = Il2Cpp.gc.choose(mrK);
                    if (mrInsts.length) {
                        const mr = mrInsts[mrInsts.length - 1]!;
                        mid = Number((mr as any).field("cywa").value);
                    }
                }
            } catch {}
        }
        if (!Number.isFinite(mid as number) || (mid as number) <= 0) {
            resolve({ ok: false, reason: "could not resolve current mapId" }); return;
        }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const dci = (dciK as any).new();
                (dci as any).field("dbkm").value = mid;
                (dtt as any).method("kwd").invoke(dci);
                settle({ ok: true, mapIdUsed: mid as number });
            } catch (e) {
                settle({ ok: false, mapIdUsed: mid as number, reason: "kwd threw: " + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Replace elg.djyz with a fresh eli instance to release the in-flight
// pathfind lock without restarting Dofus. The locked eli (djzh=2, djze
// stuck Action`2) gets orphaned (still alive in memory but no longer
// reachable via dtt→elg→eli). The new eli starts at djzh=0/djze=initial.
// Useful when "Une recherche d'itinéraire est déjà en cours." appears in
// chat and baot+ctor-based recovery hasn't worked.
export function replaceEliInstance(): Promise<{
    ok: boolean;
    oldEli?: string;
    newEli?: string;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const eK = getClass("eli");
        if (!eK) { resolve({ ok: false, reason: "eli class not found" }); return; }
        const elgK = getClass("elg");
        if (!elgK) { resolve({ ok: false, reason: "elg class not found" }); return; }
        const elgInsts = Il2Cpp.gc.choose(elgK);
        if (!elgInsts.length) { resolve({ ok: false, reason: "no elg instance" }); return; }
        const elg = elgInsts[elgInsts.length - 1]!;
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const oldEli = (elg as any).field("djyz").value;
                const oldHandle = oldEli ? String((oldEli as any).handle) : "null";
                const fresh = (eK as any).new() as Il2Cpp.Object;
                (elg as any).field("djyz").value = fresh;
                const newHandle = String((fresh as any).handle);
                settle({ ok: true, oldEli: oldHandle, newEli: newHandle });
            } catch (e) {
                settle({ ok: false, reason: "swap threw: " + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// Call foz.bgtt() once on the main thread. No args.
export function callFozBgtt(): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => new Promise((resolve) => {
        let foz = cachedFoz;
        if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
        if (!foz) {
            const fK = getClass("foz");
            if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
        }
        if (!foz) { resolve({ ok: false, reason: "no foz instance" }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "main-thread dispatcher attach failed" }); return; }

        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try { (foz as any).method("bgtt").invoke(); settle({ ok: true }); }
            catch (e) { settle({ ok: false, reason: "bgtt threw: " + String(e).slice(0, 120) }); }
        };
        setTimeout(() => settle({ ok: false, reason: "main-thread dispatch timeout" }), 3000);
    }));
}

// -----------------------------------------------------------------------------
// eli watcher — trace every eli method call with djze/djzh/djzg snapshots
// -----------------------------------------------------------------------------
// Pathfinding silent-reject identified (2026-04-27): eli.djzh=2 + eli.djze
// (Action`2) stuck after a previous unreachable-target solve. bbd writes
// the new target into eli.djzg but eli rejects launching foz.bgtt because
// djze is non-null (it thinks a callback is still pending). We can't null
// Action`2 fields directly. Need to identify which eli method clears djze
// when the game itself recovers (e.g. on manual user click).

let cachedEli: Il2Cpp.Object | null = null;

function resolveEli(): Il2Cpp.Object | null {
    if (cachedEli) {
        try { (cachedEli as any).field("djzh").value; return cachedEli; }
        catch { cachedEli = null; }
    }
    const eK = getClass("eli");
    if (!eK) return null;
    const arr = Il2Cpp.gc.choose(eK);
    if (!arr.length) return null;
    cachedEli = arr[arr.length - 1]!;
    return cachedEli;
}

interface EliHit { ts: number; method: string; argsBrief: string; djzhBefore: string; djzhAfter: string; djzgBefore: string; djzgAfter: string; djzeBefore: string; djzeAfter: string; }
const eliHits: EliHit[] = [];
let eliWatcherHooked = false;
const hookedEliMethods: Array<{ tag: string; method: any }> = [];

export function hookEliWatcher(opts?: { quiet?: boolean }): Promise<{ ok: boolean; hooked: number; reason?: string }> {
    return inVm(() => {
        if (eliWatcherHooked) return { ok: true, hooked: 0, reason: "already hooked" };
        const eK = getClass("eli");
        if (!eK) return { ok: false, hooked: 0, reason: "eli class not found" };
        const quiet = !!(opts && opts.quiet);
        const SKIP = new Set(["ToString", "Equals", "GetHashCode", "GetType", "MemberwiseClone", "Finalize"]);
        let hooked = 0;
        for (const m of eK.methods) {
            if (m.isStatic) continue;
            if (m.name.startsWith(".")) continue;
            if (SKIP.has(m.name)) continue;
            const methodName = m.name;
            try {
                m.implementation = function (this: any, ...args: any[]): any {
                    const self = this as Il2Cpp.Object;
                    const readState = () => {
                        let djzh = "?", djzg = "?", djze = "?";
                        try { djzh = String((self as any).field("djzh").value); } catch {}
                        try { djzg = String((self as any).field("djzg").value); } catch {}
                        try {
                            const v = (self as any).field("djze").value;
                            djze = v === null ? "null" : (typeof v === "object" && (v as any).class ? (v as any).class.name : String(v));
                        } catch {}
                        return { djzh, djzg, djze };
                    };
                    const before = readState();
                    const argsBrief: string[] = [];
                    try {
                        for (const a of args) {
                            if (a == null) { argsBrief.push("null"); continue; }
                            if (typeof a === "object" && (a as any).class) argsBrief.push((a as any).class.name);
                            else argsBrief.push(String(a).slice(0, 16));
                        }
                    } catch {}
                    let ret: any;
                    try { ret = self.method(methodName).invoke(...args); }
                    catch (e) {
                        const after = readState();
                        if (before.djze !== after.djze || before.djzh !== after.djzh) {
                            console.log(`[eli] *** ${methodName}(${argsBrief.join(",")}) THREW djze=${before.djze}→${after.djze} djzh=${before.djzh}→${after.djzh}`);
                        }
                        eliHits.push({ ts: Date.now(), method: methodName + " [threw]", argsBrief: argsBrief.join(","), djzhBefore: before.djzh, djzhAfter: after.djzh, djzgBefore: before.djzg, djzgAfter: after.djzg, djzeBefore: before.djze, djzeAfter: after.djze });
                        if (eliHits.length > 300) eliHits.shift();
                        throw e;
                    }
                    const after = readState();
                    const changed = before.djze !== after.djze || before.djzh !== after.djzh || before.djzg !== after.djzg;
                    if (!quiet || changed) {
                        if (changed) console.log(`[eli] *** ${methodName}(${argsBrief.join(",")})  djze:${before.djze}→${after.djze}  djzh:${before.djzh}→${after.djzh}  djzg:${before.djzg}→${after.djzg}`);
                        else if (!quiet) console.log(`[eli] ${methodName}(${argsBrief.join(",")})  djze=${after.djze} djzh=${after.djzh}`);
                    }
                    eliHits.push({ ts: Date.now(), method: methodName, argsBrief: argsBrief.join(","), djzhBefore: before.djzh, djzhAfter: after.djzh, djzgBefore: before.djzg, djzgAfter: after.djzg, djzeBefore: before.djze, djzeAfter: after.djze });
                    if (eliHits.length > 300) eliHits.shift();
                    return ret;
                };
                hookedEliMethods.push({ tag: methodName, method: m });
                hooked++;
            } catch {}
        }
        eliWatcherHooked = true;
        console.log(`[eli] watcher attached on ${hooked} methods${quiet ? " (quiet — log only on state changes)" : ""}`);
        return { ok: true, hooked };
    });
}

export function unhookEliWatcher(): Promise<{ ok: boolean; restored: number; reason?: string }> {
    return inVm(() => {
        if (!eliWatcherHooked) return { ok: true, restored: 0, reason: "not hooked" };
        let restored = 0, failed = 0;
        for (const { method } of hookedEliMethods) {
            try { method.implementation = null; restored++; }
            catch { failed++; }
        }
        hookedEliMethods.length = 0;
        eliWatcherHooked = false;
        console.log(`[eli] watcher detached: ${restored} restored, ${failed} failed`);
        return { ok: true, restored, reason: failed ? `${failed} methods failed restore` : undefined };
    });
}

export function getEliHits(): Promise<EliHit[]> {
    return inVm(() => eliHits.map(h => ({ ...h })));
}

export function clearEliHits(): Promise<number> {
    return inVm(() => { const n = eliHits.length; eliHits.length = 0; return n; });
}

// -----------------------------------------------------------------------------
// invokeEliCallback — synthetic invocation of eli's path-completion callbacks
// -----------------------------------------------------------------------------
// eli has 4 instance methods with signature (List<Edge>, bool, bool):
// cko, jka, baor, cpr — likely the success/failure/cancel/timeout variants of
// the path-completion callback. One of them should clear djze (Action`2) and
// reset djzh to 0. We invoke them with foz.dpgs (List<Edge>, currently empty)
// + (false, false) and snapshot eli state before/after each call so we can
// identify which one is the "clear callback".
//
// Pass `which` to invoke just one method; omit to test all 4 in sequence.

const ELI_CALLBACK_METHODS = ["cko", "jka", "baor", "cpr"];

export function invokeEliCallback(which?: string, success: boolean = false, second: boolean = false): Promise<{
    ok: boolean;
    results: Array<{
        method: string;
        before: { djzh: string; djzg: string; djze: string };
        after: { djzh: string; djzg: string; djze: string };
        threw?: string;
    }>;
    listSource?: string;
    listSize?: number;
    reason?: string;
}> {
    return inVm(() => new Promise((resolve) => {
        const eli = resolveEli();
        if (!eli) { resolve({ ok: false, results: [], reason: "no eli instance" }); return; }

        // Pick a List<Edge> source. dtt.dejp first, then foz.dpgs.
        let list: any = null;
        let listSource = "";
        try {
            const dtt = resolveOrSynthesizeDtt();
            if (dtt) {
                const dejp = (dtt as any).field("dejp").value;
                if (dejp !== null) { list = dejp; listSource = "dtt.dejp"; }
            }
        } catch {}
        if (!list) {
            try {
                let foz = cachedFoz;
                if (foz) { try { (foz as any).field("dpgq").value; } catch { foz = null; cachedFoz = null; } }
                if (!foz) {
                    const fK = getClass("foz");
                    if (fK) { const arr = Il2Cpp.gc.choose(fK); if (arr.length) { foz = arr[arr.length - 1]!; cachedFoz = foz; } }
                }
                if (foz) {
                    const dpgs = (foz as any).field("dpgs").value;
                    if (dpgs !== null) { list = dpgs; listSource = "foz.dpgs"; }
                }
            } catch {}
        }
        if (!list) { resolve({ ok: false, results: [], reason: "no List<Edge> available in dtt.dejp or foz.dpgs" }); return; }

        let listSize: number | undefined;
        try { listSize = Number((list as any).field("_size").value); } catch {}

        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, results: [], listSource, listSize, reason: "main-thread dispatcher attach failed" }); return; }

        const targets = which ? [which] : ELI_CALLBACK_METHODS;
        for (const t of targets) {
            if (!ELI_CALLBACK_METHODS.includes(t)) {
                resolve({ ok: false, results: [], listSource, listSize, reason: `unknown method ${t}` });
                return;
            }
        }

        const readState = (): { djzh: string; djzg: string; djze: string } => {
            let djzh = "?", djzg = "?", djze = "?";
            try { djzh = String((eli as any).field("djzh").value); } catch {}
            try { djzg = String((eli as any).field("djzg").value); } catch {}
            try {
                const v = (eli as any).field("djze").value;
                djze = v === null ? "null" : (typeof v === "object" && (v as any).class ? (v as any).class.name : String(v));
            } catch {}
            return { djzh, djzg, djze };
        };

        const results: Array<{ method: string; before: any; after: any; threw?: string }> = [];
        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };

        pendingMainWork = () => {
            try {
                for (const methodName of targets) {
                    const before = readState();
                    let threw: string | undefined;
                    try { (eli as any).method(methodName).invoke(list, success, second); }
                    catch (e) { threw = String(e).slice(0, 120); }
                    const after = readState();
                    results.push({ method: methodName, before, after, threw });
                    // Stop early if djze got cleared — we found the right callback.
                    if (before.djze !== "null" && after.djze === "null") break;
                }
                settle({ ok: true, results, listSource, listSize });
            } catch (e) {
                settle({ ok: false, results, listSource, listSize, reason: "outer threw: " + String(e).slice(0, 120) });
            }
        };
        setTimeout(() => settle({ ok: false, results, listSource, listSize, reason: "main-thread dispatch timeout" }), 5000);
    }));
}
