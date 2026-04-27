import "frida-il2cpp-bridge";

/** Bannière formatée pour séparer les sections de sortie. */
export function banner(title: string): void {
    const bar = "=".repeat(Math.max(4, 60 - title.length));
    console.log(`\n=== ${title} ${bar}`);
}

/**
 * Transforme n'importe quelle valeur remontée par frida-il2cpp-bridge en string lisible.
 * Gère primitives, Il2Cpp.String (content), Il2Cpp.Object (class@handle), null/undefined.
 */
export function stringifyValue(v: unknown): string {
    if (v === null || v === undefined) return String(v);

    const t = typeof v;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "string") return JSON.stringify(v);

    const anyV = v as any;

    // Check for null/zero Il2Cpp handle BEFORE touching .class (reading .class on
    // a null handle does a native deref and crashes with "access violation").
    if (anyV && anyV.handle) {
        try {
            if (typeof anyV.handle.isNull === "function" && anyV.handle.isNull()) return "null";
            if (anyV.handle.toString && anyV.handle.toString() === "0x0") return "null";
        } catch { /* ignore */ }
    }

    // Il2Cpp.String : a un getter .content qui renvoie le string JS
    try {
        if (anyV && typeof anyV.content === "string") {
            return JSON.stringify(anyV.content);
        }
    } catch { /* some refs throw when accessing .content */ }

    // Il2Cpp.Object : a .class.name et .handle
    try {
        if (anyV && anyV.class && typeof anyV.class.name === "string" && anyV.handle) {
            return `${anyV.class.name}@${anyV.handle}`;
        }
    } catch (e) { return `<unreadable: ${e}>`; }

    // NativePointer et autres trucs frida
    try { return String(v); } catch { return "<unprintable>"; }
}

/** Full name "Namespace.ClassName" (ou juste ClassName si pas de namespace). */
export function fullClassName(klass: Il2Cpp.Class): string {
    const ns = klass.namespace;
    return ns ? `${ns}.${klass.name}` : klass.name;
}

/** Log une erreur sans faire planter le script. */
export function safe<T>(label: string, fn: () => T): T | undefined {
    try {
        return fn();
    } catch (e) {
        console.log(`[ERR ${label}] ${e}`);
        return undefined;
    }
}
