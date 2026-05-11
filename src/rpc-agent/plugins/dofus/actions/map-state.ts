// One-shot read of the current map id from the runtime, used by the
// backend's MapStateStore to bootstrap before forging the synthetic isp
// that re-triggers an itx broadcast. Subsequent map state lives entirely
// in the backend (parsed off the WS frames).

import { inVm } from "./_runtime";
import { getSingleton } from "../../../singleton-cache";

export interface MapStateProto {
    classes: { MapRenderer: string };
    fields:  { MapRenderer_currentMapId: string };
}

export interface MapIdSnapshot {
    ok: boolean;
    mapId: number | null;
    reason?: string;
}

export function readMapState(proto: MapStateProto): Promise<MapIdSnapshot> {
    return inVm(() => {
        const renderer = getSingleton(proto.classes.MapRenderer);
        if (!renderer) {
            return { ok: false, mapId: null, reason: `no live ${proto.classes.MapRenderer} instance` };
        }
        try {
            const mapId = Number((renderer as any).field(proto.fields.MapRenderer_currentMapId).value);
            return { ok: true, mapId };
        } catch (e) {
            return { ok: false, mapId: null, reason: `read failed: ${String(e).slice(0, 200)}` };
        }
    });
}
