// RPC methods for the assembly/inheritance tree explorer: listAssembliesInfo, listNamespaces, listClassesIn, listSubclasses.
import "frida-il2cpp-bridge";
import { fullClassName } from "../lib";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
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

/** List assemblies + class count. Returns array of { name, classes }. */
export function listAssembliesInfo(): Promise<Array<{ name: string; classes: number }>> {
    return inVm(() => {
        const out: Array<{ name: string; classes: number }> = [];
        for (const asm of Il2Cpp.domain.assemblies) {
            let n = 0;
            try { n = asm.image.classes.length; } catch {}
            out.push({ name: asm.name, classes: n });
        }
        out.sort((a, b) => b.classes - a.classes);
        return out;
    });
}

/** List distinct namespaces in an assembly (+ class count per namespace). */
export function listNamespaces(assemblyName: string): Promise<Array<{ ns: string; classes: number }>> {
    return inVm(() => {
        const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const counts = new Map<string, number>();
        for (const c of asm.image.classes) {
            const ns = c.namespace ?? "(root)";
            counts.set(ns, (counts.get(ns) ?? 0) + 1);
        }
        const out = [...counts.entries()].map(([ns, classes]) => ({ ns, classes }));
        out.sort((a, b) => a.ns.localeCompare(b.ns));
        return out;
    });
}

/** List class names (simple names) in a specific assembly + namespace. */
export function listClassesIn(assemblyName: string, ns: string): Promise<string[]> {
    return inVm(() => {
        const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
        if (!asm) throw new Error(`assembly ${assemblyName} not found`);
        const wanted = ns === "(root)" ? "" : ns;
        const out: string[] = [];
        for (const c of asm.image.classes) {
            if ((c.namespace ?? "") === wanted) out.push(c.name);
        }
        return out.sort();
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
