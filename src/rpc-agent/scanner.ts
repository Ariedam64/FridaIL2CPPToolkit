// src/rpc-agent/scanner.ts
// IL2CPP-aware value scanner. Walks alive managed instances and compares field values.
// Two sources: (1) captured instances (catches MonoBehaviours that gc.choose misses),
// (2) Il2Cpp.gc.choose over classes of the chosen assembly.
import "frida-il2cpp-bridge";
import { stringifyValue } from "../lib";
import { forEachCaptured } from "./registry";

export type ScanType = "int" | "float" | "string" | "bool";

interface Candidate {
    id: string;
    className: string;
    fieldName: string;
    handle: string;
    currentValue: string;
}

// Candidates from the last scan, keyed by id. Used by rescanByValue to narrow.
const lastCandidates = new Map<string, { obj: Il2Cpp.Object; fieldName: string }>();
let nextId = 1;

function matchType(typeName: string, scanType: ScanType): boolean {
    if (scanType === "int")    return /Int32$|UInt32$|Int64$|UInt64$|Int16$|UInt16$|Byte$|SByte$/.test(typeName);
    if (scanType === "float")  return /Single$|Double$/.test(typeName);
    if (scanType === "string") return typeName === "System.String";
    if (scanType === "bool")   return typeName === "System.Boolean";
    return false;
}

function valueMatches(fieldValue: unknown, target: string, scanType: ScanType): boolean {
    try {
        if (scanType === "string") {
            const s = fieldValue == null ? "" : String(fieldValue);
            return s.replace(/^"|"$/g, "") === target;
        }
        if (scanType === "bool") {
            const b = String(fieldValue).toLowerCase();
            return (target === "true"  && (b === "true" || b === "1")) ||
                   (target === "false" && (b === "false" || b === "0"));
        }
        const n = typeof fieldValue === "number" ? fieldValue : parseFloat(String(fieldValue));
        const t = parseFloat(target);
        if (scanType === "float") return Math.abs(n - t) < 1e-4;
        return Math.trunc(n) === Math.trunc(t);
    } catch { return false; }
}

export function scanByValue(target: string, scanType: ScanType, assemblyName: string, limit: number): Promise<Candidate[]> {
    const asm = assemblyName || "Assembly-CSharp";
    const maxResults = limit || 200;
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            try {
                lastCandidates.clear();
                nextId = 1;
                const out: Candidate[] = [];
                const seen = new Set<string>(); // dedupe by handle+fieldName

                function checkInstance(inst: Il2Cpp.Object): boolean {
                    const matchingFields = inst.class.fields.filter(f => !f.isStatic && matchType(f.type.name, scanType));
                    for (const f of matchingFields) {
                        try {
                            const v = inst.field(f.name).value;
                            if (!valueMatches(v, target, scanType)) continue;
                            const dedupKey = `${inst.handle}:${f.name}`;
                            if (seen.has(dedupKey)) continue;
                            seen.add(dedupKey);
                            const id = `c${nextId++}`;
                            lastCandidates.set(id, { obj: inst, fieldName: f.name });
                            out.push({ id, className: inst.class.name, fieldName: f.name, handle: String(inst.handle), currentValue: stringifyValue(v) });
                            if (out.length >= maxResults) return true;
                        } catch { /* field read failed */ }
                    }
                    return false;
                }

                // Pass 1: captured instances (catches MonoBehaviours).
                let done = false;
                forEachCaptured((inst) => { if (!done && checkInstance(inst)) done = true; });
                if (done) { resolve(out); return; }

                // Pass 2: managed heap sweep in the chosen assembly.
                // HARD LIMIT: large assemblies (Dofus "Core" has 8919 classes) would freeze
                // the target process if we gc.choose each one. Cap at MAX_CLASSES_SCAN and
                // abort after SCAN_BUDGET_MS total time.
                const MAX_CLASSES_SCAN = 800;
                const SCAN_BUDGET_MS = 12_000;
                const startMs = Date.now();
                const assembly = Il2Cpp.domain.assemblies.find(a => a.name === asm);
                if (!assembly) { reject(new Error(`assembly ${asm} not found`)); return; }
                const classesCount = assembly.image.classes.length;
                if (classesCount > MAX_CLASSES_SCAN) {
                    console.log(`[scanner] assembly ${asm} has ${classesCount} classes — skipping heap sweep (too big). Returning only captured-instance matches (${out.length}). Capture target classes first and re-scan.`);
                    resolve(out);
                    return;
                }
                let scanned = 0;
                for (const klass of assembly.image.classes) {
                    if (Date.now() - startMs > SCAN_BUDGET_MS) {
                        console.log(`[scanner] budget ${SCAN_BUDGET_MS}ms exceeded at ${scanned}/${classesCount} classes; returning partial results.`);
                        resolve(out);
                        return;
                    }
                    scanned++;
                    if (klass.isEnum || klass.isInterface) continue;
                    const matchingFields = klass.fields.filter(f => !f.isStatic && matchType(f.type.name, scanType));
                    if (matchingFields.length === 0) continue;
                    let instances: Il2Cpp.Object[];
                    try { instances = Il2Cpp.gc.choose(klass); } catch { continue; }
                    for (const inst of instances) {
                        if (checkInstance(inst)) { resolve(out); return; }
                    }
                }
                console.log(`[scanner] scan complete: ${out.length} candidates (captured + ${asm}, ${scanned} classes)`);
                resolve(out);
            } catch (e) { reject(e); }
        });
    });
}

