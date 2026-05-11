// Pure type declarations, tunable constants, and TypeKey utilities for the
// Network plugin. No stateful logic — frame-store / type-aggregator /
// serializer-config import these.

export const MAX_FRAME_DEPTH = 2;
export const MAX_FIELD_PREVIEW_CHARS = 80;
export const MAX_FRAME_BYTES = 250_000;
export const RING_BUFFER_SIZE = 5000;
export const FRAME_BROADCAST_THROTTLE_MS = 20;
export const ANTI_FLOOD_THROWS_PER_SEC = 50;

export interface TypeKey {
    ns: string | null;
    className: string;
}

export type FrameFieldKind =
    | "int" | "long" | "float" | "bool"
    | "string" | "bytes" | "enum"
    | "nested" | "array" | "null" | "unknown";

export interface FrameField {
    name: string;
    kind: FrameFieldKind;
    preview: string;
    /** Full untruncated value, set ONLY when `preview` was clipped. The
     *  Copy-JSON path inflates `preview` from this so users get full strings /
     *  full byte hex without bloating the live UI render. */
    valueRaw?: string;
    children?: FrameField[];
}

export interface NetworkFrame {
    id: string;
    timestamp: number;
    direction: "in" | "out";
    typeKey: TypeKey;
    fields: FrameField[];
    truncated?: boolean;
}

export interface MessageType {
    key: TypeKey;
    count: number;
    countByDirection: { in: number; out: number };
    lastSeenAt: number;
    observedFields: string[];
}

export interface SerializerEntry {
    source: "auto" | "manual";
    direction: "send" | "recv";
    className: string;
    ns: string | null;
    methodName: string;
    methodSignature: string;
    paramIndex?: number;
    /**
     * For decoders that APPEND decoded messages to a `List<Object>` output
     * parameter (DotNetty pattern: `Decode(ctx, input, List<Object> output)`).
     * When set, the agent compares the list's Count before/after the original
     * call and walks each newly added element as a separate frame.
     * Only meaningful when direction === "recv". Mutually exclusive with the
     * default "extract from result" path.
     */
    outputListIndex?: number;
    disabled?: boolean;
    addedAt: string;
    lastValidatedAt?: string;
    /**
     * Set by `validateSerializerEntry` when the agent fails to find this
     * (className, methodName, signature) triple. Stale entries are NOT
     * installed at arm time. Cleared on next successful validation.
     */
    stale?: boolean;
}

export interface SerializerConfig {
    schemaVersion: 1;
    entries: SerializerEntry[];
}

/**
 * Encode a TypeKey to a URL-safe segment. Inverse: `decodeTypeKey`.
 * Encoding shape: `<ns-or-empty>~<className>` then `encodeURIComponent`'d
 * by the caller before being slotted into a path.
 */
export function encodeTypeKey(k: TypeKey): string {
    return `${k.ns ?? ""}~${k.className}`;
}

export function decodeTypeKey(encoded: string): TypeKey {
    const idx = encoded.lastIndexOf("~");
    if (idx < 0) return { ns: null, className: encoded };
    const ns = encoded.slice(0, idx);
    const className = encoded.slice(idx + 1);
    return { ns: ns === "" ? null : ns, className };
}

export function sameTypeKey(a: TypeKey, b: TypeKey): boolean {
    return a.ns === b.ns && a.className === b.className;
}
