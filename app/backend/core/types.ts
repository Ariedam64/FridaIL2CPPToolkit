// Shared type definitions for the Frida IL2CPP Toolkit core.
// Imported by modules across src/core/. Keep in sync with the spec.

// ---------------------------------------------------------------------------
// Label store
// ---------------------------------------------------------------------------

export type LabelKey =
    | { kind: "class"; className: string }
    | { kind: "method"; className: string; methodName: string }
    | { kind: "field"; className: string; fieldName: string };

export interface LabelEntry {
    label: string;
    createdAt: string;   // ISO 8601
    updatedAt: string;   // ISO 8601
}

export interface LabelChangeEvent {
    key: LabelKey;
    oldLabel: string | null;
    newLabel: string | null;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export interface BookmarkEntry {
    createdAt: string;
}

export interface NoteEntry {
    markdown: string;
    updatedAt: string;
}

export interface AnnotationChangeEvent {
    key: LabelKey;
    kind: "bookmark" | "note";
    action: "added" | "removed" | "updated";
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type BuildIdSource =
    | "unity-boot-config"
    | "metadata-hash"
    | "binary-hash"
    | "timestamp";

export interface ProfileManifest {
    schemaVersion: 1;
    profileId: string;            // e.g. "dofus/8fcf84..."
    gameName: string;             // e.g. "dofus"
    buildId: string;              // hex
    buildIdSource: BuildIdSource;
    attachedFirstAt: string;
    attachedLastAt: string;
    derivedFrom: string | null;   // previous profileId, if migrated
    stats: {
        totalLabels: number;
        totalBookmarks: number;
        totalNotes: number;
    };
}

export interface BuildIdResult {
    buildId: string;
    source: BuildIdSource;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export interface FieldFingerprint {
    obfName: string;
    typeName: string;
    declIndex: number;
    isStatic: boolean;
    isPublic: boolean;
}

export interface MethodFingerprint {
    obfName: string;
    token: string | null;
    paramTypes: string[];
    returnType: string;
    paramCount: number;
    declIndex: number;
    isStatic: boolean;
}

export interface ClassFingerprint {
    obfName: string;
    token: string | null;
    parents: string[];
    methodCount: number;
    fields: FieldFingerprint[];
    methods: MethodFingerprint[];
}

export interface MigrationResult {
    auto: Array<{ key: LabelKey; oldObf: string; newObf: string; label: string; reason: string }>;
    review: Array<{ key: LabelKey; oldObf: string; candidates: Array<{ newObf: string; score: number; reason: string }>; label: string }>;
    lost: Array<{ key: LabelKey; oldObf: string; label: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export interface RpcClient {
    call<T>(method: string, args?: unknown[]): Promise<T>;
    isHealthy(): Promise<boolean>;
}
