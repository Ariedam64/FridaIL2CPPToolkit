import "frida-il2cpp-bridge";
import { findClass } from "./search";
import { hookReplace } from "./hook";

/** Écrit un champ d'instance. value doit être du bon type (number, Il2Cpp.String, Il2Cpp.Object, etc). */
export function setField<T = any>(instance: Il2Cpp.Object, fieldName: string, value: T): void {
    try {
        instance.field<any>(fieldName).value = value as any;
        console.log(`[patch] ${instance.class.name}.${fieldName} = ${String(value)}`);
    } catch (e) {
        console.log(`[patch] setField failed on ${fieldName}: ${e}`);
    }
}

/** Écrit un champ statique d'une classe par nom. */
export function setStatic<T = any>(className: string, fieldName: string, value: T): void {
    const klass = findClass(className);
    if (!klass) { console.log(`[patch] class ${className} not found`); return; }
    const f = klass.fields.find(x => x.name === fieldName);
    if (!f) { console.log(`[patch] field ${fieldName} not found on ${className}`); return; }
    if (!f.isStatic) { console.log(`[patch] ${fieldName} is not static`); return; }
    try {
        f.value = value as any;
        console.log(`[patch] ${className}.${fieldName} = ${String(value)}`);
    } catch (e) {
        console.log(`[patch] setStatic failed: ${e}`);
    }
}

/** Force une méthode à toujours retourner la même valeur (sans appeler l'original). */
export function forceReturn(className: string, methodName: string, value: any): void {
    hookReplace(className, methodName, () => value);
    console.log(`[patch] ${className}.${methodName} forced to return ${String(value)}`);
}

/**
 * Patch plusieurs champs d'une instance en une seule passe.
 * Exemple : patchFields(player, { health: 9999, gold: 999999 })
 */
export function patchFields(instance: Il2Cpp.Object, patches: Record<string, unknown>): void {
    for (const [name, val] of Object.entries(patches)) {
        setField(instance, name, val);
    }
}