export function rescanByValue(target: string, scanType: ScanType): Promise<Candidate[]> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            try {
                const kept: Candidate[] = [];
                for (const [id, entry] of lastCandidates.entries()) {
                    try {
                        const v = entry.obj.field(entry.fieldName).value;
                        if (valueMatches(v, target, scanType)) {
                            kept.push({ id, className: entry.obj.class.name, fieldName: entry.fieldName, handle: String(entry.obj.handle), currentValue: stringifyValue(v) });
                        } else {
                            lastCandidates.delete(id);
                        }
                    } catch {
                        lastCandidates.delete(id);
                    }
                }
                console.log(`[scanner] rescan: ${kept.length} remain`);
                resolve(kept);
            } catch (e) { reject(e); }
        });
    });
}

export function clearScan(): Promise<number> {
    return new Promise((resolve) => {
        const n = lastCandidates.size;
        lastCandidates.clear();
        resolve(n);
    });
}

// -----------------------------------------------------------------------------
// Static-value scanner: finds a concrete value (e.g. a mapId) held either
// directly in a static field, or one hop away via a static singleton reference
// (`ClassX.Instance.fieldY == target` — the common Dofus idiom).
//
// Why this matters: the instance-heap sweep above is bounded (skips huge
// assemblies like Dofus "Core"). But mapIds / currentActorIds / session
// tokens are usually reachable from a static root. Reading statics is cheap:
// no gc.choose, no initialize, just iterate classes and read fields.
// -----------------------------------------------------------------------------

interface StaticCandidate {
    id: string;
    path: string;           // "Class.field" or "Class.staticField → InnerCls.instField"
    assembly: string;
    typeName: string;
    currentValue: string;
}

// Classes/namespaces whose statics are known to crash the target when read
// cold (native-backed pointers, lazy platform init, generic instantiations, …).
const CLASS_NAME_SKIP = /^(<|__StaticArrayInit|PrivateImplementationDetails|RuntimeType|IntPtr|RuntimeMethodHandle|RuntimeFieldHandle|SafeHandle)/;

function isScannableClass(klass: Il2Cpp.Class): boolean {
    if (klass.isEnum || klass.isInterface) return false;
    const n = klass.name;
    // Generic definitions (Foo`1 or Foo<T>) crash on static access.
    if (n.includes("`") || n.includes("<")) return false;
    if (CLASS_NAME_SKIP.test(n)) return false;
    return true;
}

/**
 * Extract the short class name ("Foo") from a type name that may be prefixed
 * with a namespace ("Some.Ns.Foo"), an array suffix ("Foo[]"), or a generic
 * instantiation ("List`1<Foo>"). Returns null if we can't confidently reduce.
 */
function shortTypeName(tname: string): string | null {
    if (!tname) return null;
    let s = tname;
    // Strip array suffixes and pointer suffixes.
    s = s.replace(/\[\]|\*|&/g, "");
    // Strip generic args — "Foo`1<Bar>" or "List<Bar>".
    const lt = s.indexOf("<"), bt = s.indexOf("`");
    if (lt >= 0) s = s.slice(0, lt);
    if (bt >= 0) s = s.slice(0, bt);
    // Take last segment.
    const last = s.split(".").pop();
    return last && last.length > 0 ? last : null;
}

