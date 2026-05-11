// Helpers for waiting on a network frame from the toolkit's network monitor
// store, and pulling typed values out of FrameField trees.
//
// Used by TradeCenterActions to read responses to outgoing packets — we send
// via the agent, then sit on the FrameStore waiting for the matching frame.
// Event-driven (no polling).

import type { FrameStore } from "../../../backend/core/network/frame-store";
import type { NetworkFrame, FrameField } from "../../../backend/core/network/types";

/** Wait for the first frame matching `predicate`, looking at frames newer than
 *  `sinceId` (exclusive). Returns null on timeout. Subscribes to live events
 *  so it fires immediately when the frame arrives, no polling. */
export function waitForFrame(
    store: FrameStore,
    predicate: (f: NetworkFrame) => boolean,
    timeoutMs: number,
    sinceId?: string,
): Promise<NetworkFrame | null> {
    // First check anything already in the ring (in case the response landed
    // between our send and the listener subscribe).
    const existing = store.list({ sinceId }).find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
        let done = false;
        const finish = (frame: NetworkFrame | null): void => {
            if (done) return;
            done = true;
            store.off("frame-added", onFrame);
            clearTimeout(timer);
            resolve(frame);
        };
        const onFrame = (f: NetworkFrame): void => {
            if (predicate(f)) finish(f);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        store.on("frame-added", onFrame);
    });
}

/** Snapshot the id of the most recent frame, useful as a `sinceId` for a
 *  subsequent waitForFrame so we don't race with frames from before the send. */
export function latestFrameId(store: FrameStore): string | undefined {
    const all = store.snapshotAll();
    return all.length > 0 ? all[all.length - 1].id : undefined;
}

// ---------------------------------------------------------------------------
// Field extraction — frames store fields as a FrameField tree where each leaf
// has a string `preview`. The helpers below parse common types.
// ---------------------------------------------------------------------------

export function findField(fields: FrameField[], name: string): FrameField | undefined {
    return fields.find((f) => f.name === name);
}

export function intFromField(field: FrameField | undefined): number | null {
    if (!field) return null;
    const n = parseInt(field.preview, 10);
    return Number.isFinite(n) ? n : null;
}

export function boolFromField(field: FrameField | undefined): boolean | null {
    if (!field) return null;
    if (field.preview === "true") return true;
    if (field.preview === "false") return false;
    return null;
}

/** "[N items]" → N. Returns 0 if no array, null if unparseable. */
export function arrayLength(field: FrameField | undefined): number | null {
    if (!field) return null;
    const m = field.preview.match(/^\[(\d+)\s+items?\]$/);
    return m ? parseInt(m[1], 10) : null;
}

/** Pull all numeric children out of an array field (e.g. "[4 items]" of ints). */
export function intArrayFromField(field: FrameField | undefined): number[] {
    if (!field || !field.children) return [];
    const out: number[] = [];
    for (const c of field.children) {
        if (c.name === "…") continue; // truncation marker
        const n = parseInt(c.preview, 10);
        if (Number.isFinite(n)) out.push(n);
    }
    return out;
}

/** Pull all int values from a list of nested children, addressed by an
 *  inner field name. Used e.g. to extract every `[i].auctionId` from an
 *  offers array. */
export function intsFromArrayChildren(field: FrameField | undefined, innerFieldName: string): number[] {
    if (!field || !field.children) return [];
    const out: number[] = [];
    for (const c of field.children) {
        if (c.name === "…" || !c.children) continue;
        const inner = findField(c.children, innerFieldName);
        const n = intFromField(inner);
        if (n !== null) out.push(n);
    }
    return out;
}
