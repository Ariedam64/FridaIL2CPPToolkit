import "frida-il2cpp-bridge";
import { fullClassName } from "./util";

function toRegex(p: string | RegExp): RegExp {
    if (p instanceof RegExp) return p;
    // Un string tout court est traité comme sous-chaîne insensible à la casse
    return new RegExp(p, "i");
}

/** Itère sur toutes les classes de toutes les assemblies — utilitaire interne. */
export function* allClasses(): Generator<Il2Cpp.Class> {
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const klass of asm.image.classes) {
                yield klass;
            }
        } catch {
            // certaines images peuvent lever, on ignore
        }
    }
}

/**
 * Première classe dont le nom matche.
 * - String : exact-match (nom simple ou full) en priorité, puis fallback regex substring.
 * - RegExp : premier match du regex.
 *
 * Cette priorité évite le piège où findClass("Player") retournerait
 * "UnityEngine.InputSystem.RemoteInputPlayerConnection" (qui contient "Player").
 */
export function findClass(pattern: string | RegExp): Il2Cpp.Class | null {
    if (typeof pattern === "string") {
        for (const klass of allClasses()) {
            if (klass.name === pattern || fullClassName(klass) === pattern) return klass;
        }
    }
    const re = toRegex(pattern);
    for (const klass of allClasses()) {
        if (re.test(klass.name) || re.test(fullClassName(klass))) return klass;
    }
    return null;
}

/** Toutes les classes dont le nom matche (limité pour éviter de flooder). */
export function findAllClasses(pattern: string | RegExp, limit = 100): Il2Cpp.Class[] {
    const re = toRegex(pattern);
    const out: Il2Cpp.Class[] = [];
    for (const klass of allClasses()) {
        if (re.test(klass.name) || re.test(fullClassName(klass))) {
            out.push(klass);
            if (out.length >= limit) break;
        }
    }
    return out;
}

/** Classes qui héritent directement ou indirectement de baseName. */
export function findSubclasses(baseName: string, limit = 100): Il2Cpp.Class[] {
    const out: Il2Cpp.Class[] = [];
    for (const klass of allClasses()) {
        let cur = klass.parent;
        while (cur) {
            if (cur.name === baseName || fullClassName(cur) === baseName) {
                out.push(klass);
                if (out.length >= limit) return out;
                break;
            }
            cur = cur.parent;
        }
    }
    return out;
}

/** Méthodes dont le nom matche, sur une classe donnée. */
export function findMethods(klass: Il2Cpp.Class, pattern: string | RegExp): Il2Cpp.Method[] {
    const re = toRegex(pattern);
    return klass.methods.filter(m => re.test(m.name));
}

/** Champs dont le nom matche, sur une classe donnée. */
export function findFields(klass: Il2Cpp.Class, pattern: string | RegExp): Il2Cpp.Field[] {
    const re = toRegex(pattern);
    return klass.fields.filter(f => re.test(f.name));
}

export interface FieldMatch { class: Il2Cpp.Class; field: string; type: string; }

/**
 * Trouve les classes qui ont AU MOINS un champ matchant les patterns donnés.
 * Au moins un des deux patterns doit être fourni.
 * Utile contre l'obfuscation : même si la classe s'appelle "a", si elle a un
 * champ `Int32 health`, tu la retrouves.
 */
export function findByField(
    typePattern: string | RegExp | null,
    namePattern: string | RegExp | null,
    limit = 50,
): FieldMatch[] {
    if (!typePattern && !namePattern) return [];
    const typeRe = typePattern ? toRegex(typePattern) : null;
    const nameRe = namePattern ? toRegex(namePattern) : null;
    const out: FieldMatch[] = [];
    for (const klass of allClasses()) {
        for (const f of klass.fields) {
            const tOk = !typeRe || typeRe.test(f.type.name);
            const nOk = !nameRe || nameRe.test(f.name);
            if (tOk && nOk) {
                out.push({ class: klass, field: f.name, type: f.type.name });
                if (out.length >= limit) return out;
                break;  // one hit per class is enough
            }
        }
    }
    return out;
}

export interface MethodMatch { class: Il2Cpp.Class; method: string; signature: string; }

/**
 * Trouve les méthodes qui matchent la combinaison donnée. Chaque champ de `opts`
 * est un regex optionnel. Utile pour les jeux obfusqués où tu cherches "une
 * méthode qui prend un Vector3 et retourne un bool" plutôt qu'un nom précis.
 */
export function findByMethod(
    opts: {
        returnType?: string | RegExp;
        paramType?:  string | RegExp;
        name?:       string | RegExp;
    },
    limit = 50,
): MethodMatch[] {
    const rtRe = opts.returnType ? toRegex(opts.returnType) : null;
    const ptRe = opts.paramType  ? toRegex(opts.paramType)  : null;
    const nmRe = opts.name       ? toRegex(opts.name)       : null;
    if (!rtRe && !ptRe && !nmRe) return [];
    const out: MethodMatch[] = [];
    for (const klass of allClasses()) {
        for (const m of klass.methods) {
            if (nmRe && !nmRe.test(m.name)) continue;
            if (rtRe && !rtRe.test(m.returnType.name)) continue;
            if (ptRe && !m.parameters.some(p => ptRe.test(p.type.name))) continue;
            const sig = `${m.returnType.name} ${m.name}(${m.parameters.map(p => `${p.type.name} ${p.name}`).join(", ")})`;
            out.push({ class: klass, method: m.name, signature: sig });
            if (out.length >= limit) return out;
        }
    }
    return out;
}
