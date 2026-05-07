// Plugin Scripts — shared types.
// Imported by script-loader, script-runner, toolkit-api, routes/scripts, and the frontend.

export type ParamSpec =
    | { type: "string";  label?: string; required?: boolean; default?: string;  placeholder?: string }
    | { type: "number";  label?: string; required?: boolean; default?: number;  min?: number; max?: number }
    // Note: boolean and enum have no `required` field by design — boolean always resolves to true/false (no "missing"); enum always provides a default or reads from a select widget.
    | { type: "boolean"; label?: string; default?: boolean }
    | { type: "enum";    label?: string; values: readonly string[]; default?: string };

export type ParamSchema = Record<string, ParamSpec>;

export interface ScriptDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
    name: string;
    description?: string;
    params: { [K in keyof P]: ParamSpec };
    timeoutMs?: number;
    run: (args: P, toolkit: Toolkit) => Promise<unknown>;
}

export interface RegistryEntry {
    id: string;                 // = filename without .ts
    filePath: string;
    status: "loaded" | "compile-error" | "validation-error";
    definition?: Omit<ScriptDefinition, "run">;  // serializable subset for the API
    error?: string;
    loadedAt: string;           // ISO 8601
}

export interface RunResult {
    runId: string;
    scriptId: string;
    status: "ok" | "error" | "timeout";
    result?: unknown;
    error?: { message: string; stack?: string };
    startedAt: string;
    durationMs: number;
}

export interface ScriptLog {
    runId: string;
    level: "info" | "warn" | "error";
    args: unknown[];
    ts: string;
}

// ---------------------------------------------------------------------------
// Injected `toolkit` API surface
// ---------------------------------------------------------------------------

export type InstanceHandle = { className: string; handle: string; key: string };
export type HookHandle = { id: string };

export interface CaptureOpts { asKey?: string; index?: number }
export interface HookInstallOpts { mode?: "log" | "modify-return"; returnValue?: unknown }
export interface HookCallEvent { args: unknown[]; ts: string }

export interface NetworkPacket {
    id: string;
    direction: "in" | "out";
    messageType: string;
    payload: unknown;
    ts: number;
}

export interface Toolkit {
    instances: {
        find(label: string): Promise<InstanceHandle>;
        findAll(label: string): Promise<InstanceHandle[]>;
        capture(label: string, opts?: CaptureOpts): Promise<InstanceHandle>;
        read(handle: InstanceHandle, field: string): Promise<unknown>;
        write(handle: InstanceHandle, field: string, value: unknown): Promise<void>;
        call(handle: InstanceHandle, method: string, args?: unknown[]): Promise<unknown>;
        list(): Promise<InstanceHandle[]>;
    };
    hooks: {
        install(target: string, opts: HookInstallOpts): Promise<HookHandle>;
        remove(handle: HookHandle): Promise<void>;
        onceCall(target: string, opts?: { timeoutMs?: number }): Promise<HookCallEvent>;
    };
    network: {
        send(messageType: string, payload: Record<string, unknown>): Promise<void>;
        onceReceive(messageType: string, opts?: { timeoutMs?: number }): Promise<NetworkPacket>;
        recent(messageType?: string, limit?: number): Promise<NetworkPacket[]>;
    };
    log:   (...args: unknown[]) => void;
    warn:  (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    sleep: (ms: number) => Promise<void>;
}

// `defineScript` is an identity function with type inference for `params` → `args`.
export function defineScript<P extends Record<string, unknown>>(def: ScriptDefinition<P>): ScriptDefinition<P> {
    return def;
}
