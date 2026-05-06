// app/frontend/core/types.ts — mirror of agent + backend types

export interface ProfileLite {
    manifest: {
        profileId: string;
        gameName: string;
        buildId: string;
        buildIdSource: string;
        attachedFirstAt: string;
        attachedLastAt: string;
        derivedFrom: string | null;
        stats: { totalLabels: number; totalBookmarks: number; totalNotes: number };
    };
    rootPath: string;
}

export type LabelKey =
    | { kind: "class"; className: string }
    | { kind: "method"; className: string; methodName: string }
    | { kind: "field"; className: string; fieldName: string };

export type HookTemplate = "log" | "noop" | "force-return" | "log-stack";

export interface HookSpec {
    template: HookTemplate;
    className: string;
    methodName: string;
    forceReturnValue?: unknown;
    stackCaptureCount?: number;
}

export interface StoredHook {
    id: string;
    spec: HookSpec;
    installedHookId: string | null;
    addedAt: number;
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

export interface ProcessInfo { pid: number; name: string; }
