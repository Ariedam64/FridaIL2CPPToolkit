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
    /** Protobuf signature captured at rename time. Lets the migration engine
     *  re-link this label to its renamed class on a future game version even
     *  if the obfuscated `className` key has changed. Optional — pre-existing
     *  entries (renamed before this feature) won't have it. */
    signature?: string;
    /** Short hash of the signature, used as a faster compare key. */
    fingerprint?: string;
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
    /** Optional FNV-1a fingerprint of the class's stable-types signature.
     *  Computed by the agent (lockstep with `extractStructuralSignature`) so
     *  the migration engine can do an exact lookup against the previous
     *  build's label fingerprints. Absent on legacy fingerprints captured
     *  before the structural feature shipped — those fall back to similarity. */
    structuralFp?: string | null;
}

export interface MigrationAutoRecord {
    key: LabelKey;
    oldObf: string;
    newObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

export interface MigrationReviewRecord {
    key: LabelKey;
    oldObf: string;
    candidates: Array<{ newObf: string; score: number; reason: string }>;
    label: string;
    parentClassMigration?: string;
}

export interface MigrationLostRecord {
    key: LabelKey;
    oldObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

export interface MigrationResult {
    auto: MigrationAutoRecord[];
    review: MigrationReviewRecord[];
    lost: MigrationLostRecord[];
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export interface RpcClient {
    call<T>(method: string, args?: unknown[]): Promise<T>;
    isHealthy(): Promise<boolean>;
}
