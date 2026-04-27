import "frida-il2cpp-bridge";
import { findClass } from "./search";
import { stringifyValue } from "./util";

/** Appelle une méthode statique et renvoie le résultat (brut, non-stringifié). */
export function callStatic(className: string, methodName: string, ...args: any[]): any {
    const klass = findClass(className);
    if (!klass) throw new Error(`[invoke] class ${className} not found`);
    const method = klass.tryMethod(methodName);
    if (!method) throw new Error(`[invoke] method ${methodName} not found on ${className}`);
    if (!method.isStatic) throw new Error(`[invoke] ${methodName} is not static — use call() with an instance`);
    const res = method.invoke(...args);
    console.log(`[invoke] ${className}.${methodName}(${args.map(stringifyValue).join(", ")}) → ${stringifyValue(res)}`);
    return res;
}

/** Appelle une méthode d'instance. */
export function call(instance: Il2Cpp.Object, methodName: string, ...args: any[]): any {
    try {
        const res = instance.method(methodName).invoke(...args);
        console.log(`[invoke] ${instance.class.name}.${methodName}(${args.map(stringifyValue).join(", ")}) → ${stringifyValue(res)}`);
        return res;
    } catch (e) {
        throw new Error(`[invoke] call ${instance.class.name}.${methodName} failed: ${e}`);
    }
}

/** Crée une nouvelle instance d'une classe (appelle le constructeur par défaut si non précisé). */
export function newInstance(className: string, ...ctorArgs: any[]): Il2Cpp.Object {
    const klass = findClass(className);
    if (!klass) throw new Error(`[invoke] class ${className} not found`);
    const inst = klass.new();
    // Tente un .ctor avec les args passés (s'il y en a)
    if (ctorArgs.length > 0) {
        try { inst.method(".ctor").invoke(...ctorArgs); }
        catch (e) { console.log(`[invoke] .ctor failed: ${e}`); }
    }
    console.log(`[invoke] new ${className}() → ${klass.name}@${inst.handle}`);
    return inst;
}
