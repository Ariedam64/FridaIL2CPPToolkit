// MapMoveRequest sender — fires the isa outgoing packet with a precomputed
// cellPath (built backend-side by pathfinder.ts). The agent never inspects
// player position or static map data; it just forges and dispatches.

import { inVm, getLiveInstance, findClass } from "./_runtime";

export interface MovementProto {
    classes: {
        MoveRequest: string;
        Dispatcher:  string;
    };
    fields: {
        MoveRequest_mode:     string;
        MoveRequest_cellPath: string;
        MoveRequest_flag1:    string;
        MoveRequest_mapId:    string;
    };
    methods: {
        Dispatcher_send: string;
    };
}

export interface SendMapMoveResult {
    ok: boolean;
    reason?: string;
}

/** Forge a MapMoveRequest (isa) and dispatch it. `keyMovements` is the
 *  already-encoded int list (pivot cellIds with direction in the high nibble);
 *  see backend pathfinder.computeCellPath. */
export function sendMapMoveRequest(
    proto: MovementProto,
    keyMovements: number[],
    mapId: number,
    mode: number = 0,
    flag: boolean = false,
): Promise<SendMapMoveResult> {
    return inVm(() => {
        const reqK = findClass(proto.classes.MoveRequest);
        if (!reqK) return { ok: false, reason: `${proto.classes.MoveRequest} class not found` };
        const dispatcher = getLiveInstance(proto.classes.Dispatcher);
        if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };

        let req: any;
        let stage = "init";
        try {
            req = (reqK as any).new();
            stage = "ctor";
            req.method(".ctor").overload().invoke();

            // `mode` is an IL2CPP enum field — the bridge rejects raw ints
            // (cf. sender.ts enumValueCache pattern). Every observed isa has
            // mode=0, which IS the ctor default — so we never assign it. The
            // `mode` parameter is kept on the signature for future use; if a
            // non-zero mode ever becomes necessary, we'll need to resolve the
            // enum class and read its static value field as Il2Cpp.Object.
            void mode;

            stage = `set ${proto.fields.MoveRequest_flag1} (flag)`;
            req.field(proto.fields.MoveRequest_flag1).value = flag;

            stage = `set ${proto.fields.MoveRequest_mapId} (mapId)`;
            // mapId is a long on the wire — in IL2CPP value-types are usually
            // accepted as plain JS numbers via frida-il2cpp-bridge, but if the
            // bridge complains, try Int64(mapId.toString()) instead.
            req.field(proto.fields.MoveRequest_mapId).value = mapId;

            stage = `read ${proto.fields.MoveRequest_cellPath} (cellPath)`;
            const arr = req.field(proto.fields.MoveRequest_cellPath).value;
            if (!arr) return { ok: false, reason: `${proto.fields.MoveRequest_cellPath} field is null on fresh request` };

            stage = "clear cellPath";
            try { arr.method("Clear").invoke(); } catch {}

            stage = "Add to cellPath";
            for (const km of keyMovements) {
                arr.method("Add").invoke(km | 0);
            }
        } catch (e) {
            return { ok: false, reason: `isa build failed at "${stage}": ${String(e).slice(0, 200)}` };
        }
        try {
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
            return { ok: true } as SendMapMoveResult;
        } catch (e) {
            return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
        }
    });
}
