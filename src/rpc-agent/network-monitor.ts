// Generic Network plugin agent module.
// Installs hooks at the SERIALIZER level (object-typed args/result) and emits
// network-frame events. Distinct from src/rpc-agent/network.ts (Dofus-specific).

import "frida-il2cpp-bridge";
import { findClassExact } from "../lib";

const MAX_FRAME_DEPTH = 6;
const MAX_FIELD_PREVIEW_CHARS = 80;
const MAX_FRAME_BYTES = 250_000;
/** Per-array cap on how many elements get walked into `children`. Above this
 *  we emit a "+N more" placeholder. Used to be 5 — bumped to keep large
 *  RepeatedFields (e.g. map interactives, ~40 items) fully visible. */
const MAX_ARRAY_ELEMENTS = 1000;
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
    /** Full untruncated value, set only when `preview` was clipped. Lets the
     *  frontend's Copy-JSON inflate the value back to full text. Kept absent
     *  when no truncation happened to keep the WS payload tight. */
    valueRaw?: string;
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
    outputListIndex?: number;
    disabled?: boolean;
    addedAt: string;
}

export interface SerializerConfig {
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

/** Variant of clip() that also returns the untruncated string when clipping
 *  happened. Used for variable-length values (strings, byte hex, unknown-field
 *  details) so the Copy JSON path can serialize the full content. */
function clipWithRaw(s: string, max = MAX_FIELD_PREVIEW_CHARS): { preview: string; valueRaw?: string } {
    if (s.length > max) return { preview: s.slice(0, max - 1) + "…", valueRaw: s };
    return { preview: s };
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

/**
 * If `obj` is a `gup` transport wrapper, deserialize its inner Any payload
 * back into a concrete protobuf message (jej, jev, jfk, …) and return that.
 * Otherwise return obj unchanged. Falls through silently on any error.
 */
function unwrapGupOrSimilar(obj: any): any {
    if (!obj || !obj.class) return obj;
    const cls = String(obj.class.name);
    // GameMessage / GameRequest: dereference their unique IMessage field.
    if (cls === "GameMessage" || cls === "GameRequest") {
        try {
            for (const f of obj.class.fields) {
                if (f.isStatic) continue;
                if (f.type.name !== "Google.Protobuf.IMessage") continue;
                const inner = obj.field(f.name).value;
                if (inner && inner.class) return unwrapGupOrSimilar(inner);
            }
        } catch {}
        return obj;
    }
    if (cls !== "gup") return obj;
    // gup.duke is System.Object (a `oneof` content) — for HDV traffic it's a
    // `guq` containing the Any payload. Walk the layout: gup → duke (guq) →
    // dukl (Any) → typeUrl_ + value_. Then ParseFrom the bytes via the
    // inner class's static MessageParser.
    try {
        const duke = obj.field("duke").value;
        if (!duke || !(duke as any).class) return obj;
        const dukl = (duke as any).field("dukl").value;
        if (!dukl || !(dukl as any).class) return obj;
        const tu = (dukl as any).field("typeUrl_").value;
        const tuStr = typeof tu === "string" ? tu : (tu?.content ?? "");
        const m = tuStr.match(/\/([^/]+)$/);
        const innerClassName = m ? m[1] : null;
        if (!innerClassName) return obj;
        const innerKlass = findClassExact(innerClassName);
        if (!innerKlass) return obj;
        // Find the static MessageParser<X> field (Ankama names it differently per class).
        let parser: any = null;
        for (const f of (innerKlass as any).fields) {
            if (!f.isStatic) continue;
            if (String(f.type?.name ?? "").includes("MessageParser")) {
                try { parser = (innerKlass as any).field(f.name).value; } catch {}
                if (parser) break;
            }
        }
        if (!parser) return obj;
        const byteString = (dukl as any).field("value_").value;
        if (!byteString) return obj;
        let inst: any = null;
        try {
            inst = parser.method("ParseFrom").overload("Google.Protobuf.ByteString").invoke(byteString);
        } catch { /* signature mismatch, give up */ }
        if (inst && inst.class) return inst;
    } catch {}
    return obj;
}

function decodeUnknownFieldSet(ufs: any): FrameField[] {
    if (!ufs || !(ufs as any).class) return [];
    const out: FrameField[] = [];
    // UnknownFieldSet stores a Dictionary<int, UnknownField> in field "fields_"
    // (Google.Protobuf C# convention). The dict's _entries hold the raw
    // (fieldNumber, UnknownField) pairs.
    let dict: any = null;
    for (const fname of ["fields_", "fields", "_fields"]) {
        try { const d = (ufs as any).tryField?.(fname)?.value; if (d) { dict = d; break; } } catch {}
    }
    if (!dict) return out;
    let entries: any = null;
    try { entries = (dict as any).tryField?.("_entries")?.value; } catch {}
    if (!entries) return out;
    const len = Number((entries as any).length ?? 0);
    for (let i = 0; i < len; i++) {
        let entry: any;
        try { entry = entries.get(i); } catch { continue; }
        if (!entry) continue;
        let key: number;
        try { key = Number(entry.field("key").value); } catch { continue; }
        if (!Number.isFinite(key) || key === 0) continue;
        let value: any;
        try { value = entry.field("value").value; } catch { continue; }
        if (!value) continue;
        // UnknownField: varintList, fixed32List, fixed64List, lengthDelimitedList
        const detail: string[] = [];
        const tryReadList = (fn: string, label: string): void => {
            try {
                const list = (value as any).tryField?.(fn)?.value;
                if (!list) return;
                const sz = Number(list.tryField?.("_size")?.value ?? 0);
                if (sz <= 0) return;
                const items = list.tryField?.("_items")?.value;
                const vs: string[] = [];
                for (let j = 0; j < Math.min(sz, 4); j++) {
                    try {
                        const x = items.get(j);
                        vs.push(typeof x === "bigint" ? String(x) : String(x));
                    } catch {}
                }
                detail.push(`${label}=[${vs.join(",")}${sz > 4 ? "…" : ""}]`);
            } catch {}
        };
        tryReadList("varintList", "varint");
        tryReadList("fixed32List", "fixed32");
        tryReadList("fixed64List", "fixed64");
        // lengthDelimitedList: each entry is a ByteString. Decode as hex.
        try {
            const list = (value as any).tryField?.("lengthDelimitedList")?.value;
            if (list) {
                const sz = Number(list.tryField?.("_size")?.value ?? 0);
                if (sz > 0) {
                    detail.push(`bytes×${sz}`);
                }
            }
        } catch {}
        out.push({
            name: `#${key}`,
            kind: "unknown",
            ...clipWithRaw(detail.length ? detail.join(" ") : "(empty)"),
        });
    }
    return out;
}

/** Collect non-static fields including inherited ones, but stop walking up
 *  at known opaque base classes so we don't pull internal runtime fields. */
function collectInheritedFields(klass: any): any[] {
    const out: any[] = [];
    let cur = klass;
    while (cur) {
        const cn = String(cur.name ?? "");
        if (cn === "Object" || cn === "ValueType" || cn.startsWith("System.")) break;
        for (const f of cur.fields) out.push(f);
        try { cur = cur.parent; } catch { break; }
    }
    return out;
}

/** Same as walkFields but uses collectInheritedFields to also see fields
 *  declared on parent classes (e.g. protobuf-generated messages whose data
 *  lives partly on a base class). */
function walkAllFields(obj: any, depth: number): FrameField[] {
    if (!obj || !obj.class || depth < 0) return [];
    return walkFieldsImpl(obj, depth, collectInheritedFields(obj.class));
}

function walkFields(obj: any, depth: number): FrameField[] {
    if (!obj || !obj.class || depth < 0) return [];
    return walkFieldsImpl(obj, depth, obj.class.fields);
}

function walkFieldsImpl(obj: any, depth: number, fields: any[]): FrameField[] {
    const out: FrameField[] = [];
    let totalBytes = 0;
    for (const f of fields) {
        if (f.isStatic) continue;
        const name = f.name as string;
        const typeName = f.type?.name as string;
        // Detect enum-typed fields up-front so they get classified as "enum"
        // rather than falling through to "unknown" (preview will show the
        // underlying numeric value or the symbol name when frida resolves it).
        let isEnum = false;
        try { isEnum = (f.type as any)?.class?.parent?.name === "Enum"; } catch {}
        let entry: FrameField;
        try {
            const v = obj.field(f.name).value;
            if (v === null || v === undefined) {
                // Show the field's declared type in the preview so the user
                // can see at a glance whether a null is "expected" (a primitive
                // that's just default 0) or a missing message (`null SomeType`).
                const shortType = typeName ? typeName.replace(/^System\./, "").replace(/^Google\.Protobuf\.WellKnownTypes\./, "") : "?";
                entry = { name, kind: "null", preview: `null (${shortType})` };
            } else if (typeName === "System.Byte[]") {
                entry = { name, kind: "bytes", ...clipWithRaw(previewBytes(v)) };
            } else if (typeof v === "string") {
                entry = { name, kind: "string", ...clipWithRaw(JSON.stringify(v)) };
            } else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
                entry = { name, kind: isEnum ? "enum" : classifyType(typeName), preview: clip(String(v)) };
            } else if (isEnum) {
                // For frida-il2cpp-bridge enum objects, the underlying integer lives in the
                // `value__` field. Extract it for a useful preview; fall back to `String(v)`
                // (typically the obfuscated symbol name) only if extraction fails.
                let preview = String(v);
                try {
                    const underlying = v.field("value__").value;
                    if (underlying !== null && underlying !== undefined) {
                        preview = String(underlying);
                    }
                } catch { /* keep fallback */ }
                entry = { name, kind: "enum", preview: clip(preview) };
            } else if (v.class) {
                const cn = String(v.class.name);
                if (cn === "UnknownFieldSet" || cn === "Google.Protobuf.UnknownFieldSet") {
                    // Decode unknown fields — these hold data the client's proto
                    // schema doesn't map, often because of a server/client desync.
                    // We list each (fieldNumber, type, value) seen.
                    const decoded = decodeUnknownFieldSet(v);
                    entry = {
                        name, kind: "nested",
                        preview: clip(`→ UnknownFieldSet (${decoded.length} unknown fields)`),
                        children: decoded,
                    };
                } else if (cn.startsWith("ReadOnlyMemory") || cn === "ReadOnlyMemory`1") {
                    // System.ReadOnlyMemory<byte> wraps an underlying byte[] with _object/_index/_length.
                    // Extract the slice as a hex preview so the bytes are usable.
                    try {
                        const obj = (v as any).field("_object").value;
                        const idx = Number((v as any).field("_index").value);
                        const len = Number((v as any).field("_length").value);
                        if (obj && Number.isFinite(idx) && Number.isFinite(len) && len >= 0 && len < 4096) {
                            const max = Math.min(len, 64);
                            const hex: string[] = [];
                            for (let i = 0; i < max; i++) {
                                try {
                                    const b = Number((obj as any).get(idx + i)) & 0xff;
                                    hex.push(b.toString(16).padStart(2, "0"));
                                } catch { hex.push("??"); }
                            }
                            const more = len > max ? ` … (+${len - max})` : "";
                            entry = { name, kind: "bytes", ...clipWithRaw(`[${len}] ${hex.join(" ")}${more}`) };
                        } else {
                            entry = { name, kind: "unknown", preview: clip(String(v)) };
                        }
                    } catch {
                        entry = { name, kind: "unknown", preview: clip(String(v)) };
                    }
                } else if (cn === "ByteString" || cn === "Google.Protobuf.ByteString") {
                    // Google.Protobuf.ByteString wraps a ReadOnlyMemory<byte>. Try several
                    // candidate field names since the layout may differ between Unity / .NET.
                    let preview = "";
                    let lastErr = "";
                    const fieldNames = ["bytes", "_bytes", "Bytes"];
                    for (const fn of fieldNames) {
                        try {
                            const inner = (v as any).field(fn).value;
                            if (!inner) { lastErr = `${fn}=null`; continue; }
                            // Try ReadOnlyMemory layout (_object/_index/_length)
                            // and ArraySegment fallback (_array/_offset/_count).
                            let obj: any = null, idx: number = NaN, len: number = NaN;
                            for (const tri of [
                                ["_object", "_index", "_length"],
                                ["_array",  "_offset", "_count"],
                            ]) {
                                try {
                                    obj = (inner as any).field(tri[0]).value;
                                    idx = Number((inner as any).field(tri[1]).value);
                                    len = Number((inner as any).field(tri[2]).value);
                                    if (obj && Number.isFinite(idx) && Number.isFinite(len)) break;
                                } catch (e) { lastErr = `${fn}.${tri[0]}: ${String(e).slice(0,40)}`; }
                            }
                            if (obj && Number.isFinite(idx) && Number.isFinite(len) && len < 4096) {
                                const max = Math.min(len, 64);
                                const hex: string[] = [];
                                // Three read strategies in order: array.get(), cast-to-Array, raw memory.
                                const readByte = (i: number): number | null => {
                                    try { const r = (obj as any).get(idx + i); if (typeof r === "number") return r & 0xff; if (typeof r === "bigint") return Number(r) & 0xff; } catch {}
                                    try {
                                        const handle = (obj as any).handle as NativePointer;
                                        if (handle) {
                                            // IL2CPP array layout (x64): 16-byte object header + 8-byte
                                            // bounds ptr + 8-byte length = 32-byte prefix before data.
                                            return handle.add(32 + idx + i).readU8();
                                        }
                                    } catch {}
                                    return null;
                                };
                                for (let i = 0; i < max; i++) {
                                    const b = readByte(i);
                                    hex.push(b === null ? "??" : b.toString(16).padStart(2, "0"));
                                }
                                const more = len > max ? ` … (+${len - max})` : "";
                                preview = `[${len}] ${hex.join(" ")}${more}`;
                                break;
                            }
                        } catch (e) { lastErr = `${fn}: ${String(e).slice(0, 40)}`; }
                    }
                    if (preview) {
                        entry = { name, kind: "bytes", ...clipWithRaw(preview) };
                    } else {
                        entry = { name, kind: "nested", preview: clip(`→ ${cn} <decode err: ${lastErr || "?"}>`) };
                    }
                } else if (cn.startsWith("RepeatedField") || cn.startsWith("List")
                    || cn.startsWith("Google.Protobuf.Collections.RepeatedField")) {
                    // Probe backing array fields. RepeatedField<T> in C# protobuf
                    // exposes `array` + `count`; List<T> uses `_items` + `_size`.
                    // Reading the backing storage directly is mandatory for
                    // primitive element types (long/int) — get_Item throws
                    // on those because of boxing issues in frida-il2cpp-bridge.
                    let backingArr: any = null;
                    let backingCount = -1;
                    for (const fn of ["_items", "array"]) {
                        try { const a = (v as any).tryField?.(fn)?.value; if (a) { backingArr = a; break; } } catch {}
                    }
                    for (const fn of ["_size", "count"]) {
                        try { const s = (v as any).tryField?.(fn)?.value; if (typeof s === "number") { backingCount = s; break; } } catch {}
                    }
                    let count = backingCount;
                    if (count < 0) {
                        try { count = Number(v.method("get_Count").invoke()); } catch { count = 0; }
                    }
                    entry = { name, kind: "array", preview: clip(`[${count} items]`) };
                    if (depth > 0 && count > 0) {
                        const children: FrameField[] = [];
                        const limit = Math.min(count, MAX_ARRAY_ELEMENTS);
                        for (let i = 0; i < limit; i++) {
                            try {
                                let elem: any;
                                if (backingArr) {
                                    try { elem = (backingArr as any).get(i); }
                                    catch { elem = v.method("get_Item").invoke(i); }
                                } else {
                                    elem = v.method("get_Item").invoke(i);
                                }
                                if (elem === null || elem === undefined) {
                                    children.push({ name: `[${i}]`, kind: "null", preview: "null" });
                                } else if (typeof elem === "number" || typeof elem === "boolean") {
                                    children.push({ name: `[${i}]`, kind: typeof elem === "number" ? "int" : "bool", preview: clip(String(elem)) });
                                } else if (typeof elem === "bigint") {
                                    children.push({ name: `[${i}]`, kind: "long", preview: clip(String(elem)) });
                                } else if (typeof elem === "string") {
                                    children.push({ name: `[${i}]`, kind: "string", ...clipWithRaw(JSON.stringify(elem)) });
                                } else if ((elem as any).class) {
                                    const sub = walkAllFields(elem, depth - 1);
                                    const elemCls = String((elem as any).class.name);
                                    children.push({
                                        name: `[${i}]`,
                                        kind: "nested",
                                        preview: clip(`→ ${elemCls}${sub.length ? ` (${sub.length} fields)` : ""}`),
                                        children: sub,
                                    });
                                } else {
                                    children.push({ name: `[${i}]`, kind: "unknown", preview: clip(String(elem)) });
                                }
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
                entry = { name, kind: classifyType(typeName), ...clipWithRaw(String(v)) };
            }
        } catch (err) {
            const msg = String(err);
            // A 0x0 access violation means the field stored a null reference and
            // the bridge tried to dereference it. Treat as a legitimate null.
            if (msg.includes("access violation") && msg.includes("0x0")) {
                entry = { name, kind: "null", preview: "null" };
            } else {
                entry = { name, kind: "unknown", preview: clip(`<err: ${msg.slice(0, 60)}>`) };
            }
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

/** Synchronous install — caller is responsible for already being inside an
 *  Il2Cpp.perform context. Used both by armNetworkCapture (the public RPC)
 *  and by the agent's startup pre-arm path (where we install hooks inside
 *  the SAME perform that signals agent-ready, eliminating any race with
 *  the game's first network packet). */
export function installSerializerHooksSync(config: SerializerConfig): { installed: number; failed: SerializerEntry[] } {
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
}

export async function armNetworkCapture(config: SerializerConfig): Promise<{ installed: number; failed: SerializerEntry[] }> {
    return inVm(() => installSerializerHooksSync(config));
}

function installEntryHook(entry: SerializerEntry, method: Il2Cpp.Method): void {
    const isStatic = method.isStatic;
    const klass = method.class;
    const methodName = entry.methodName;
    const sendIndex = entry.paramIndex ?? 0;
    const outListIdx = entry.outputListIndex;

    method.implementation = function (this: any, ...args: any[]): any {
        // Snapshot output list count BEFORE the original call (recv-output-list mode).
        let beforeCount = -1;
        let outputList: any = null;
        if (outListIdx !== undefined && entry.direction === "recv") {
            outputList = args[outListIdx];
            try {
                if (outputList) beforeCount = Number(outputList.method("get_Count").invoke());
            } catch {}
        }

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
            if (outListIdx !== undefined && entry.direction === "recv") {
                // Output-list pattern: walk each newly appended element.
                if (outputList && beforeCount >= 0) {
                    let afterCount = beforeCount;
                    try { afterCount = Number(outputList.method("get_Count").invoke()); } catch {}
                    for (let i = beforeCount; i < afterCount; i++) {
                        try {
                            let elem = outputList.method("get_Item").invoke(i) as any;
                            if (!elem || !elem.class) continue;
                            elem = unwrapGupOrSimilar(elem);
                            const fields = walkFields(elem, MAX_FRAME_DEPTH);
                            const truncated = fields.length > 0 && fields[fields.length - 1].preview === TRUNCATED_MARKER;
                            const typeKey: TypeKey = {
                                ns: elem.class.namespace || null,
                                className: elem.class.name,
                            };
                            send({
                                type: "network-frame",
                                direction: "in",
                                timestamp: Date.now(),
                                typeKey,
                                fields,
                                truncated,
                            });
                        } catch (err) {
                            captureWalkError(entry, String(err));
                        }
                    }
                }
            } else {
                // Default extraction: args[paramIndex] for send, result for recv.
                let messageObj = entry.direction === "send" ? args[sendIndex] : result;
                if (messageObj && typeof messageObj === "object" && messageObj.class) {
                    messageObj = unwrapGupOrSimilar(messageObj);
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
        try {
            send({
                type: "network-auto-revert",
                entry: {
                    className: entry.className,
                    ns: entry.ns,
                    methodName: entry.methodName,
                    direction: entry.direction,
                },
                reason: "throw-flood",
                detail: error.slice(0, 200),
            });
        } catch {}
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
