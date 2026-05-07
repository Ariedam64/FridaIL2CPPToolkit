// Return ClassFingerprint[] for every class in every assembly.
// Used by the toolkit's migration engine at attach of a new build to
// match old labels against new obf names via structural similarity.

import "frida-il2cpp-bridge";

interface FieldFingerprint {
    obfName: string;
    typeName: string;
    declIndex: number;
    isStatic: boolean;
    isPublic: boolean;
}

interface MethodFingerprint {
    obfName: string;
    token: string | null;
    paramTypes: string[];
    returnType: string;
    paramCount: number;
    declIndex: number;
    isStatic: boolean;
}

interface ClassFingerprint {
    obfName: string;
    token: string | null;
    parents: string[];
    methodCount: number;
    fields: FieldFingerprint[];
    methods: MethodFingerprint[];
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

    const fields: FieldFingerprint[] = [];
    let fieldIdx = 0;
    for (const f of klass.fields) {
        try {
            const flags = f.flags;
            fields.push({
                obfName: f.name,
                typeName: f.type.name,
                declIndex: fieldIdx,
                isStatic: f.isStatic,
                isPublic: (flags & 0x0007) === 0x0006,
            });
        } catch {
            // skip unreadable field
        }
        fieldIdx++;
    }

    const methods: MethodFingerprint[] = [];
    let methodIdx = 0;
    for (const m of klass.methods) {
        try {
            const params = m.parameters.map((p) => p.type.name);
            const ret = m.returnType.name;
            const t = (m as unknown as { token?: number }).token;
            methods.push({
                obfName: m.name,
                token: typeof t === "number" ? "0x" + t.toString(16).toUpperCase() : null,
                paramTypes: params,
                returnType: ret,
                paramCount: params.length,
                declIndex: methodIdx,
                isStatic: m.isStatic,
            });
        } catch {
            // skip unreadable method
        }
        methodIdx++;
    }

    let token: string | null = null;
    try {
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
        fields,
        methods,
    };
}
