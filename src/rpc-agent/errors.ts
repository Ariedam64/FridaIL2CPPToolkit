// Error types and helpers shared across rpc-agent modules.
//
// Convention:
//   - Pure lookup helpers (findClass, getSingleton, …) return `null` on miss.
//     The caller decides whether to throw, retry, or default.
//   - RPC entry points that "do a thing" (capture, callInstance, …) throw a
//     typed error on failure. Frida marshals `Error.message` back to the host
//     untouched so the host gets a useful description.
//   - RPC entry points that legitimately have multiple non-error outcomes
//     (dumpDataRoot, dumpGbeRouter, …) return a shaped envelope with
//     `found: boolean` and an optional `error?: string` — they DO NOT throw
//     for missing-but-expected cases.
//
// This module gives every "throwy" path a single typed surface, so future
// host-side code can `instanceof NotFoundError` cleanly. Until that wiring
// exists the marshalled `Error.message` already carries enough info.

export class NotFoundError extends Error {
    /** Discriminator for `instanceof` fans and host-side payload sniffers. */
    readonly kind: "not-found" = "not-found";
    /** What we tried to find — class name, method, instance key, … */
    readonly target: string;

    constructor(target: string, what: string = "target") {
        super(`${what} ${target} not found`);
        this.name = "NotFoundError";
        this.target = target;
    }
}

/** `class ${name} not found`. */
export function notFoundClass(name: string): NotFoundError {
    return new NotFoundError(name, "class");
}

/** `method ${name} not found on ${className}`. */
export function notFoundMethod(className: string, methodName: string): NotFoundError {
    const e = new NotFoundError(`${className}.${methodName}`, "method");
    return e;
}

/** `no live instance of ${className}`. */
export function noLiveInstance(className: string): Error {
    return new Error(`no live instance of ${className}`);
}

export interface NotFoundLike {
    kind: "not-found";
    target: string;
    message: string;
}

/** Type guard for the error class above and host-side serialisations. */
export function isNotFound(err: unknown): err is NotFoundLike {
    if (!err || typeof err !== "object") return false;
    return (err as { kind?: string }).kind === "not-found";
}
