// RPC methods for the assembly/inheritance tree explorer: listAssembliesInfo, listNamespaces, listClassesIn, listSubclasses.
import "frida-il2cpp-bridge";
import { findClass, fullClassName } from "../lib";

// ----------------------------------------------------------------------
// Protocol name sniffer — accumulator for runtime descriptor capture
// ----------------------------------------------------------------------
// Map: obfuscated CLR class name → original .proto FullName
// Filled by hooks installed via installProtoNameSniffer().
const collectedProtoNames = new Map<string, string>();
// Raw FileDescriptorProto binary blobs captured at FromGeneratedCode().
// Each entry is base64-encoded for transport. Decoded offline by Python.
const collectedFileDescriptorProtos: Array<{ size: number; b64: string; ts: number }> = [];
let snifferInstalled = false;

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

// ---------- Session-level cache for the Process Explorer's enumeration RPCs ----------
// Built lazily on first call; ~13k classes → ~50-200ms one-time build.
// Each subsequent call is O(1) for assemblies/namespaces, O(N) for in-namespace
// class lists (still beats re-walking the full domain every time).
//
// Frida agents reload their JS context on each attach, so this cache resets
// naturally per attach — no manual invalidation needed.

interface AsmIndex {
    name: string;
    classCount: number;
    // ns label → simple class names (uses "(root)" for empty namespace, matching
    // the pre-existing listNamespaces / listClassesIn convention)
    namespaces: Map<string, string[]>;
}

let _asmIndex: AsmIndex[] | null = null;
let _classByName: Map<string, Il2Cpp.Class> | null = null;

function buildExplorerIndex(): void {
    if (_asmIndex) return;
    const list: AsmIndex[] = [];
    const byName = new Map<string, Il2Cpp.Class>();
    for (const asm of Il2Cpp.domain.assemblies) {
        const namespaces = new Map<string, string[]>();
        let count = 0;
        try {
            for (const k of asm.image.classes) {
                count++;
                // Use "(root)" for empty namespace — matches the pre-existing convention
                // used by listNamespaces / listClassesIn.
                const ns = (k.namespace ?? "") || "(root)";
                let arr = namespaces.get(ns);
                if (!arr) { arr = []; namespaces.set(ns, arr); }
                arr.push(k.name);
                if (!byName.has(k.name)) byName.set(k.name, k);
            }
        } catch {}
        list.push({ name: asm.name, classCount: count, namespaces });
    }
    // Preserve original sort order: descending by class count (matches listAssembliesInfo)
    list.sort((a, b) => b.classCount - a.classCount);
    _asmIndex = list;
    _classByName = byName;
    console.log(`[explorer] index built: ${list.length} assemblies, ${byName.size} classes`);
}

// ---------- inheritance cache (lazy, built on first listSubclasses call) ----
let inheritanceCache: Map<string, string[]> | null = null;
function ensureInheritanceCache(): void {
    if (inheritanceCache) return;
    const map = new Map<string, string[]>();
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                const parent = k.parent;
                if (!parent) continue;
                const childName = fullClassName(k);
                for (const key of [parent.name, fullClassName(parent)]) {
                    if (!map.has(key)) map.set(key, []);
                    if (!map.get(key)!.includes(childName)) map.get(key)!.push(childName);
                }
            }
        } catch {}
    }
    for (const arr of map.values()) arr.sort();
    inheritanceCache = map;
    console.log(`[explorer] inheritance cache built: ${map.size} parents`);
}

/**
 * Search for classes across all assemblies/namespaces without requiring the
 * tree to be expanded. Walks the cached _asmIndex and returns up to `limit`
 * matches where shortName OR fullName contains `query` (case-insensitive).
 * The returned `ns` field uses the real namespace string ("" for root-level
 * classes, NOT the internal "(root)" sentinel).
 */
export function searchClasses(
    query: string,
    limit: number = 100,
): Promise<Array<{ shortName: string; fullName: string; assembly: string; ns: string }>> {
    return inVm(() => {
        buildExplorerIndex();
        const out: Array<{ shortName: string; fullName: string; assembly: string; ns: string }> = [];
        if (!query || query.length < 1) return out;
        const q = query.toLowerCase();
        for (const asm of _asmIndex!) {
            for (const [nsKey, classes] of asm.namespaces) {
                // Convert internal "(root)" sentinel back to empty string for callers
                const ns = nsKey === "(root)" ? "" : nsKey;
                for (const shortName of classes) {
                    const fullName = ns ? `${ns}.${shortName}` : shortName;
                    if (shortName.toLowerCase().includes(q) || fullName.toLowerCase().includes(q)) {
                        out.push({ shortName, fullName, assembly: asm.name, ns });
                        if (out.length >= limit) return out;
                    }
                }
            }
        }
        return out;
    }) as unknown as Promise<Array<{ shortName: string; fullName: string; assembly: string; ns: string }>>;
}

