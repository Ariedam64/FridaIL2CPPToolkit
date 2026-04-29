// FileDescriptor capture module — atomic RVA hooks, no intercept-all.
//
// For each candidate from filedescriptor-init-candidates.json that has byte[]
// in its param_signature, install an Interceptor that reads arg0 as an IL2CPP
// byte[] and dumps the raw bytes hex-encoded to a session buffer.
//
// Throttle: max 200 captures per session. Each unique (class, method) is
// captured once. Designed to be safe under gameplay — no per-call logging.
//
// Lesson from session 2: NEVER intercept-all on hot Protobuf paths — it
// crashed the PC. Atomic RVA-only hooks scale linearly and are bounded.

import "frida-il2cpp-bridge";

interface CapturedDescriptor {
    class_obf_name: string;
    method_obf_name: string;
    rva: string;
    bytes_hex: string;
    captured_at_ms: number;
}

interface CandidateRow {
    class_obf_name: string;
    method_obf_name: string;
    rva: string;
    score?: number;
    param_signature?: string;
    modifiers?: string;
}

const buffer: CapturedDescriptor[] = [];
const seen = new Set<string>();
const installedListeners: InvocationListener[] = [];
const MAX_CAPTURES = 200;

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function readByteArrayIL2CPP(ptr: NativePointer): Uint8Array | null {
    if (ptr.isNull()) return null;
    try {
        const max_length = ptr.add(0x18).readUInt();
        if (max_length === 0 || max_length > 16 * 1024 * 1024) return null;
        const data = ptr.add(0x20).readByteArray(max_length);
        if (!data) return null;
        return new Uint8Array(data);
    } catch {
        return null;
    }
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function installFileDescriptorCapture(candidatesJson: string): Promise<{ installed: number; skipped_no_bytearg: number; skipped_other: number }> {
    return inVm(() => {
        const candidates: CandidateRow[] = JSON.parse(candidatesJson);
        const gameModule = Process.findModuleByName("GameAssembly.dll");
        if (!gameModule) {
            throw new Error("GameAssembly.dll not loaded");
        }
        const baseAddress = gameModule.base;
        let installedCount = 0;
        let skippedNoBytearg = 0;
        let skippedOther = 0;
        for (const c of candidates) {
            const sig = c.param_signature ?? "";
            if (!sig.includes("byte[]")) {
                skippedNoBytearg++;
                continue;
            }
            if (!c.rva || c.rva === "0x0") {
                skippedOther++;
                continue;
            }
            const rvaInt = parseInt(c.rva, 16);
            if (!Number.isFinite(rvaInt) || rvaInt <= 0) {
                skippedOther++;
                continue;
            }
            const target = baseAddress.add(rvaInt);
            const key = `${c.class_obf_name}::${c.method_obf_name}`;
            try {
                const listener = Interceptor.attach(target, {
                    onEnter(args) {
                        if (buffer.length >= MAX_CAPTURES) return;
                        if (seen.has(key)) return;
                        const bytes = readByteArrayIL2CPP(args[0]);
                        if (!bytes || bytes.length < 8) return;
                        seen.add(key);
                        buffer.push({
                            class_obf_name: c.class_obf_name,
                            method_obf_name: c.method_obf_name,
                            rva: c.rva,
                            bytes_hex: bytesToHex(bytes),
                            captured_at_ms: Date.now(),
                        });
                    },
                });
                installedListeners.push(listener);
                installedCount++;
            } catch {
                skippedOther++;
            }
        }
        return { installed: installedCount, skipped_no_bytearg: skippedNoBytearg, skipped_other: skippedOther };
    });
}

export function getCapturedDescriptors(): Promise<CapturedDescriptor[]> {
    return inVm(() => [...buffer]);
}

export function clearCapturedDescriptors(): Promise<{ cleared: number }> {
    return inVm(() => {
        const n = buffer.length;
        buffer.length = 0;
        seen.clear();
        return { cleared: n };
    });
}

export function uninstallFileDescriptorCapture(): Promise<{ uninstalled: number }> {
    return inVm(() => {
        const n = installedListeners.length;
        for (const l of installedListeners) {
            try { l.detach(); } catch { /* ignore */ }
        }
        installedListeners.length = 0;
        return { uninstalled: n };
    });
}
