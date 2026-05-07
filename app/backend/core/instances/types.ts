// Shared types for the v1.4 Instances plugin.
// See docs/superpowers/specs/2026-05-07-frida-toolkit-plugin-instances-design.md

// ---------------------------------------------------------------------------
// Recipe — persisted, replayable chain of capture operations
// ---------------------------------------------------------------------------

export type RecipeStep =
    | { op: "captureViaGC"; className: string; index: number; asKey: string }
    | { op: "captureViaHook"; className: string; tickMethod: string; timeoutMs: number; asKey: string }
    | { op: "captureFieldValue"; ownerKey: string; fieldName: string; asKey: string }
    | { op: "captureListElement"; ownerKey: string; listFieldName: string; index: number; asKey: string }
    | { op: "captureMethodReturn"; ownerKey: string; methodName: string; args: unknown[]; asKey: string };

export interface Recipe {
    id: string;
    name: string;
    description?: string;
    steps: RecipeStep[];
    createdAt: string;
    updatedAt: string;
    lastReplayedAt?: string;
    lastReplayStatus?: "ok" | "partial" | "failed";
}

export interface RecipeStoreSchemaV1 {
    schemaVersion: 1;
    recipes: Recipe[];
}

// ---------------------------------------------------------------------------
// CapturedInstance — in-memory entry in the registry
// ---------------------------------------------------------------------------

export interface CapturedInstance {
    key: string;
    className: string;
    handle: string;
    capturedAt: string;
    capturedVia: RecipeStep["op"];
    isAlive: boolean;
}

// ---------------------------------------------------------------------------
// FieldRead — structured read result for one field
// ---------------------------------------------------------------------------

export type FieldKind = "scalar" | "string" | "enum" | "nested" | "array" | "null" | "unknown";

export interface FieldRead {
    name: string;
    typeName: string;
    kind: FieldKind;
    preview: string;
    rawValue?: string | number | boolean;
    enumNumeric?: number;
    nestedClass?: string;
    arrayLength?: number;
    isWritable: boolean;
}

// ---------------------------------------------------------------------------
// HistoryEntry — audit trail of mutations during this session
// ---------------------------------------------------------------------------

export interface HistoryEntry {
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

// ---------------------------------------------------------------------------
// Replay result — returned by replay engine + recipes/:id/replay route
// ---------------------------------------------------------------------------

export interface RecipeStepResult {
    stepIndex: number;
    op: RecipeStep["op"];
    asKey: string;
    ok: boolean;
    summary?: string;
    error?: string;
}

export interface RecipeReplayResult {
    steps: RecipeStepResult[];
    finalStatus: "ok" | "partial" | "failed";
}
