// Plugin-side mirror of src/rpc-agent/hook-types.ts. Kept in sync manually —
// agent and extension live in different tsconfig roots.

export type HookTemplate = "log" | "noop" | "force-return" | "log-stack";

export interface HookSpec {
    template: HookTemplate;
    className: string;
    methodName: string;
    forceReturnValue?: unknown;
    stackCaptureCount?: number;
}

export interface InstalledHook {
    hookId: string;
    spec: HookSpec;
    installedAt: number;
}

export interface HookEvent {
    type: "hook-event";
    hookId: string;
    ts: number;
    self: string | null;
    args: string[];
    retval: string | null;
    error?: string;
    stackFrames?: string[];
}

/** Disk shape — what HookStore persists and what the tree provider consumes. */
export interface StoredHook {
    /** Stable on-disk UUID. Distinct from agent-assigned hookId. */
    id: string;
    spec: HookSpec;
    /** Set when installed agent-side. Volatile — reset on detach/reload. */
    installedHookId: string | null;
    addedAt: number;
}
