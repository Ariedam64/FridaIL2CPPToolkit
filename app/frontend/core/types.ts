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

export interface NetTypeKey { ns: string | null; className: string; }

export type NetFieldKind =
    | "int" | "long" | "float" | "bool"
    | "string" | "bytes" | "enum"
    | "nested" | "array" | "null" | "unknown";

export interface NetField {
    name: string;
    kind: NetFieldKind;
    preview: string;
    children?: NetField[];
}

export interface NetFrame {
    id: string;
    timestamp: number;
    direction: "in" | "out";
    typeKey: NetTypeKey;
    fields: NetField[];
    truncated?: boolean;
}

export interface NetMessageType {
    key: NetTypeKey;
    count: number;
    countByDirection: { in: number; out: number };
    lastSeenAt: number;
    observedFields: string[];
}

export interface NetSerializerEntry {
    source: "auto" | "manual";
    direction: "send" | "recv";
    className: string;
    ns: string | null;
    methodName: string;
    methodSignature: string;
    paramIndex?: number;
    outputListIndex?: number;
    disabled?: boolean;
    stale?: boolean;
    addedAt: string;
    lastValidatedAt?: string;
}

export interface NetSerializerConfig {
    schemaVersion: 1;
    entries: NetSerializerEntry[];
}

export function encodeNetTypeKey(k: NetTypeKey): string {
    return `${k.ns ?? ""}~${k.className}`;
}

export interface LabelKeyLite {
    kind: "class" | "method" | "field";
    className: string;
    methodName?: string;
    fieldName?: string;
}

// ---------------------------------------------------------------------------
// v1.4 Instances plugin
// ---------------------------------------------------------------------------

export type InstanceRecipeStep =
    | { op: "captureViaGC"; className: string; index: number; asKey: string }
    | { op: "captureViaHook"; className: string; tickMethod: string; timeoutMs: number; asKey: string }
    | { op: "captureFieldValue"; ownerKey: string; fieldName: string; asKey: string }
    | { op: "captureListElement"; ownerKey: string; listFieldName: string; index: number; asKey: string }
    | { op: "captureMethodReturn"; ownerKey: string; methodName: string; args: unknown[]; asKey: string };

export interface InstanceRecipe {
    id: string;
    name: string;
    description?: string;
    steps: InstanceRecipeStep[];
    createdAt: string;
    updatedAt: string;
    lastReplayedAt?: string;
    lastReplayStatus?: "ok" | "partial" | "failed";
}

export interface CapturedInstanceLite {
    key: string;
    className: string;
    handle: string;
    capturedAt: string;
    capturedVia: InstanceRecipeStep["op"];
    isAlive: boolean;
}

export interface FieldReadLite {
    name: string;
    typeName: string;
    kind: "scalar" | "string" | "enum" | "nested" | "array" | "null" | "unknown";
    preview: string;
    rawValue?: string | number | boolean;
    enumNumeric?: number;
    nestedClass?: string;
    arrayLength?: number;
    isWritable: boolean;
}

export interface InstanceHistoryEntry {
    id: string;
    timestamp: string;
    action: "write" | "call";
    target: { instanceKey: string; member: string };
    before?: string;
    after?: string;
    callArgs?: unknown[];
    callResult?: string;
    success: boolean;
    error?: string;
}

export interface InstanceRecipeStepResult {
    stepIndex: number;
    op: InstanceRecipeStep["op"];
    asKey: string;
    ok: boolean;
    summary?: string;
    error?: string;
}

export interface InstanceRecipeReplayResult {
    steps: InstanceRecipeStepResult[];
    finalStatus: "ok" | "partial" | "failed";
}
