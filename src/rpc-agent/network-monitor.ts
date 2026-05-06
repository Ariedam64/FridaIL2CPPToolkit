// Generic Network plugin agent module.
// Installs hooks at the SERIALIZER level (object-typed args/result) and emits
// network-frame events. Distinct from src/rpc-agent/network.ts (Dofus-specific).

import "frida-il2cpp-bridge";
import { findClassExact } from "../lib";

const MAX_FRAME_DEPTH = 2;
const MAX_FIELD_PREVIEW_CHARS = 80;
const MAX_FRAME_BYTES = 50_000;
const FLOOD_WINDOW_MS = 1000;
const FLOOD_MAX_THROWS = 50;
const TRUNCATED_MARKER = "<truncated: frame too large>";

type FieldKind =
    | "int" | "long" | "float" | "bool"
    | "string" | "bytes" | "enum"
    | "nested" | "array" | "null" | "unknown";

interface FrameField {
    name: string;
    kind: FieldKind;
    preview: string;
    children?: FrameField[];
}

interface TypeKey { ns: string | null; className: string; }

interface SerializerEntry {
    source: "auto" | "manual";
    direction: "send" | "recv";
    className: string;
    ns: string | null;
    methodName: string;
    methodSignature: string;
    paramIndex?: number;
    disabled?: boolean;
    addedAt: string;
}

interface SerializerConfig {
    schemaVersion: 1;
    entries: SerializerEntry[];
}

interface InstalledEntry {
    entry: SerializerEntry;
    method: Il2Cpp.Method;
    throwsInWindow: number;
    throwWindowStart: number;
}

const _installed = new Map<string, InstalledEntry>();

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function entryId(e: SerializerEntry): string {
    // Include ns + signature so two overloads or namespaced classes with the
    // same short name don't collide in `_installed`.
    const ns = e.ns ?? "";
    return `${ns}.${e.className}.${e.methodName}(${e.methodSignature})@${e.direction}`;
}

function classifyType(typeName: string): FieldKind {
    if (typeName === "System.Int32" || typeName === "System.UInt32"
        || typeName === "System.Int16" || typeName === "System.UInt16"
        || typeName === "System.SByte" || typeName === "System.Byte") return "int";
    if (typeName === "System.Int64" || typeName === "System.UInt64") return "long";
    if (typeName === "System.Single" || typeName === "System.Double") return "float";
    if (typeName === "System.Boolean") return "bool";
    if (typeName === "System.String") return "string";
    if (typeName === "System.Byte[]" || typeName === "Google.Protobuf.ByteString") return "bytes";
    return "unknown";
}

function clip(s: string, max = MAX_FIELD_PREVIEW_CHARS): string {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function previewBytes(arr: any): string {
    try {
        const n = Math.min(16, Number(arr.length ?? 0));
        const bytes: string[] = [];
        for (let i = 0; i < n; i++) {
            const v = Number(arr.get?.(i) ?? 0);
            bytes.push((v & 0xff).toString(16).padStart(2, "0"));
        }
        const more = (arr.length ?? 0) > n ? `… (+${arr.length - n})` : "";
        return `[${arr.length} bytes] ${bytes.join(" ")}${more}`;
    } catch { return "<bytes>"; }
}

function walkFields(obj: any, depth: number): FrameField[] {
    if (!obj || !obj.class || depth < 0) return [];
    const out: FrameField[] = [];
    let totalBytes = 0;
    for (const f of obj.class.fields) {
        if (f.isStatic) continue;
        const name = f.name as string;
        const typeName = f.type?.name as string;
        let entry: FrameField;
        try {
            const v = obj.field(f.name).value;
            if (v === null || v === undefined) {
                entry = { name, kind: "null", preview: "null" };
            } else if (typeName === "System.Byte[]") {
                entry = { name, kind: "bytes", preview: clip(previewBytes(v)) };
            } else if (typeof v === "string") {
                entry = { name, kind: "string", preview: clip(JSON.stringify(v)) };
            } else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
                entry = { name, kind: classifyType(typeName), preview: clip(String(v)) };
            } else if (v.class) {
                const cn = String(v.class.name);
                if (cn.startsWith("RepeatedField") || cn.startsWith("List")
                    || cn.startsWith("Google.Protobuf.Collections.RepeatedField")) {
                    let count = 0;
                    try { count = Number(v.method("get_Count").invoke()); } catch {}
                    entry = { name, kind: "array", preview: clip(`[${count} items]`) };
                    if (depth > 0 && count > 0) {
                        const children: FrameField[] = [];
                        const limit = Math.min(count, 5);
                        for (let i = 0; i < limit; i++) {
                            try {
                                const elem = v.method("get_Item").invoke(i);
                                const sub = walkFields(elem, depth - 1);
                                children.push({
                                    name: `[${i}]`,
                                    kind: "nested",
                                    preview: clip(`→ ${sub.length} fields`),
                                    children: sub,
                                });
                            } catch {
                                children.push({ name: `[${i}]`, kind: "unknown", preview: "<err>" });
                            }
                        }
                        if (count > limit) {
                            children.push({ name: `…`, kind: "unknown", preview: `+${count - limit} more` });
                        }
                        entry.children = children;
                    }
                } else if (depth > 0) {
                    const inner = walkFields(v, depth - 1);
                    entry = {
                        name, kind: "nested",
                        preview: clip(`→ ${cn}`),
                        children: inner,
                    };
                } else {
                    entry = { name, kind: "nested", preview: clip(`→ ${cn}`) };
                }
            } else {
                entry = { name, kind: classifyType(typeName), preview: clip(String(v)) };
            }
        } catch (err) {
            entry = { name, kind: "unknown", preview: clip(`<err: ${String(err).slice(0, 60)}>`) };
        }
        out.push(entry);
        totalBytes += JSON.stringify(entry).length;
        if (totalBytes > MAX_FRAME_BYTES) {
            out.push({ name: "…", kind: "unknown", preview: TRUNCATED_MARKER });
            break;
        }
    }
    return out;
}