/**
 * Resolve a list of obfuscated short class names to the same shape as
 * `searchClasses`. Used by the explorer's friendly-label search path: the
 * backend matches labels client-side (substring against `label.toLowerCase()`),
 * gets a small set of obfNames, then asks the agent to fill in their
 * namespace/assembly so they can be rendered in the result list.
 *
 * Unknown names are silently dropped (no entry in the output). Duplicates in
 * input are deduped on the way out.
 */
export function lookupClassesByName(
    obfNames: string[],
): Promise<Array<{ shortName: string; fullName: string; assembly: string; ns: string }>> {
    return inVm(() => {
        buildExplorerIndex();
        const wanted = new Set(obfNames);
        const out: Array<{ shortName: string; fullName: string; assembly: string; ns: string }> = [];
        const seen = new Set<string>();
        for (const asm of _asmIndex!) {
            for (const [nsKey, classes] of asm.namespaces) {
                const ns = nsKey === "(root)" ? "" : nsKey;
                for (const shortName of classes) {
                    if (!wanted.has(shortName) || seen.has(shortName)) continue;
                    out.push({
                        shortName,
                        fullName: ns ? `${ns}.${shortName}` : shortName,
                        assembly: asm.name,
                        ns,
                    });
                    seen.add(shortName);
                }
            }
        }
        return out;
    }) as unknown as Promise<Array<{ shortName: string; fullName: string; assembly: string; ns: string }>>;
}

/**
 * Pre-warm the explorer index during attach so the first user click is instant.
 * Safe to call multiple times — buildExplorerIndex() is idempotent.
 */
export function prewarmExplorerIndex(): Promise<{ assemblies: number; classes: number }> {
    return inVm(() => {
        buildExplorerIndex();
        return {
            assemblies: _asmIndex!.length,
            classes: _classByName!.size,
        };
    }) as unknown as Promise<{ assemblies: number; classes: number }>;
}

/** List assemblies + class count. Returns array of { name, classes }. */
export function listAssembliesInfo(): Promise<Array<{ name: string; classes: number }>> {
    return inVm(() => {
        buildExplorerIndex();
        return _asmIndex!.map((a) => ({ name: a.name, classes: a.classCount }));
    });
}

