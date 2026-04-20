// src/rpc-agent/scanner.ts
// IL2CPP-aware value scanner. Walks alive managed instances and compares field values.
import "frida-il2cpp-bridge";
import { stringifyValue } from "../lib";

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
                const assembly = Il2Cpp.domain.assemblies.find(a => a.name === asm);
                if (!assembly) { reject(new Error(`assembly ${asm} not found`)); return; }
                const out: Candidate[] = [];
                for (const klass of assembly.image.classes) {
                    if (klass.isEnum || klass.isInterface) continue;
                    // Skip classes without a matching field type (cheap prefilter).
                    const matchingFields = klass.fields.filter(f => !f.isStatic && matchType(f.type.name, scanType));
                    if (matchingFields.length === 0) continue;
                    let instances: Il2Cpp.Object[];
                    try { instances = Il2Cpp.gc.choose(klass); } catch { continue; }
                    for (const inst of instances) {
                        for (const f of matchingFields) {
                            try {
                                const v = inst.field(f.name).value;
                                if (!valueMatches(v, target, scanType)) continue;
                                const id = `c${nextId++}`;
                                lastCandidates.set(id, { obj: inst, fieldName: f.name });
                                out.push({ id, className: klass.name, fieldName: f.name, handle: String(inst.handle), currentValue: stringifyValue(v) });
                                if (out.length >= maxResults) { resolve(out); return; }
                            } catch { /* field read failed */ }
                        }
                    }
                }
                console.log(`[scanner] scan complete: ${out.length} candidates in ${asm}`);
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
