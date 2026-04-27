// RPC methods for discovery: find-classes, find-by-field, find-by-method, dumpClass, listMethods, probeNoArgGetters, findStringInMemory.
import "frida-il2cpp-bridge";
import {
    fullAnalyze,
    findAllClasses,
    findByField as libFindByField,
    findByMethod as libFindByMethod,
    findClass,
    fullClassName,
    dumpClass as libDumpClass,
    dumpStatics as libDumpStatics,
    findStringInMemory as libFindStringInMemory,
    stringifyValue,
} from "../lib";
import { getCaptured, getCapturedRaw } from "./registry";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

export function analyze(): Promise<void> {
    return inVm(() => fullAnalyze());
}

export function find(pattern: string, limit = 50): Promise<string[]> {
    return inVm(() => findAllClasses(pattern, limit).map(fullClassName));
}

export function findByField(typePattern: string | null, namePattern: string | null, limit = 50): Promise<string[]> {
    return inVm(() =>
        libFindByField(typePattern || null, namePattern || null, limit)
            .map(m => `${fullClassName(m.class)}  ::  ${m.type} ${m.field}`)
    );
}

export function findByMethod(opts: { returnType?: string; paramType?: string; name?: string }, limit = 50): Promise<string[]> {
    return inVm(() =>
        libFindByMethod(opts || {}, limit)
            .map(m => `${fullClassName(m.class)}  ::  ${m.signature}`)
    );
}

export function findStringInMemory(text: string, maxHits = 10): Promise<string[]> {
    return inVm(() => libFindStringInMemory(text, maxHits));
}

export function dumpClass(name: string): Promise<void> {
    return inVm(() => {
        const k = findClass(name);
        if (k) libDumpClass(k);
        else console.log(`[rpc] class ${name} not found`);
    });
}

export function dumpStatics(name: string): Promise<void> {
    return inVm(() => {
        const k = findClass(name);
        if (k) libDumpStatics(k);
        else console.log(`[rpc] class ${name} not found`);
    });
}

export function listMethods(className: string, nameFilter: string = ""): Promise<string[]> {
    return inVm(() => {
        let klass: Il2Cpp.Class | null = null;
        const cap = getCapturedRaw(className);
        if (cap) klass = cap.class;
        else klass = findClass(className);
        if (!klass) throw new Error(`class ${className} not found`);
        const re = nameFilter ? new RegExp(nameFilter, "i") : null;
        const out: string[] = [`class: ${fullClassName(klass)}  methods:`];
        for (const m of klass.methods) {
            if (re && !re.test(m.name)) continue;
            const kind = m.isStatic ? "static " : "       ";
            const params = m.parameters.map(p => `${p.type.name} ${p.name}`).join(", ");
            out.push(`  ${kind}${m.returnType.name.padEnd(20)} ${m.name}(${params})`);
        }
        return out;
    });
}

export function dumpClassAsString(name: string): Promise<string> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            const k = findClass(name);
            if (!k) { reject(new Error(`class ${name} not found`)); return; }
            const lines: string[] = [`# ${name}`, ""];
            lines.push(`**Fields (${k.fields.length})**`, "");
            for (const f of k.fields) {
                lines.push(`- ${f.isStatic ? "static " : ""}${f.type.name} ${f.name}`);
            }
            lines.push("", `**Methods (${k.methods.length})**`, "");
            for (const m of k.methods) {
                const kind = m.isStatic ? "static " : "";
                const params = m.parameters.map(p => `${p.type.name} ${p.name}`).join(", ");
                lines.push(`- ${kind}${m.returnType.name} ${m.name}(${params})`);
            }
            resolve(lines.join("\n"));
        });
    });
}

export function probeNoArgGetters(className: string, returnType: string = "System.String", includeEmpty = false, includeErrors = false): Promise<string[]> {
    return inVm(() => {
        const inst = getCaptured(className);
        const out: string[] = [];
        let tested = 0, ok = 0, failed = 0;
        out.push(`class: ${inst.class.name}  probing for no-arg methods returning ${returnType}`);
        for (const m of inst.class.methods) {
            if (m.isStatic) continue;
            if (m.parameters.length !== 0) continue;
            if (m.returnType.name !== returnType) continue;
            tested++;
            try {
                const bound = inst.method(m.name);
                const r = bound.invoke();
                const s = stringifyValue(r);
                const isEmpty = s === "null" || s === "\"\"" || s === "undefined" || s === "0";
                if (includeEmpty || !isEmpty) {
                    out.push(`  ${m.name}() = ${s}`);
                    if (!isEmpty) ok++;
                }
            } catch (e) {
                failed++;
                if (includeErrors) out.push(`  ${m.name}() = <err: ${String(e).slice(0, 80)}>`);
            }
        }
        out.push(`(tested ${tested}, non-empty ${ok}, failed ${failed})`);
        return out;
    });
}
