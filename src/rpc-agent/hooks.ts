// RPC methods for hooking and patching: hook, replaceNoop, patchStatic, forceReturn, callStatic, callStaticOverload.
import "frida-il2cpp-bridge";
import {
    findClass,
    hookLog,
    hookNoop,
    setStatic,
    forceReturn as libForceReturn,
    callStatic as libCallStatic,
    stringifyValue,
} from "../lib";
import { coerce } from "./registry";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

export function hook(className: string, methodName: string): Promise<void> {
    return inVm(() => hookLog(className, methodName));
}

export function replaceNoop(className: string, methodName: string): Promise<void> {
    return inVm(() => hookNoop(className, methodName));
}

export function patchStatic(className: string, field: string, value: any): Promise<void> {
    return inVm(() => setStatic(className, field, value));
}

export function forceReturn(className: string, method: string, value: any): Promise<void> {
    return inVm(() => libForceReturn(className, method, value));
}

export function callStatic(className: string, method: string, args: any[] = []): Promise<string> {
    return inVm(() => {
        const res = libCallStatic(className, method, ...args);
        return String(res);
    });
}

/**
 * Call a static method with explicit parameter-type overload resolution.
 * Ex: callStaticOverload("Core.Localization.LocalizedStringUtilities", "GetLocalized", ["System.Int32"], [1167735])
 */
export function callStaticOverload(className: string, methodName: string, paramTypes: string[], args: any[] = []): Promise<string> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) throw new Error(`class ${className} not found`);
        const method = klass.method(methodName).overload(...paramTypes);
        const coerced = args.map((v, i) => coerce(v, paramTypes[i]));
        const res = method.invoke(...coerced);
        return stringifyValue(res);
    });
}