function findMethodOnClass(klass: Il2Cpp.Class, methodName: string, signature: string): Il2Cpp.Method | null {
    const all = klass.methods.filter((m) => m.name === methodName);
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];
    const exact = all.find((m) => buildSignature(m) === signature);
    return exact ?? all[0];
}

function buildSignature(m: Il2Cpp.Method): string {
    const params = m.parameters.map((p) => p.type.name).join(",");
    return `(${params}):${m.returnType.name}`;
}

export async function validateSerializerEntry(entry: SerializerEntry): Promise<{ valid: boolean; reason?: string; actualSignature?: string }> {
    return inVm(() => {
        const klass = findClassExact(entry.ns ? `${entry.ns}.${entry.className}` : entry.className);
        if (!klass) return { valid: false, reason: "class not found" };
        const m = findMethodOnClass(klass, entry.methodName, entry.methodSignature);
        if (!m) return { valid: false, reason: "method not found" };
        return { valid: true, actualSignature: buildSignature(m) };
    });
}

export async function armNetworkCapture(config: SerializerConfig): Promise<{ installed: number; failed: SerializerEntry[] }> {
    return inVm(() => {
        const failed: SerializerEntry[] = [];
        for (const entry of config.entries) {
            if (entry.disabled) continue;
            try {
                const klass = findClassExact(entry.ns ? `${entry.ns}.${entry.className}` : entry.className);
                if (!klass) { failed.push(entry); continue; }
                const method = findMethodOnClass(klass, entry.methodName, entry.methodSignature);
                if (!method) { failed.push(entry); continue; }
                const id = entryId(entry);
                if (_installed.has(id)) continue;
                installEntryHook(entry, method);
                _installed.set(id, {
                    entry, method,
                    throwsInWindow: 0, throwWindowStart: 0,
                });
            } catch {
                failed.push(entry);
            }
        }
        return { installed: _installed.size, failed };
    });
}

function installEntryHook(entry: SerializerEntry, method: Il2Cpp.Method): void {
    const isStatic = method.isStatic;
    const klass = method.class;
    const methodName = entry.methodName;
    const sendIndex = entry.paramIndex ?? 0;

    method.implementation = function (this: any, ...args: any[]): any {
        let result: any;
        try {
            result = isStatic
                ? klass.method(methodName).invoke(...args)
                : (this as Il2Cpp.Object).method(methodName).invoke(...args);
        } catch (err) {
            captureThrow(entry, String(err));
            throw err;
        }
        try {
            const messageObj = entry.direction === "send" ? args[sendIndex] : result;
            if (messageObj && typeof messageObj === "object" && messageObj.class) {
                const fields = walkFields(messageObj, MAX_FRAME_DEPTH);
                const truncated = fields.length > 0 && fields[fields.length - 1].preview === TRUNCATED_MARKER;
                const typeKey: TypeKey = {
                    ns: messageObj.class.namespace || null,
                    className: messageObj.class.name,
                };
                send({
                    type: "network-frame",
                    direction: entry.direction === "send" ? "out" : "in",
                    timestamp: Date.now(),
                    typeKey,
                    fields,
                    truncated,
                });
            }
        } catch (err) {
            captureWalkError(entry, String(err));
        }
        return result;
    };
}

function captureThrow(entry: SerializerEntry, error: string): void {
    const id = entryId(entry);
    const inst = _installed.get(id);
    if (!inst) return;
    const now = Date.now();
    if (now - inst.throwWindowStart > FLOOD_WINDOW_MS) {
        inst.throwWindowStart = now;
        inst.throwsInWindow = 1;
    } else {
        inst.throwsInWindow++;
    }
    if (inst.throwsInWindow >= FLOOD_MAX_THROWS) {
        try { inst.method.revert(); } catch {}
        _installed.delete(id);
        try { send({ type: "network-auto-revert", entryId: id, reason: "throw-flood", detail: error.slice(0, 200) }); } catch {}
    }
}

function captureWalkError(entry: SerializerEntry, error: string): void {
    const id = entryId(entry);
    try {
        send({ type: "network-frame-error", entryId: id, error: error.slice(0, 200) });
    } catch {}
}

export async function disarmNetworkCapture(): Promise<{ reverted: number }> {
    return inVm(() => {
        let n = 0;
        for (const [, inst] of _installed) {
            try { inst.method.revert(); n++; } catch {}
        }
        _installed.clear();
        return { reverted: n };
    });
}

export async function listInstalledNetworkHooks(): Promise<SerializerEntry[]> {
    return inVm(() => {
        const out: SerializerEntry[] = [];
        _installed.forEach((inst) => out.push(inst.entry));
        return out;
    });
}
