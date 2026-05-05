// Shared types between the agent's hooks RPC surface and the plugin
// that consumes them. Plugin-side imports a copy in
// `dofus-app/vscode-extension/src/plugins/hooks/types.ts` (Frida agents
// and the VSCode extension live in different tsconfig roots, hence
// the duplication — kept in sync manually; both files are tiny).

export type HookTemplate = "log" | "noop" | "force-return" | "log-stack";

export interface HookSpec {
    template: HookTemplate;
    className: string;
    methodName: string;
    /** Required for `force-return`. Stringified value coerced agent-side. */
    forceReturnValue?: unknown;
    /** Used by `log-stack`. How many initial hits get a backtrace. Default 5. */
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
