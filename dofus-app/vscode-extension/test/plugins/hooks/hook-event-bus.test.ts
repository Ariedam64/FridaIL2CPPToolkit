import { describe, it, expect } from "vitest";

import { HookEventBus } from "../../../src/plugins/hooks/hook-event-bus";
import type { HookEvent } from "../../../src/plugins/hooks/types";

interface FakeEmitter {
    fire(payload: unknown): void;
    event: (listener: (p: unknown) => void) => { dispose(): void };
}

function makeFakeEmitter(): FakeEmitter {
    const listeners: Array<(p: unknown) => void> = [];
    return {
        fire: (p) => { for (const l of listeners) l(p); },
        event: (l) => {
            listeners.push(l);
            return { dispose: () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); } };
        },
    };
}

const evt = (hookId: string): HookEvent => ({
    type: "hook-event", hookId, ts: 1, self: null, args: [], retval: null,
});

describe("HookEventBus", () => {
    it("forwards hook-event payloads to subscribers", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 100);
        const seen: HookEvent[] = [];
        bus.onHookEvent((e) => seen.push(e));

        emitter.fire(evt("h1"));
        emitter.fire(evt("h2"));

        expect(seen.map((e) => e.hookId)).toEqual(["h1", "h2"]);
    });

    it("ignores non-hook-event payloads", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 100);
        const seen: HookEvent[] = [];
        bus.onHookEvent((e) => seen.push(e));

        emitter.fire({ type: "other", foo: 1 });
        emitter.fire(null);
        emitter.fire("string");
        emitter.fire(evt("h1"));

        expect(seen).toHaveLength(1);
    });

    it("supports multiple listeners independently", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 100);
        const a: HookEvent[] = [];
        const b: HookEvent[] = [];
        bus.onHookEvent((e) => a.push(e));
        bus.onHookEvent((e) => b.push(e));

        emitter.fire(evt("h1"));

        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
    });

    it("ring buffer keeps last N events for late subscribers", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 3);

        emitter.fire(evt("h1"));
        emitter.fire(evt("h2"));
        emitter.fire(evt("h3"));
        emitter.fire(evt("h4"));

        expect(bus.snapshot().map((e) => e.hookId)).toEqual(["h2", "h3", "h4"]);
    });

    it("clear() empties the ring buffer", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 10);
        emitter.fire(evt("h1"));
        emitter.fire(evt("h2"));
        bus.clear();
        expect(bus.snapshot()).toEqual([]);
    });

    it("listener errors do not break the bus", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 10);
        bus.onHookEvent(() => { throw new Error("boom"); });
        const ok: HookEvent[] = [];
        bus.onHookEvent((e) => ok.push(e));

        emitter.fire(evt("h1"));
        expect(ok).toHaveLength(1);
    });
});
