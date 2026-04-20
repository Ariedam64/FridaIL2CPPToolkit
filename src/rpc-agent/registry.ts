// Captured-instance registry + JS→IL2CPP coercion helper.
// Note: frida-compile does not support `export const` (block-scoped) at module
// level in sub-modules — only `export function` is safe. The Map is therefore
// held in a module-internal var and exposed entirely through functions.
import "frida-il2cpp-bridge";

// Module-internal registry (not exported as a binding).
// All callers must go through setCaptured / getCaptured / listCaptured.
function makeRegistry(): Map<string, Il2Cpp.Object> {
    return new Map<string, Il2Cpp.Object>();
}
const _reg = makeRegistry();

export function setCaptured(className: string, inst: Il2Cpp.Object): void {
    _reg.set(className, inst);
}

export function getCaptured(className: string): Il2Cpp.Object {
    const inst = _reg.get(className);
    if (!inst) throw new Error(`no captured instance for ${className}. Call capture(${className}, <tickMethod>) first.`);
    return inst;
}

export function hasCaptured(className: string): boolean {
    return _reg.has(className);
}

export function getCapturedRaw(className: string): Il2Cpp.Object | undefined {
    return _reg.get(className);
}

export function forEachCaptured(cb: (inst: Il2Cpp.Object, name: string) => void): void {
    _reg.forEach(cb);
}

/** Coerce a JSON-sent value to the IL2CPP type expected by `typeName`. */
export function coerce(value: any, typeName: string): any {
    if (value === undefined || value === null) return value;
    if (typeName === "System.String" && typeof value === "string") return Il2Cpp.string(value);

    // List<T> from a JS array — tolerate several type-name shapes
    //   System.Collections.Generic.List`1<System.UInt32>
    //   System.Collections.Generic.List<System.UInt32>
    //   List`1<System.UInt32>
    const listMatch = typeName.match(/List`?1?<([^>]+)>$/);
    if (listMatch && Array.isArray(value)) {
        const elemType = listMatch[1];
        const listClass = Il2Cpp.corlib.class(`System.Collections.Generic.List\`1<${elemType}>`);
        const list = listClass.new();
        list.method(".ctor").overload().invoke();
        for (const item of value) list.method("Add").invoke(coerce(item, elemType));
        return list;
    }
    return value;
}
