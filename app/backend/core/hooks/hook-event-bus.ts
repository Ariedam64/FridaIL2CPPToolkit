import type { HookEvent } from "./types";

type Disposable = { dispose(): void };
type AgentEvent<T> = (listener: (payload: T) => void) => Disposable;
type HookEventListener = (event: HookEvent) => void;

function isHookEvent(p: unknown): p is HookEvent {
    return !!p && typeof p === "object" && (p as { type?: string }).type === "hook-event";
}

export class HookEventBus {
    private readonly listeners: HookEventListener[] = [];
    private readonly ring: HookEvent[] = [];
    private readonly subscription: Disposable;

    constructor(
        agentEvent: AgentEvent<unknown>,
        private readonly ringSize: number = 10_000,
    ) {
        this.subscription = agentEvent((p) => {
            if (!isHookEvent(p)) return;
            this.ring.push(p);
            if (this.ring.length > this.ringSize) {
                this.ring.splice(0, this.ring.length - this.ringSize);
            }
            for (const l of this.listeners) {
                try { l(p); } catch { /* swallow */ }
            }
        });
    }

    onHookEvent(listener: HookEventListener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    /** Snapshot of buffered events (oldest first). Defensive copy. */
    snapshot(): HookEvent[] {
        return this.ring.slice();
    }

    clear(): void {
        this.ring.length = 0;
    }

    dispose(): void {
        this.subscription.dispose();
        this.listeners.length = 0;
        this.ring.length = 0;
    }
}
