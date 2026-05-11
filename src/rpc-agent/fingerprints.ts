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
    /** Stable structural fingerprint — same algorithm as
     *  `network.extractStructuralSignature` so it can be compared 1:1 against
     *  a label's `fingerprint` captured at rename time. Null when the class
     *  has no namespace-qualified type references (degenerate case). */
    structuralFp: string | null;
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
        structuralFp: computeStructuralFp(klass, fields, methods),
    };
}

// Same algorithm as network.extractStructuralSignature — must stay in lockstep
// so labels created via the rename route compare 1:1 against fingerprints
// emitted here at migration time.
function computeStructuralFp(klass: Il2Cpp.Class, fields: FieldFingerprint[], methods: MethodFingerprint[]): string | null {
    const isStable = (t: string | undefined): boolean => !!t && t.includes(".");

    const ftCounts = new Map<string, number>();
    for (const f of fields) {
        if (isStable(f.typeName)) ftCounts.set(f.typeName, (ftCounts.get(f.typeName) ?? 0) + 1);
    }

    const shapes = new Set<string>();
    for (const m of methods) {
        const tokens = [m.returnType, ...m.paramTypes];
        if (tokens.some(isStable)) {
            shapes.add(`${m.isStatic ? "s" : "i"}(${m.paramTypes.join(",")}):${m.returnType}`);
        }
    }

    if (ftCounts.size === 0 && shapes.size === 0) return null;

    const fc = klass.fields.length;
    const mc = klass.methods.length;
    const ftStr = [...ftCounts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([t, n]) => `${t}*${n}`).join("|");
    const msStr = [...shapes].sort().join("|");
    const sig = `S2:fc=${fc};mc=${mc};ft=[${ftStr}];ms=[${msStr}]`;
    return fnv1a64(sig);
}

function fnv1a64(s: string): string {
    let h1 = 0x811c9dc5 | 0, h2 = 0x1000193 | 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c; h1 = Math.imul(h1, 16777619) | 0;
        h2 ^= (c * 31) | 0; h2 = Math.imul(h2, 2166136261) | 0;
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