/** List distinct namespaces in an assembly (+ class count per namespace). */
export function listNamespaces(assemblyName: string): Promise<Array<{ ns: string; classes: number }>> {
    return inVm(() => {
        buildExplorerIndex();
        const asm = _asmIndex!.find((a) => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const out: Array<{ ns: string; classes: number }> = [];
        asm.namespaces.forEach((classes, ns) => out.push({ ns, classes: classes.length }));
        out.sort((a, b) => a.ns.localeCompare(b.ns));
        return out;
    });
}

/** List class names (simple names) in a specific assembly + namespace. */
export function listClassesIn(assemblyName: string, ns: string): Promise<string[]> {
    return inVm(() => {
        buildExplorerIndex();
        const asm = _asmIndex!.find((a) => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        // Accept both "(root)" and "" for the empty-namespace bucket
        const key = ns === "" ? "(root)" : ns;
        const arr = asm.namespaces.get(key) ?? [];
        return arr.slice().sort();
    });
}

/** List methods and fields of a class by simple name. */
export function listClassMembers(className: string): Promise<{ methods: string[]; fields: string[] }> {
    return inVm(() => {
        buildExplorerIndex();
        const klass = _classByName!.get(className);
        if (!klass) return { methods: [], fields: [] };
        const methods: string[] = [];
        const fields: string[] = [];
        try {
            for (const m of klass.methods) {
                try { methods.push(m.name); } catch {}
            }
        } catch {}
        try {
            for (const f of klass.fields) {
                try { fields.push(f.name); } catch {}
            }
        } catch {}
        return { methods: methods.sort(), fields: fields.sort() };
    });
}

/**
 * Direct subclasses of `baseName` (exact match on parent's simple or full name).
 * Cached after the first call for fast traversal.
 */
export function listSubclasses(baseName: string, limit = 500): Promise<string[]> {
    return inVm(() => {
        ensureInheritanceCache();
        return (inheritanceCache!.get(baseName) ?? []).slice(0, limit);
    });
}

/**
 * Deobfuscation aid: scan compiler-generated nested classes to leak the names
 * of their declaring (likely-obfuscated) class + the original method name encoded
 * in the angle-bracket syntax. Returns an array of { parent, parentNs, parentAsm,
 * leakedMethod, nestedName }.
 *
 * Patterns recognised:
 *   <Method>d__N           async state machine
 *   <Method>b__N(_M)?      lambda closure
 *   <Method>g__Local|N     local function
 *   <<Method>...>d         nested
 */
export function dumpCompilerGenLeaks(
    assemblyFilter: string = "",
    limit: number = 100000,
): Promise<Array<{
    parent: string;
    parentNs: string;
    parentAsm: string;
    leakedMethod: string;
    nestedName: string;
}>> {
    return inVm(() => {
        const out: Array<any> = [];
        const asmFilterRe = assemblyFilter ? new RegExp(assemblyFilter, "i") : null;
        const asms = Il2Cpp.domain.assemblies;
        for (let ai = 0; ai < asms.length; ai++) {
            const asm = asms[ai];
            const asmName = asm.name;
            if (asmFilterRe && !asmFilterRe.test(asmName)) continue;
            for (const k of asm.image.classes) {
                try {
                    const n = k.name;
                    if (!n || n[0] !== "<") continue;
                    const startIdx = n.lastIndexOf("<") + 1;
                    const endIdx = n.indexOf(">", startIdx);
                    if (endIdx < 0) continue;
                    const method = n.substring(startIdx, endIdx);
                    if (!method || method === "Module" || method.startsWith("PrivateImpl")) continue;
                    let parent = "(none)", parentNs = "";
                    try {
                        const decl = k.declaringClass;
                        if (decl) { parent = decl.name; parentNs = decl.namespace ?? ""; }
                    } catch {}
                    out.push({
                        parent,
                        parentNs,
                        parentAsm: asmName,
                        leakedMethod: method,
                        nestedName: n,
                    });
                    if (out.length >= limit) return out;
                } catch {}
            }
        }
        return out;
    });
}

/**
 * Walk the given assembly, find every Protobuf message class (= a class that
 * has a static field of type `Google.Protobuf.MessageParser<Self>`), invoke
 * its static `get_Descriptor()` method, and return the original .proto
 * FullName. Lets us build an obfuscated→real mapping for the entire
 * Ankama.Dofus.Protocol.Game assembly without any guesswork.
 */
export function dumpProtobufDescriptors(
    assemblyName: string = "Ankama.Dofus.Protocol.Game",
    debugClass: string = "",
): Promise<Array<{ obf: string; ns: string; fullName: string; name: string; fieldCount: number; debug?: string }>> {
    return inVm(() => {
        const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const out: Array<any> = [];
        let debugSeen = 0, debugTriggered = 0, totalScanned = 0, errored = 0;
        for (const c of asm.image.classes) {
            totalScanned++;
            try {
                // Sample first 3 classes for diagnostics
                if (totalScanned <= 3) {
                    const sFields = c.fields.filter(ff => ff.isStatic).slice(0, 3).map(ff => ff.type.name);
                    console.log(`[pb-desc] sample class #${totalScanned}: ${c.name} static-fields[0..3]=${JSON.stringify(sFields)}`);
                }
                // Optional one-off debug
                if (debugClass && c.name === debugClass) {
                    debugTriggered++;
                    const fieldTypes = c.fields.filter(ff => ff.isStatic).map(ff => `${ff.type.name} ${ff.name}`);
                    const methSigs = c.methods.filter(mm => mm.isStatic && mm.parameterCount === 0)
                        .map(mm => `${mm.returnType.name} ${mm.name}()`);
                    out.push({ obf: c.name, ns: c.namespace ?? "", fullName: "DEBUG", name: "", fieldCount: 0, debug: JSON.stringify({ fieldTypes, methSigs }) });
                    continue;
                }
                // Find static MessageParser<T> field — sentinel for Protobuf message
                let isPb = false;
                for (const f of c.fields) {
                    if (!f.isStatic) continue;
                    const tn = f.type.name;
                    if (tn && tn.indexOf("Google.Protobuf.MessageParser") >= 0) { isPb = true; break; }
                }
                if (!isPb) continue;
                debugSeen++;
                // Echo a stats marker so we can detect whether scanning happened
                if (debugSeen <= 3) {
                    console.log(`[pb-desc] PB candidate: ${c.name} (#${debugSeen})`);
                }
                // Find the static method returning MessageDescriptor with no args.
                // C# auto-property `Descriptor { get; }` → method `get_Descriptor()`,
                // but obfuscated → name is random. So match by signature.
                // Skip nested classes — they're sub-message types that may need
                // parent class initialization first.
                if (c.declaringClass) continue;
                let descMethodName = "";
                for (const m of c.methods) {
                    if (!m.isStatic) continue;
                    if (m.parameterCount !== 0) continue;
                    if (m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") {
                        descMethodName = m.name;
                        break;
                    }
                }
                if (!descMethodName) continue;
                // Initialize the class explicitly before invoking the static method.
                try { (c as any).initialize?.(); } catch {}
                const bound = (c as any).method(descMethodName, 0);
                const desc = bound.invoke() as Il2Cpp.Object;
                if (!desc || (desc as any).isNull?.()) continue;
                // Pull FullName + Name from the descriptor.
                const dCls = (desc as any).class as Il2Cpp.Class;
                let fullName = "", name = "", fieldCount = 0;
                try {
                    const getFullName = dCls.methods.find((mm: any) => mm.name === "get_FullName" && mm.parameterCount === 0);
                    if (getFullName) {
                        const r = (desc as any).method("get_FullName").invoke();
                        fullName = String(r);
                    }
                } catch {}
                try {
                    const getName = dCls.methods.find((mm: any) => mm.name === "get_Name" && mm.parameterCount === 0);
                    if (getName) {
                        const r = (desc as any).method("get_Name").invoke();
                        name = String(r);
                    }
                } catch {}
                try {
                    const fieldsM = dCls.methods.find((mm: any) => mm.name === "get_Fields" && mm.parameterCount === 0);
                    if (fieldsM) {
                        const fields = (desc as any).method("get_Fields").invoke();
                        // FieldCollection has Count property
                        try {
                            const cnt = (fields as any).method("get_Count")?.invoke?.();
                            if (typeof cnt === "number") fieldCount = cnt;
                        } catch {}
                    }
                } catch {}
                out.push({
                    obf: c.name,
                    ns: c.namespace ?? "",
                    fullName,
                    name,
                    fieldCount,
                });
            } catch (e) {
                errored++;
                if (errored <= 3) {
                    console.log(`[pb-desc] err on ${c.name}: ${String(e).slice(0, 200)}`);
                    out.push({ obf: c.name, ns: c.namespace ?? "", fullName: "__ERR__", name: String(e).slice(0, 200), fieldCount: 0 });
                }
            }
        }
        console.log(`[pb-desc] done. scanned=${totalScanned} errors=${errored} pbCandidates=${debugSeen} resultsOut=${out.length}`);
        out.push({ obf: "__STATS__", ns: "", fullName: `scanned=${totalScanned} errors=${errored} pbCandidates=${debugSeen}`, name: "", fieldCount: 0 });
        return out;
    });
}

/**
 * Install observational hooks that capture Protobuf descriptor data at
 * runtime. Call this once after attach, then trigger network activity in
 * the game (login, move on map, open a UI, etc). The hooks log:
 *
 *   - Each `FileDescriptor.FromGeneratedCode(byte[], ...)` call → captures
 *     the binary FileDescriptorProto (decodable offline with Python).
 *   - Each `MessageDescriptor..ctor` call → captures
 *     (clrTypeName → protoFullName) once the ctor has populated the fields.
 *
 * Both data streams are accumulated in module-level variables and
 * retrievable via `getCollectedProtoData`.
 */
export function installProtoNameSniffer(): Promise<{ status: string; alreadyInstalled?: boolean }> {
    return inVm(() => {
        if (snifferInstalled) {
            return { status: "already installed", alreadyInstalled: true };
        }
        const fdCls = findClass("Google.Protobuf.Reflection.FileDescriptor");
        const mdCls = findClass("Google.Protobuf.Reflection.MessageDescriptor");
        if (!fdCls) return { status: "FileDescriptor class not found — Protobuf not loaded?" };
        if (!mdCls) return { status: "MessageDescriptor class not found" };
        const fromGen = (fdCls as any).tryMethod("FromGeneratedCode");
        if (!fromGen) return { status: "FromGeneratedCode method not found" };

        // ----- Hook FromGeneratedCode (static) -----
        // Signature: static FileDescriptor FromGeneratedCode(byte[], FileDescriptor[], GeneratedClrTypeInfo)
        fromGen.implementation = function (this: any, descData: any, deps: any, info: any): any {
            try {
                if (descData && !descData.isNull?.()) {
                    const len = Number(descData.length ?? 0);
                    if (len > 0 && len < 5_000_000) {
                        const elemPtr = (descData as any).elements;
                        const buf = elemPtr.readByteArray(len) as ArrayBuffer;
                        if (buf) {
                            // Convert ArrayBuffer to base64 (Frida runtime has no btoa for ArrayBuffer)
                            const u8 = new Uint8Array(buf);
                            const b64 = arrayBufferToBase64(u8);
                            collectedFileDescriptorProtos.push({ size: len, b64, ts: Date.now() });
                            console.log(`[proto-sniff] captured FileDescriptorProto, ${len} bytes (total ${collectedFileDescriptorProtos.length})`);
                        }
                    }
                }
            } catch (e) {
                console.log(`[proto-sniff] FromGeneratedCode err: ${String(e).slice(0, 200)}`);
            }
            return (fdCls as any).method("FromGeneratedCode").invoke(descData, deps, info);
        };

        // ----- Hook MessageDescriptor..ctor (instance) -----
        // Signature: .ctor(DescriptorProto, FileDescriptor, MessageDescriptor, int, GeneratedClrTypeInfo)
        const mdCtor = (mdCls as any).tryMethod(".ctor", 5);
        if (mdCtor) {
            mdCtor.implementation = function (this: any, ...args: any[]): any {
                // Run original ctor first — fields populated after this call
                const r = (this as any).method(".ctor", 5).invoke(...args);
                try {
                    const fullName = String((this as any).method("get_FullName").invoke());
                    let clrName = "";
                    let clrFullName = "";
                    try {
                        const ct = (this as any).method("get_ClrType").invoke();
                        if (ct && !ct.isNull?.()) {
                            // System.Type — get_Name + get_FullName
                            const cName = ct.method("get_Name").invoke();
                            if (cName) clrName = String(cName);
                            const cFull = ct.method("get_FullName").invoke();
                            if (cFull) clrFullName = String(cFull);
                        }
                    } catch {}
                    if (clrName && fullName) {
                        const prev = collectedProtoNames.get(clrName);
                        if (prev !== fullName) {
                            collectedProtoNames.set(clrName, fullName);
                            if (collectedProtoNames.size <= 20 || collectedProtoNames.size % 50 === 0) {
                                console.log(`[proto-sniff] msg #${collectedProtoNames.size}: ${clrName} = ${fullName}`);
                            }
                        }
                    }
                } catch (e) {
                    console.log(`[proto-sniff] md.ctor post err: ${String(e).slice(0, 200)}`);
                }
                return r;
            };
        }

        snifferInstalled = true;
        return { status: `installed — hooked FromGeneratedCode + MessageDescriptor.ctor` };
    });
}

/** Retrieve everything the sniffer has collected so far. */
export function getCollectedProtoData(): Promise<{
    nameMap: Array<{ clr: string; proto: string }>;
    fileDescriptorBlobs: Array<{ size: number; b64: string; ts: number }>;
    runtimeMessageHits: Array<{ clr: string; count: number }>;
    snifferInstalled: boolean;
}> {
    return inVm(() => {
        const arr: Array<{ clr: string; proto: string }> = [];
        for (const [clr, proto] of collectedProtoNames) arr.push({ clr, proto });
        const hits: Array<{ clr: string; count: number }> = [];
        for (const [clr, count] of runtimeMessageHits) hits.push({ clr, count });
        hits.sort((a, b) => b.count - a.count);
        return {
            nameMap: arr,
            fileDescriptorBlobs: collectedFileDescriptorProtos.slice(),
            runtimeMessageHits: hits,
            snifferInstalled,
        };
    });
}

// Track which obfuscated message classes are actually parsed at runtime
const runtimeMessageHits = new Map<string, number>();

/**
 * Hook `CodedInputStream.ReadMessage(IMessage builder)` and
 * `ReadRawMessage(IMessage)` — called every time a message is parsed.
 * Capture the runtime type of the builder to know which obf classes
 * are actually flowing.
 */
export function installCodedInputSniffer(): Promise<{ status: string }> {
    return inVm(() => {
        const cis = findClass("Google.Protobuf.CodedInputStream");
        if (!cis) return { status: "CodedInputStream class not found" };
        let hooked = 0;
        for (const mname of ["ReadMessage", "ReadRawMessage"]) {
            const m = (cis as any).tryMethod(mname, 1);
            if (!m) continue;
            m.implementation = function (this: any, builder: any): any {
                const r = (this as any).method(mname, 1).invoke(builder);
                try {
                    if (builder && !builder.isNull?.()) {
                        const cls = builder.class;
                        const cn = cls ? cls.name : "?";
                        runtimeMessageHits.set(cn, (runtimeMessageHits.get(cn) ?? 0) + 1);
                    }
                } catch {}
                return r;
            };
            hooked++;
        }
        return { status: `hooked ${hooked} CodedInputStream methods` };
    });
}

/**
 * Install a 2nd-tier sniffer hooking the base `MessageParser.ParseFrom(byte[])`
 * method. This catches every Protobuf parse that happens, regardless of
 * whether descriptors were initialized. Captures the runtime type of the
 * returned IMessage → maps it to the obfuscated class.
 */
export function installParseFromSniffer(): Promise<{ status: string }> {
    return inVm(() => {
        const mpCls = findClass("Google.Protobuf.MessageParser");
        if (!mpCls) return { status: "MessageParser class not found" };
        // Multiple ParseFrom overloads — hook the byte[] one (most common)
        const candidates: Array<[string, number]> = [
            ["ParseFrom", 1],   // (byte[]) or (ByteString) or (Stream)
            ["ParseFrom", 3],   // (byte[], int, int)
        ];
        let hooked = 0;
        for (const [name, pc] of candidates) {
            try {
                const m = (mpCls as any).tryMethod(name, pc);
                if (!m) continue;
                m.implementation = function (this: any, ...args: any[]): any {
                    const result = (this as any).method(name, pc).invoke(...args);
                    try {
                        if (result && !result.isNull?.()) {
                            const cls = (result as any).class;
                            const cn = cls ? cls.name : "?";
                            runtimeMessageHits.set(cn, (runtimeMessageHits.get(cn) ?? 0) + 1);
                            // Try to read the descriptor on the result instance
                            try {
                                const desc = (result as any).method("get_Descriptor").invoke();
                                if (desc && !desc.isNull?.()) {
                                    const fn = String(desc.method("get_FullName").invoke());
                                    if (fn && !collectedProtoNames.has(cn)) {
                                        collectedProtoNames.set(cn, fn);
                                        console.log(`[parse-sniff] LIVE map: ${cn} = ${fn}`);
                                    }
                                }
                            } catch {}
                        }
                    } catch {}
                    return result;
                };
                hooked++;
            } catch (e) {
                console.log(`[parse-sniff] hook err ${name}/${pc}: ${String(e).slice(0, 120)}`);
            }
        }
        return { status: `hooked ${hooked} ParseFrom overloads on MessageParser` };
    });
}

// Tiny base64 encoder for Uint8Array (no btoa in Frida JS runtime).
function arrayBufferToBase64(u8: Uint8Array): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    let i = 0;
    const len = u8.length;
    while (i + 2 < len) {
        const b1 = u8[i++], b2 = u8[i++], b3 = u8[i++];
        out += chars[b1 >> 2] + chars[((b1 & 3) << 4) | (b2 >> 4)] + chars[((b2 & 15) << 2) | (b3 >> 6)] + chars[b3 & 63];
    }
    if (i < len) {
        const b1 = u8[i++];
        if (i < len) {
            const b2 = u8[i++];
            out += chars[b1 >> 2] + chars[((b1 & 3) << 4) | (b2 >> 4)] + chars[(b2 & 15) << 2] + "=";
        } else {
            out += chars[b1 >> 2] + chars[(b1 & 3) << 4] + "==";
        }
    }
    return out;
}

/**
 * Build a map "obfuscated message class → handler classes that take it as
 * a method parameter". Even when the .proto names are not yet recovered,
 * this reveals the entire dispatch topology and lets us cluster obfuscated
 * core classes by the messages they handle.
 *
 * `messageAsm` = assembly holding the message classes (default: Protocol.Game)
 * `handlerAsm` = (optional regex) restrict where to look for handlers
 */
export function buildProtoHandlerMap(
    messageAsm: string = "Ankama.Dofus.Protocol.Game",
    handlerAsmRegex: string = "",
): Promise<{
    messages: Array<{ obf: string; ns: string }>;
    handlers: Array<{ msg: string; handlerClass: string; handlerNs: string; handlerAsm: string; methodName: string; signature: string }>;
}> {
    return inVm(() => {
        const msgAsm = Il2Cpp.domain.assemblies.find(a => a.name === messageAsm);
        if (!msgAsm) throw new Error(`assembly ${messageAsm} not found`);

        // Step 1 — list all classes in the message assembly that look like
        // Protobuf messages (have a static MessageParser<Self> field).
        const msgs: Array<{ obf: string; ns: string }> = [];
        const msgNameSet = new Set<string>();
        for (const c of msgAsm.image.classes) {
            try {
                let isPb = false;
                for (const f of c.fields) {
                    if (!f.isStatic) continue;
                    if (f.type.name && f.type.name.indexOf("Google.Protobuf.MessageParser") >= 0) { isPb = true; break; }
                }
                if (!isPb) continue;
                if (c.declaringClass) continue;  // skip nested
                msgs.push({ obf: c.name, ns: c.namespace ?? "" });
                msgNameSet.add(c.name);
            } catch {}
        }

        // Step 2 — scan handlers across the requested assemblies.
        const asmRe = handlerAsmRegex ? new RegExp(handlerAsmRegex, "i") : null;
        const handlers: any[] = [];
        for (const asm of Il2Cpp.domain.assemblies) {
            if (asm.name === messageAsm) continue;  // skip the message assembly itself
            if (asmRe && !asmRe.test(asm.name)) continue;
            for (const cls of asm.image.classes) {
                try {
                    for (const m of cls.methods) {
                        try {
                            for (const p of m.parameters) {
                                const tn = p.type.name;
                                // Param type name is just the simple class name
                                // (when it lives in the empty namespace). Match
                                // against our message set.
                                if (msgNameSet.has(tn)) {
                                    const params = m.parameters.map((pp: any) => `${pp.type.name} ${pp.name}`).join(", ");
                                    handlers.push({
                                        msg: tn,
                                        handlerClass: cls.name,
                                        handlerNs: cls.namespace ?? "",
                                        handlerAsm: asm.name,
                                        methodName: m.name,
                                        signature: `${m.returnType.name} ${m.name}(${params})`,
                                    });
                                    break;  // one hit per method
                                }
                            }
                        } catch {}
                    }
                } catch {}
            }
        }
        return { messages: msgs, handlers };
    });
}

/**
 * Hunt for static byte[] fields in classes of an assembly. Useful for
 * recovering raw Protobuf FileDescriptorProto blobs that are stored as
 * descriptorData (typical in Protobuf-generated code). The hex dump can
 * be saved and decoded offline by the Python protobuf library, side-
 * stepping the runtime cctor that may not be initialized.
 */
export function dumpStaticByteArrays(
    assemblyName: string,
    minSize: number = 64,
    limit: number = 500,
): Promise<Array<{ holder: string; field: string; size: number; hexHead: string }>> {
    return inVm(() => {
        const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const out: any[] = [];
        for (const c of asm.image.classes) {
            try {
                for (const f of c.fields) {
                    if (!f.isStatic) continue;
                    if (f.type.name !== "System.Byte[]") continue;
                    let arr: any = null;
                    try { arr = (f as any).value; } catch { continue; }
                    if (!arr || (arr as any).isNull?.()) continue;
                    let size = 0;
                    try { size = Number((arr as any).length ?? 0); } catch {}
                    if (size < minSize) continue;
                    let hexHead = "";
                    try {
                        const elems = (arr as any).elements;
                        if (elems && (elems as any).readByteArray) {
                            const buf = (elems as any).readByteArray(Math.min(size, 64)) as ArrayBuffer;
                            const u8 = new Uint8Array(buf);
                            const parts: string[] = [];
                            for (let i = 0; i < u8.length; i++) {
                                parts.push((u8[i] < 16 ? "0" : "") + u8[i].toString(16));
                            }
                            hexHead = parts.join("");
                        }
                    } catch {}
                    out.push({
                        holder: c.name,
                        field: (f as any).name,
                        size,
                        hexHead,
                    });
                    if (out.length >= limit) return out;
                }
            } catch {}
        }
        return out;
    });
}

/**
 * Try to extract the entire Protobuf schema by invoking the public
 * `static FileDescriptor get_Descriptor()` getter on each *Reflection
 * class. Unlike the static-field approach, calling the getter forces the
 * cctor through normal C# semantics, which in turn registers the file
 * descriptor in the global pool and chains imports correctly.
 */
export function harvestProtoSchema(
    assemblyName: string = "Ankama.Dofus.Protocol.Game",
): Promise<Array<any>> {
    return inVm(() => {
        const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const out: any[] = [];
        let scanned = 0, holders = 0, ok = 0, err = 0;
        for (const c of asm.image.classes) {
            scanned++;
            try {
                // Detect a "FooReflection" class: has a static field of type FileDescriptor
                // AND a single static no-arg method returning FileDescriptor.
                let fdField: any = null;
                let fdGetter: any = null;
                for (const f of c.fields) {
                    if (f.isStatic && f.type.name === "Google.Protobuf.Reflection.FileDescriptor") {
                        fdField = f; break;
                    }
                }
                if (!fdField) continue;
                holders++;
                for (const m of c.methods) {
                    if (m.isStatic && m.parameterCount === 0 &&
                        m.returnType.name === "Google.Protobuf.Reflection.FileDescriptor") {
                        fdGetter = m; break;
                    }
                }
                if (!fdGetter) continue;
                // First try to explicitly run the static class constructor
                // (named ".cctor" in IL2CPP metadata).
                try {
                    const cctor = (c as any).tryMethod?.(".cctor", 0);
                    if (cctor) cctor.invoke();
                } catch (e) {
                    // cctor failure is interesting — keep going to try the getter
                }
                let fd: any = null;
                try {
                    fd = c.method(fdGetter.name, 0).invoke();
                } catch (e) {
                    out.push({ holder: c.name, status: "invoke-err", err: String(e).slice(0, 200) });
                    err++;
                    continue;
                }
                if (!fd || fd.isNull?.()) {
                    out.push({ holder: c.name, status: "null-fd" });
                    continue;
                }
                let fileName = "", pkg = "";
                try { fileName = String(fd.method("get_Name").invoke()); } catch {}
                try { pkg = String(fd.method("get_Package").invoke()); } catch {}
                const messages: any[] = [];
                try {
                    const msgs = fd.method("get_MessageTypes").invoke();
                    const cnt = Number(msgs.method("get_Count").invoke());
                    for (let i = 0; i < cnt; i++) {
                        try {
                            const md = msgs.method("get_Item").invoke(i);
                            const fullName = String(md.method("get_FullName").invoke());
                            const name = String(md.method("get_Name").invoke());
                            let clrTypeName = "";
                            try {
                                const ct = md.method("get_ClrType").invoke();
                                if (ct && !ct.isNull?.()) clrTypeName = String(ct.method("get_Name").invoke());
                            } catch {}
                            messages.push({ obf: clrTypeName, fullName, name });
                        } catch {}
                    }
                } catch {}
                out.push({ holder: c.name, status: "ok", fileName, pkg, messageCount: messages.length, messages });
                ok++;
            } catch (e) {
                err++;
                if (err <= 5) out.push({ holder: c.name, status: "outer-err", err: String(e).slice(0, 200) });
            }
        }
        out.push({ holder: "__STATS__", status: `scanned=${scanned} holders=${holders} ok=${ok} err=${err}` });
        return out;
    });
}

/**
 * Find all classes in the given assembly that hold a FileDescriptor as
 * a static field. Each such class corresponds to one .proto file in the
 * original schema. Read the FileDescriptor's name and message list →
 * full deobfuscation of the protocol.
 */
export function dumpProtobufFileDescriptors(
    assemblyName: string = "Ankama.Dofus.Protocol.Game",
): Promise<Array<{ holderClass: string; holderField: string; fileName: string; pkg: string; messageCount: number; messages: Array<{ obf: string; fullName: string }> }>> {
    return inVm(() => {
        const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const out: Array<any> = [];
        let scanned = 0, errored = 0, holders = 0;
        for (const c of asm.image.classes) {
            scanned++;
            try {
                let fdField: Il2Cpp.Field | null = null;
                for (const f of c.fields) {
                    if (!f.isStatic) continue;
                    if (f.type.name === "Google.Protobuf.Reflection.FileDescriptor") {
                        fdField = f as unknown as Il2Cpp.Field;
                        break;
                    }
                }
                if (!fdField) continue;
                holders++;
                try { c.initialize(); } catch {}
                let fd: any = null;
                let fdInfo = "";
                try {
                    fd = (fdField as any).value;
                    fdInfo = "type=" + typeof fd + " null=" + (fd?.isNull?.() ?? "?") + " handle=" + (fd?.handle ?? "?");
                } catch (e) {
                    fdInfo = "field-read-err: " + String(e).slice(0, 150);
                }
                let fileName = "", pkg = "", messages: any[] = [];
                let invokeErr = "";
                try {
                    if (fd && (typeof fd.method === "function")) {
                        const m1 = fd.method("get_Name");
                        if (m1) fileName = String(m1.invoke());
                        const m2 = fd.method("get_Package");
                        if (m2) pkg = String(m2.invoke());
                        const m3 = fd.method("get_MessageTypes");
                        if (m3) {
                            const msgs = m3.invoke();
                            const m4 = msgs?.method?.("get_Count");
                            const cnt = m4 ? Number(m4.invoke()) : 0;
                            for (let i = 0; i < cnt; i++) {
                                try {
                                    const md = msgs.method("get_Item").invoke(i);
                                    const fullName = String(md.method("get_FullName").invoke());
                                    let obf = "";
                                    try {
                                        const ct = md.method("get_ClrType").invoke();
                                        if (ct) obf = String(ct.method("get_Name").invoke());
                                    } catch {}
                                    messages.push({ obf, fullName });
                                } catch {}
                            }
                        }
                    } else {
                        invokeErr = "fd has no method() — fd=" + fdInfo;
                    }
                } catch (e) { invokeErr = String(e).slice(0, 200); }
                if (invokeErr) {
                    out.push({
                        holderClass: c.name,
                        holderField: (fdField as any).name + " __DBG__",
                        fileName: invokeErr + " | " + fdInfo,
                        pkg: "", messageCount: 0, messages: [],
                    });
                    continue;
                }
                out.push({
                    holderClass: c.name,
                    holderField: (fdField as any).name,
                    fileName,
                    pkg,
                    messageCount: messages.length,
                    messages,
                });
            } catch (e) {
                errored++;
                if (errored <= 3) {
                    out.push({ holderClass: c.name, holderField: "__ERR__", fileName: String(e).slice(0, 200), pkg: "", messageCount: 0, messages: [] });
                }
            }
        }
        out.push({ holderClass: "__STATS__", holderField: "", fileName: `scanned=${scanned} holders=${holders} errored=${errored}`, pkg: "", messageCount: 0, messages: [] });
        return out;
    });
}

/**
 * Dump every class' name + declaring-class name + method count + field count
 * in a given assembly. Useful for offline analysis (saving to disk and grepping).
 */
export function dumpAssemblyShape(
    assemblyName: string,
    limit: number = 100000,
): Promise<Array<{
    name: string;
    ns: string;
    declaring: string | null;
    methods: number;
    fields: number;
    parent: string | null;
}>> {
    return inVm(() => {
        const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const out: Array<any> = [];
        for (const c of asm.image.classes) {
            try {
                out.push({
                    name: c.name,
                    ns: c.namespace ?? "",
                    declaring: c.declaringClass ? c.declaringClass.name : null,
                    methods: c.methods.length,
                    fields: c.fields.length,
                    parent: c.parent ? c.parent.name : null,
                });
                if (out.length >= limit) break;
            } catch {}
        }
        return out;
    });
}
