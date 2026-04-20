import "frida-il2cpp-bridge";
import { stringifyValue } from "./util";

/** Snapshot de l'état courant des champs d'une instance (pour diff ultérieur). */
export type FieldSnapshot = Record<string, string>;

export function snapshot(instance: Il2Cpp.Object): FieldSnapshot {
    const out: FieldSnapshot = {};
    for (const f of instance.class.fields) {
        if (f.isStatic) continue;
        try { out[f.name] = stringifyValue(instance.field(f.name).value); }
        catch { out[f.name] = "<err>"; }
    }
    return out;
}

/** Compare deux snapshots et log ce qui a changé. */
export function diff(before: FieldSnapshot, after: FieldSnapshot, label = "diff"): void {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    let n = 0;
    for (const k of keys) {
        if (before[k] !== after[k]) {
            console.log(`  [${label}] ${k}: ${before[k]} → ${after[k]}`);
            n++;
        }
    }
    if (n === 0) console.log(`  [${label}] (no change)`);
}

/**
 * Patch binaire direct (NOP, redirection, etc). Utilise Memory.patchCode.
 * bytes doit être un Uint8Array de la taille exacte des octets à écrire.
 * Exemple Windows x64 : new Uint8Array([0x90, 0x90, 0x90]) pour 3 NOPs.
 */
export function patchBytes(address: NativePointer, bytes: Uint8Array): void {
    Memory.patchCode(address, bytes.length, (code) => {
        code.writeByteArray(Array.from(bytes) as any);
    });
    console.log(`[mem] patched ${bytes.length} bytes at ${address}`);
}

/**
 * Scanne la mémoire lisible du process pour un literal texte.
 * Teste à la fois UTF-8 (C strings / métadonnées IL2CPP) et UTF-16 LE (System.String).
 * Renvoie "enc@0xaddr" pour chaque hit.
 *
 * Utile contre l'obfuscation :
 *   findStringInMemory("Game Over")  → adresses où la string est stockée
 *   Tu peux ensuite Memory.scan pour des pointeurs vers ces adresses dans le
 *   code (référenceurs) — étape manuelle pour l'instant.
 */
export function findStringInMemory(text: string, maxHits = 10): string[] {
    if (!text) return [];
    const out: string[] = [];

    const toHex = (b: number) => b.toString(16).padStart(2, "0");
    const asciiPattern = text.split("").map(c => toHex(c.charCodeAt(0) & 0xff)).join(" ");
    const utf16Pattern = text.split("").map(c => {
        const code = c.charCodeAt(0);
        return `${toHex(code & 0xff)} ${toHex((code >> 8) & 0xff)}`;
    }).join(" ");

    const ranges = Process.enumerateRanges({ protection: "r--", coalesce: true });
    for (const range of ranges) {
        if (out.length >= maxHits) break;
        for (const [enc, pattern] of [["utf16", utf16Pattern], ["utf8", asciiPattern]] as const) {
            try {
                const matches = Memory.scanSync(range.base, range.size, pattern);
                for (const m of matches) {
                    out.push(`${enc}@${m.address}`);
                    if (out.length >= maxHits) break;
                }
            } catch { /* range not readable */ }
            if (out.length >= maxHits) break;
        }
    }
    return out;
}

/** Récupère l'adresse native d'une méthode (utile pour Interceptor.attach bas niveau). */
export function methodAddress(className: string, methodName: string): NativePointer | null {
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            const k = asm.image.tryClass(className);
            if (!k) continue;
            const m = k.tryMethod(methodName);
            if (m) return m.virtualAddress;
        } catch { /* ignore */ }
    }
    return null;
}
