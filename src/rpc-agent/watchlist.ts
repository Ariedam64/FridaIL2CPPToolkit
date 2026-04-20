// Watchlist — pin any field of a captured instance (or a static field)
// and tick its value every POLL_MS milliseconds via send({type:'watchlist-tick', values}).
import "frida-il2cpp-bridge";
import { stringifyValue, findClass } from "../lib";
import { getCapturedRaw } from "./registry";

const POLL_MS = 500;
type Pin = {
    id: string;
    kind: "instance" | "static";
    className: string;
    fieldName: string;
    label?: string;  // optional friendly label for UI
};

const pins = new Map<string, Pin>();
let timer: ReturnType<typeof setInterval> | null = null;
let nextId = 1;

function tick(): void {
    if (pins.size === 0) return;
    // Il2Cpp.perform is async — send must run inside the callback, after the
    // values map is populated, not after perform() returns.
    Il2Cpp.perform(() => {
        const values: Record<string, string> = {};
        for (const pin of pins.values()) {
            try {
                if (pin.kind === "instance") {
                    const inst = getCapturedRaw(pin.className);
                    if (!inst) { values[pin.id] = "<not captured>"; continue; }
                    values[pin.id] = stringifyValue(inst.field(pin.fieldName).value);
                } else {
                    const k = findClass(pin.className);
                    if (!k) { values[pin.id] = "<class not found>"; continue; }
                    values[pin.id] = stringifyValue(k.field(pin.fieldName).value);
                }
            } catch (e) {
                values[pin.id] = `<err: ${String(e).slice(0, 60)}>`;
            }
        }
        send({ type: "watchlist-tick", values });
    });
}

function ensureTimer(): void {
    if (timer) return;
    timer = setInterval(tick, POLL_MS);
}

function stopTimer(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}

export function pinField(
    kind: "instance" | "static",
    className: string,
    fieldName: string,
    label?: string,
): Promise<{ id: string; label: string }> {
    return new Promise((resolve) => {
        const id = `p${nextId++}`;
        const finalLabel = label ?? `${className}.${fieldName}`;
        pins.set(id, { id, kind, className, fieldName, label: finalLabel });
        ensureTimer();
        console.log(`[watchlist] pinned ${finalLabel} as ${id}`);
        resolve({ id, label: finalLabel });
    });
}

export function unpin(id: string): Promise<boolean> {
    return new Promise((resolve) => {
        const had = pins.delete(id);
        if (pins.size === 0) stopTimer();
        if (had) console.log(`[watchlist] unpinned ${id}`);
        resolve(had);
    });
}

export function listPins(): Promise<Array<Pin>> {
    return Promise.resolve([...pins.values()]);
}

export function clearPins(): Promise<number> {
    return new Promise((resolve) => {
        const n = pins.size;
        pins.clear();
        stopTimer();
        resolve(n);
    });
}
