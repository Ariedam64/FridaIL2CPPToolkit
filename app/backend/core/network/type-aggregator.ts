import type { MessageType, NetworkFrame } from "./types.js";
import { encodeTypeKey } from "./types.js";

/**
 * Groups frames by typeKey and produces a Summary-view list.
 * Pure function — no side effects, no events.
 */
export function aggregate(frames: NetworkFrame[]): MessageType[] {
    const byKey = new Map<string, MessageType>();
    const fieldOrder = new Map<string, Map<string, number>>();
    let nextOrder = 0;

    for (const f of frames) {
        const k = encodeTypeKey(f.typeKey);
        let m = byKey.get(k);
        if (!m) {
            m = {
                key: f.typeKey,
                count: 0,
                countByDirection: { in: 0, out: 0 },
                lastSeenAt: 0,
                observedFields: [],
            };
            byKey.set(k, m);
            fieldOrder.set(k, new Map());
        }
        m.count++;
        m.countByDirection[f.direction]++;
        if (f.timestamp > m.lastSeenAt) m.lastSeenAt = f.timestamp;
        const order = fieldOrder.get(k)!;
        for (const fld of f.fields) {
            if (!order.has(fld.name)) {
                order.set(fld.name, nextOrder++);
                m.observedFields.push(fld.name);
            }
        }
    }
    return Array.from(byKey.values());
}
