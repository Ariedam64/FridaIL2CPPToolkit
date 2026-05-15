// Map change senders + intercept hook. The hook drops outgoing packets whose
// class name is in `blockedClassNames`, UNLESS we are inside one of our own
// `buildAndSend` calls (tracked via `manualSendDepth`). The backend uses this
// to suppress the client's auto-emitted jnr+isp after a knw and substitute
// our own (sent immediately, skipping the game's ~1.2s loading delay).
//
// The hook is installed lazily on the first `setChangeMapIntercept` call,
// per Dispatcher class — so the obf-name change across game updates is
// handled by re-resolving from the backend's LabelStore each call.

import { inVm, getLiveInstance, findClass } from "./_runtime";

export interface ChangeMapProto {
    classes: {
        MoveToNewMap:    string;
        MapInfoRequest:  string;
        MapEnteredNotif: string;
        TransitionAck:   string;
        MapEventsList:   string;
        Dispatcher:      string;
    };
    fields: {
        MoveToNewMap_mapId:    string;
        MoveToNewMap_flag1:    string;
        MapInfoRequest_flag1:  string;
        MapInfoRequest_mapId:  string;
        MapEnteredNotif_flag1: string;
        MapEnteredNotif_mapId: string;
    };
    methods: {
        Dispatcher_send: string;
    };
}

export interface ChangeMapSendResult {
    ok: boolean;
    reason?: string;
    /** Diagnostic timings (ms). All start from perform-block entry. */
    timings?: {
        /** perform entry → message fully built (just before dispatcher.send) */
        buildMs: number;
        /** built → dispatcher.send returned */
        sendMs: number;
        /** perform entry → exit */
        totalMs: number;
    };
}

// =============================================================================
// Intercept hook state.
// =============================================================================

let blockedClassNames: Set<string> = new Set();
let manualSendDepth = 0;
let hookInstalledFor: { dispatcherClass: string; methodName: string } | null = null;

function ensureHookInstalled(proto: ChangeMapProto): { ok: boolean; reason?: string } {
    if (
        hookInstalledFor &&
        hookInstalledFor.dispatcherClass === proto.classes.Dispatcher &&
        hookInstalledFor.methodName === proto.methods.Dispatcher_send
    ) return { ok: true };

    const klass = findClass(proto.classes.Dispatcher);
    if (!klass) return { ok: false, reason: `${proto.classes.Dispatcher} class not found` };
    const sendName = proto.methods.Dispatcher_send;
    let method: any;
    try { method = (klass as any).method(sendName); }
    catch { return { ok: false, reason: `${proto.classes.Dispatcher}.${sendName} method not found` }; }

    method.implementation = function (this: any, ...args: any[]): any {
        // Bypass: we're inside our own send → always pass through.
        if (manualSendDepth > 0) {
            return (this as any).method(sendName).invoke(...args);
        }
        // Drop check: inspect the packet class name against the block list.
        if (blockedClassNames.size > 0) {
            try {
                const req = args[0];
                const cls = req && req.class ? String(req.class.name) : null;
                if (cls && blockedClassNames.has(cls)) return null;
            } catch { /* fall through to pass-through */ }
        }
        return (this as any).method(sendName).invoke(...args);
    };
    hookInstalledFor = { dispatcherClass: proto.classes.Dispatcher, methodName: sendName };
    return { ok: true };
}

/** Configure which outgoing packet classes the dispatcher hook should drop.
 *  Pass an empty array to disable. Installs the hook lazily on first call. */
export function setChangeMapIntercept(
    proto: ChangeMapProto,
    blockClassNames: string[],
): Promise<{ ok: boolean; reason?: string }> {
    return inVm(() => {
        const r = ensureHookInstalled(proto);
        if (!r.ok) return r;
        blockedClassNames = new Set(blockClassNames);
        return { ok: true };
    });
}

// =============================================================================
// Packet senders. Each increments `manualSendDepth` around the dispatcher
// invocation so the intercept hook lets our own sends through.
// =============================================================================

