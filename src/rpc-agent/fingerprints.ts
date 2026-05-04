// Return ClassFingerprint[] for every class in every assembly.
// Used by the toolkit's migration engine at attach of a new build to
// match old labels against new obf names via structural similarity.

import "frida-il2cpp-bridge";

interface ClassFingerprint {
    obfName: string;
    token: string | null;
    parents: string[];
    methodCount: number;
    methodSignatures: string[];
    fieldTypes: string[];
}

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

export function listClassFingerprints(): Promise<ClassFingerprint[]> {
    return inVm(() => {
        const out: ClassFingerprint[] = [];
        for (const asm of Il2Cpp.domain.assemblies) {
            for (const klass of asm.image.classes) {
                try {
                    out.push(fingerprint(klass));
                } catch {
                    // Some classes throw on inspection (generic instantiations,
                    // pointer types, etc.) — skip them rather than abort.
                }
            }
        }
        return out;
    });
}

function fingerprint(klass: Il2Cpp.Class): ClassFingerprint {
    const parents: string[] = [];
    if (klass.parent) parents.push(klass.parent.name);
    for (const iface of klass.interfaces) parents.push(iface.name);

    const methodSigs: string[] = [];
    for (const m of klass.methods) {
        try {
            const params = m.parameters.map((p) => p.type.name).join(",");
            const ret = m.returnType.name;
            methodSigs.push(`${m.name}(${params})→${ret}`);
        } catch {
            // skip
        }
    }
    methodSigs.sort();

    const fieldTypes: string[] = [];
    for (const f of klass.fields) {
        try {
            fieldTypes.push(`${f.name}:${f.type.name}`);
        } catch {
            // skip
        }
    }
    fieldTypes.sort();

    let token: string | null = null;
    try {
        // frida-il2cpp-bridge exposes klass.token as a number; encode hex.
        const t = (klass as unknown as { token?: number }).token;
        if (typeof t === "number") {
            token = "0x" + t.toString(16).toUpperCase();
        }
    } catch {
        // leave null
    }

    return {
        obfName: klass.name,
        token,
        parents: parents.sort(),
        methodCount: klass.methods.length,
        methodSignatures: methodSigs,
        fieldTypes,
    };
}
