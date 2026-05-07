"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HookEventBus = void 0;
function isHookEvent(p) {
    return !!p && typeof p === "object" && p.type === "hook-event";
}
class HookEventBus {
    ringSize;
    listeners = [];
    ring = [];
    subscription;
    constructor(agentEvent, ringSize = 10_000) {
        this.ringSize = ringSize;
        this.subscription = agentEvent((p) => {
            if (!isHookEvent(p))
                return;
            this.ring.push(p);
            if (this.ring.length > this.ringSize) {
                this.ring.splice(0, this.ring.length - this.ringSize);
            }
            for (const l of this.listeners) {
                try {
                    l(p);
                }
                catch { /* swallow */ }
            }
        });
    }
    onHookEvent(listener) {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0)
                this.listeners.splice(i, 1);
        };
    }
    /** Snapshot of buffered events (oldest first). Defensive copy. */
    snapshot() {
        return this.ring.slice();
    }
    clear() {
        this.ring.length = 0;
    }
    dispose() {
        this.subscription.dispose();
        this.listeners.length = 0;
        this.ring.length = 0;
    }
}
exports.HookEventBus = HookEventBus;
//# sourceMappingURL=hook-event-bus.js.map