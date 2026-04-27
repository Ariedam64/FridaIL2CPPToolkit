// Variant of hookLog that includes a backtrace in the fire payload.
import "frida-il2cpp-bridge";
import { findClass, stringifyValue } from "../lib";

function frameToString(addr: NativePointer): string {
    try {
        const sym = DebugSymbol.fromAddress(addr);
        if (sym && sym.name) return `${sym.moduleName || "?"}!${sym.name}+0x${(addr.sub(sym.address as any)).toString(16)}`;
    } catch { /* fallthrough */ }
    return addr.toString();
}

export function hookLogWithStack(className: string, methodName: string, maxFrames = 12): Promise<void> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            try {
                const klass = findClass(className);
                if (!klass) { reject(new Error(`class ${className} not found`)); return; }
                const method = klass.tryMethod(methodName);
                if (!method) { reject(new Error(`method ${methodName} not found on ${className}`)); return; }
                method.implementation = function (this: any, ...args: any[]): any {
                    let ret: any, err: string | null = null;
                    try {
                        const self = this as Il2Cpp.Object;
                        ret = self.method(methodName).invoke(...args);
                    } catch (e) { err = String(e); }
                    const stack: string[] = [];
                    try {
                        const bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                        for (let i = 0; i < Math.min(bt.length, maxFrames); i++) {
                            stack.push(frameToString(bt[i]));
                        }
                    } catch { /* backtrace failed, leave stack empty */ }
                    send({
                        type: "hook",
                        cls: className,
                        method: methodName,
                        self: String((this as any)?.handle ?? "static"),
                        args: args.map((a: any) => stringifyValue(a)),
                        retval: stringifyValue(ret),
                        error: err,
                        stack,
                    });
                    if (err) throw new Error(err);
                    return ret;
                };
                console.log(`[hook+stack] installed on ${className}.${methodName}`);
                resolve();
            } catch (e) { reject(e); }
        });
    });
}