function buildAndSend(
    proto: ChangeMapProto,
    classKey: keyof ChangeMapProto["classes"],
    populate: (req: any) => void,
): ChangeMapSendResult {
    const tEnter = Date.now();
    const reqK = findClass(proto.classes[classKey]);
    if (!reqK) return { ok: false, reason: `${proto.classes[classKey]} class not found` };
    const dispatcher = getLiveInstance(proto.classes.Dispatcher);
    if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };

    let req: any;
    try {
        req = (reqK as any).new();
        req.method(".ctor").overload().invoke();
        populate(req);
    } catch (e) {
        return { ok: false, reason: `${proto.classes[classKey]} build failed: ${String(e).slice(0, 200)}` };
    }
    const tBuilt = Date.now();
    manualSendDepth++;
    try {
        (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
    } catch (e) {
        return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
    } finally {
        manualSendDepth--;
    }
    const tSent = Date.now();
    return {
        ok: true,
        timings: { buildMs: tBuilt - tEnter, sendMs: tSent - tBuilt, totalMs: tSent - tEnter },
    };
}

/** Forge a moveToNewMap (ito) packet and dispatch it. */
export function sendMoveToNewMap(proto: ChangeMapProto, mapId: number): Promise<ChangeMapSendResult> {
    return inVm(() => buildAndSend(proto, "MoveToNewMap", (req) => {
        req.field(proto.fields.MoveToNewMap_mapId).value = mapId;
        req.field(proto.fields.MoveToNewMap_flag1).value = false;
    }));
}

/** Forge a MapInformationsRequest (jnr) packet and dispatch it. */
export function sendMapInformationsRequest(proto: ChangeMapProto, mapId: number): Promise<ChangeMapSendResult> {
    return inVm(() => buildAndSend(proto, "MapInfoRequest", (req) => {
        req.field(proto.fields.MapInfoRequest_flag1).value = 0;
        req.field(proto.fields.MapInfoRequest_mapId).value = mapId;
    }));
}

/** Forge a MapEnteredNotification (isp) packet and dispatch it. */
export function sendMapEnteredNotification(proto: ChangeMapProto, mapId: number): Promise<ChangeMapSendResult> {
    return inVm(() => buildAndSend(proto, "MapEnteredNotif", (req) => {
        req.field(proto.fields.MapEnteredNotif_flag1).value = 0;
        req.field(proto.fields.MapEnteredNotif_mapId).value = mapId;
    }));
}

/** Single-shot fast map change: arm intercept + send ito + jnr + isp all
 *  in one Il2Cpp.perform block. Total wire time is dominated by TCP RTT
 *  (a few ms) instead of 3 RPC round-trips (~900ms each). The dispatcher
 *  hook stays armed after this call — the caller is responsible for
 *  releasing it via setChangeMapIntercept(..., []) after the grace period. */
export function fastChangeMap(proto: ChangeMapProto, mapId: number): Promise<ChangeMapSendResult> {
    return inVm(() => {
        const hook = ensureHookInstalled(proto);
        if (!hook.ok) return hook;
        blockedClassNames = new Set([proto.classes.MapInfoRequest, proto.classes.MapEnteredNotif]);

        const ito = buildAndSend(proto, "MoveToNewMap", (req) => {
            req.field(proto.fields.MoveToNewMap_mapId).value = mapId;
            req.field(proto.fields.MoveToNewMap_flag1).value = false;
        });
        if (!ito.ok) return { ok: false, reason: `ito: ${ito.reason}` };

        const jnr = buildAndSend(proto, "MapInfoRequest", (req) => {
            req.field(proto.fields.MapInfoRequest_flag1).value = 0;
            req.field(proto.fields.MapInfoRequest_mapId).value = mapId;
        });
        if (!jnr.ok) return { ok: false, reason: `jnr: ${jnr.reason}` };

        const isp = buildAndSend(proto, "MapEnteredNotif", (req) => {
            req.field(proto.fields.MapEnteredNotif_flag1).value = 0;
            req.field(proto.fields.MapEnteredNotif_mapId).value = mapId;
        });
        if (!isp.ok) return { ok: false, reason: `isp: ${isp.reason}` };

        return { ok: true };
    });
}