export function scanStaticValue(
    target: string,
    scanType: ScanType,
    dive: boolean = false,
    assemblyName: string = "Assembly-CSharp",
    limit: number = 200,
): Promise<StaticCandidate[]> {
    const maxResults = limit || 200;
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            try {
                const assembly = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
                if (!assembly) { reject(new Error(`assembly ${assemblyName} not found`)); return; }

                const out: StaticCandidate[] = [];
                let sid = 1;
                const startMs = Date.now();
                const BUDGET_MS = 15_000;
                let scannedClasses = 0, skippedClasses = 0, readErrors = 0, divesAttempted = 0;

                let classes: Il2Cpp.Class[] = [];
                try { classes = assembly.image.classes as unknown as Il2Cpp.Class[]; } catch (e) { reject(e); return; }

                // Build an in-assembly class-name set. The dive phase only follows object
                // references whose declared type is a class from this same assembly — that
                // filters out framework/native types whose static pointers crash on cold read.
                const inAssembly = new Set<string>();
                for (const k of classes) {
                    try { if (isScannableClass(k)) inAssembly.add(k.name); } catch {}
                }

                for (const klass of classes) {
                    if (Date.now() - startMs > BUDGET_MS) {
                        console.log(`[scanner] static budget ${BUDGET_MS}ms hit at ${scannedClasses}/${classes.length} classes; partial.`);
                        break;
                    }
                    if (!isScannableClass(klass)) { skippedClasses++; continue; }
                    scannedClasses++;

                    let fields: Il2Cpp.Field[] = [];
                    try { fields = klass.fields; } catch { skippedClasses++; continue; }

                    for (const f of fields) {
                        if (!f.isStatic) continue;
                        const tname = f.type.name;

                        // Phase 1: scalar static matching scanType.
                        if (matchType(tname, scanType)) {
                            try {
                                const v = f.value;
                                if (valueMatches(v, target, scanType)) {
                                    out.push({
                                        id: `s${sid++}`,
                                        path: `${klass.name}.${f.name}`,
                                        assembly: assembly.name,
                                        typeName: tname,
                                        currentValue: stringifyValue(v),
                                    });
                                    if (out.length >= maxResults) { resolve(out); return; }
                                }
                            } catch { readErrors++; }
                            continue;
                        }

                        // Phase 2 (dive, opt-in): static reference to an in-assembly class → scan its instance scalars.
                        // Skipping anything non-in-assembly is the safety net: UnityEngine / System /
                        // mscorlib statics have a long history of crashing on cold `.value` reads.
                        if (!dive) continue;
                        const short = shortTypeName(tname);
                        if (!short || !inAssembly.has(short)) continue;

                        divesAttempted++;
                        let obj: any;
                        try { obj = f.value; } catch { readErrors++; continue; }
                        if (!obj) continue;
                        try {
                            if (!obj.class) continue;
                            if (obj.handle?.isNull?.() || String(obj.handle) === "0x0") continue;
                            // Only descend if the runtime class is itself an in-assembly scannable class.
                            if (!inAssembly.has(obj.class.name)) continue;
                        } catch { continue; }

                        let innerFields: Il2Cpp.Field[] = [];
                        try { innerFields = obj.class.fields; } catch { continue; }
                        // Safety: some aggregate classes have hundreds of fields — iterating them all
                        // is both slow and more likely to hit a landmine. Cap.
                        if (innerFields.length > 150) continue;

                        for (const inner of innerFields) {
                            if (inner.isStatic) continue;
                            if (!matchType(inner.type.name, scanType)) continue;
                            try {
                                const iv = obj.field(inner.name).value;
                                if (!valueMatches(iv, target, scanType)) continue;
                                out.push({
                                    id: `s${sid++}`,
                                    path: `${klass.name}.${f.name} → ${obj.class.name}.${inner.name}`,
                                    assembly: assembly.name,
                                    typeName: inner.type.name,
                                    currentValue: stringifyValue(iv),
                                });
                                if (out.length >= maxResults) { resolve(out); return; }
                            } catch { readErrors++; }
                        }
                    }
                }

                console.log(`[scanner] static scan on ${assembly.name}: ${out.length} hits, ${scannedClasses} scanned, ${skippedClasses} skipped, ${divesAttempted} dives, ${readErrors} read-errs in ${Date.now() - startMs}ms (dive=${dive})`);
                resolve(out);
            } catch (e) { reject(e); }
        });
    });
}

/**
 * List assembly names present in the current Il2Cpp domain. Useful when the
 * user doesn't know what to type in the scanner's assembly field (e.g. Dofus
 * uses `Core` rather than the default `Assembly-CSharp`).
 */
export function listAssemblies(): Promise<string[]> {
    return new Promise((resolve) => {
        Il2Cpp.perform(() => {
            const out: string[] = [];
            for (const a of Il2Cpp.domain.assemblies) {
                try { out.push(a.name); } catch {}
            }
            out.sort();
            resolve(out);
        });
    });
}
