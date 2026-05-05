// Lazy-build an IL2CPP method address table and resolve raw stack frames
// to "Cls.method+0xoff" strings. Factored out of sender.ts so the Hooks
// plugin (and any future module) can capture stack traces without
// duplicating the ~349k-entry method-address table.

import "frida-il2cpp-bridge";

interface MethodRef { addrHex: string; cls: string; name: string; }

let _methodTable: MethodRef[] | null = null;

function hexPad(p: NativePointer): string {
    const s = p.toString();
    return (s.startsWith("0x") ? s.slice(2) : s).padStart(16, "0");
}

function ensureTable(): MethodRef[] {
    if (_methodTable) return _methodTable;
    const list: MethodRef[] = [];
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                try {
                    for (const m of k.methods) {
                        try {
                            const va = m.virtualAddress;
                            if (!va || va.isNull()) continue;
                            list.push({ addrHex: hexPad(va), cls: k.name, name: m.name });
                        } catch {}
                    }
                } catch {}
            }
        } catch {}
    }
    list.sort((a, b) => a.addrHex < b.addrHex ? -1 : a.addrHex > b.addrHex ? 1 : 0);
    _methodTable = list;
    console.log(`[stack-trace] method table built: ${list.length} entries`);
    return list;
}

/** Build (or return cached) method-address table size. Useful for warm-up. */
export function buildMethodTable(): number {
    return ensureTable().length;
}

/** Drop the cached table — next call rebuilds. */
export function invalidateMethodTable(): void {
    _methodTable = null;
}

/**
 * Return a read-only view of the internal method table.
 * Useful for callers (e.g. resolveAddress) that need raw binary search
 * with diagnostic fields (tableSize / tableFirst / tableLast).
 */
export function getMethodTable(): ReadonlyArray<{ addrHex: string; cls: string; name: string }> {
    return ensureTable();
}

/** Resolve a single frame pointer to "Cls.method+0xoff" or "0xADDR" if unknown
 *  or the nearest match is implausibly far (>= 256KB offset). */
export function resolveFrame(frame: NativePointer): string {
    const table = ensureTable();
    const addr = hexPad(frame);
    let lo = 0, hi = table.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const cmp = table[mid].addrHex;
        if (cmp <= addr) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (found < 0) return `0x${addr}`;
    const ref = table[found];
    const off = BigInt("0x" + addr) - BigInt("0x" + ref.addrHex);
    if (off < 0n || off > 0x40000n) return `0x${addr}`;
    return `${ref.cls}.${ref.name}+0x${off.toString(16)}`;
}

/** Capture a backtrace from a Frida CpuContext, resolved to symbolic frames. */
export function getStackFrames(ctx: CpuContext, maxDepth: number = 20): string[] {
    const bt = Thread.backtrace(ctx, Backtracer.ACCURATE);
    const out: string[] = [];
    for (let i = 0; i < Math.min(bt.length, maxDepth); i++) {
        out.push(resolveFrame(bt[i]));
    }
    return out;
}
