import "frida-il2cpp-bridge";
import { findClass } from "./search";
import { stringifyValue } from "./util";

function resolve(className: string, methodName: string): { klass: Il2Cpp.Class; method: Il2Cpp.Method } | null {
    const klass = findClass(className);
    if (!klass) { console.log(`[hook] class ${className} not found`); return null; }
    const method = klass.tryMethod(methodName);
    if (!method) { console.log(`[hook] method ${methodName} not found on ${className}`); return null; }
    return { klass, method };
}

/**
 * Log-hook générique : affiche args, this, return value à chaque appel.
 * L'original est quand même appelé (pas de side effect fonctionnel).
 */
export function hookLog(className: string, methodName: string): void {
    const r = resolve(className, methodName);
    if (!r) return;
    const { klass, method } = r;
    const tag = `[${className}.${methodName}]`;

    method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
        const argsStr = args.map(stringifyValue);
        const thisStr = method.isStatic ? "static" : stringifyValue(this);
        console.log(`${tag} this=${thisStr} args=(${argsStr.join(", ")})`);

        let result: any;
        try {
            result = method.isStatic
                ? klass.method(methodName).invoke(...args)
                : (this as Il2Cpp.Object).method(methodName).invoke(...args);
        } catch (e) {
            const err = String(e);
            console.log(`${tag}   THREW ${err}`);
            send({ type: "hook", cls: className, method: methodName, self: thisStr, args: argsStr, error: err, ts: Date.now() });
            throw e;
        }
        const retStr = stringifyValue(result);
        console.log(`${tag}   → ${retStr}`);
        send({ type: "hook", cls: className, method: methodName, self: thisStr, args: argsStr, retval: retStr, ts: Date.now() });
        return result;
    };

    console.log(`[hook] installed hookLog on ${className}.${methodName}`);
}

/** Callback AVANT l'appel original, puis appel original, puis retour. */
export function hookBefore(
    className: string,
    methodName: string,
    fn: (self: Il2Cpp.Object | undefined, args: any[]) => void,
): void {
    const r = resolve(className, methodName);
    if (!r) return;
    const { klass, method } = r;

    method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
        fn(method.isStatic ? undefined : (this as Il2Cpp.Object), args);
        return method.isStatic
            ? klass.method(methodName).invoke(...args)
            : (this as Il2Cpp.Object).method(methodName).invoke(...args);
    };
}

/** Appel original, puis callback APRÈS avec le résultat (peut le modifier via retour). */
export function hookAfter(
    className: string,
    methodName: string,
    fn: (self: Il2Cpp.Object | undefined, args: any[], result: any) => any | void,
): void {
    const r = resolve(className, methodName);
    if (!r) return;
    const { klass, method } = r;

    method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
        const result = method.isStatic
            ? klass.method(methodName).invoke(...args)
            : (this as Il2Cpp.Object).method(methodName).invoke(...args);
        const maybe = fn(method.isStatic ? undefined : (this as Il2Cpp.Object), args, result);
        return maybe === undefined ? result : maybe;
    };
}

/**
 * Remplace complètement l'implémentation. L'original N'EST PAS appelé, sauf si
 * ton callback le fait lui-même via klass.method(name).invoke(args) ou self.method(name).invoke(args).
 */
export function hookReplace(
    className: string,
    methodName: string,
    fn: (self: Il2Cpp.Object | undefined, args: any[]) => any,
): void {
    const r = resolve(className, methodName);
    if (!r) return;
    const { method } = r;

    method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
        return fn(method.isStatic ? undefined : (this as Il2Cpp.Object), args);
    };
}

/** Raccourci : transforme la méthode en no-op (ex: god mode sur TakeDamage). */
export function hookNoop(className: string, methodName: string): void {
    hookReplace(className, methodName, () => undefined);
    console.log(`[hook] ${className}.${methodName} is now no-op`);
}
