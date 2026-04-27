import "frida-il2cpp-bridge";
import { findClass } from "./search";

/**
 * Capture UNE instance d'une classe en posant un hook sur une de ses méthodes.
 * Utile pour MonoBehaviour car Il2Cpp.gc.choose() les rate souvent.
 *
 * Retourne un handle { get() } — la capture est asynchrone, elle se fait dès que le
 * jeu appelle `methodName` sur une instance. Choisis une méthode fréquente
 * (Update, Tick, FixedUpdate…).
 */
export function captureViaHook(className: string, methodName: string): { get(): Il2Cpp.Object | null } {
    let captured: Il2Cpp.Object | null = null;
    const klass = findClass(className);
    if (!klass) { console.log(`[capture] class ${className} not found`); return { get: () => null }; }
    const method = klass.tryMethod(methodName);
    if (!method) { console.log(`[capture] method ${methodName} not found`); return { get: () => null }; }
    if (method.isStatic) { console.log(`[capture] ${methodName} is static, cannot capture instance`); return { get: () => null }; }

    method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
        const self = this as Il2Cpp.Object;
        if (!captured) {
            captured = self;
            console.log(`[capture] got ${className} instance via ${methodName} → ${self.class.name}@${self.handle}`);
            method.revert();
        }
        return self.method(methodName).invoke(...args);
    };

    console.log(`[capture] armed on ${className}.${methodName}, waiting for first call…`);
    return { get: () => captured };
}

/**
 * Essaie Il2Cpp.gc.choose() — rapide mais ne trouve pas les MonoBehaviours en pratique.
 * Bon pour des classes "managées pures" (logique business côté CSharp).
 */
export function listInstancesViaGC(className: string): Il2Cpp.Object[] {
    const klass = findClass(className);
    if (!klass) return [];
    try { return Il2Cpp.gc.choose(klass); }
    catch { return []; }
}

/** Traverse la scène Unity et retourne les Components du type demandé. */
export function findComponentsInScene(componentClassName: string): Il2Cpp.Object[] {
    // UnityEngine.Object.FindObjectsOfType<T>() — on passe par la version non-générique via le Type
    const found: Il2Cpp.Object[] = [];
    try {
        const typeClass = findClass(componentClassName);
        if (!typeClass) return found;

        // On récupère System.Type via Il2Cpp
        const UObject = findClass("UnityEngine.Object");
        if (!UObject) return found;

        const findByType = UObject.tryMethod("FindObjectsOfType", 1);
        if (!findByType) return found;

        const systemType = typeClass.type.object; // Il2Cpp.Object représentant System.Type
        const arr = findByType.invoke(systemType) as Il2Cpp.Array<Il2Cpp.Object>;
        for (let i = 0; i < arr.length; i++) found.push(arr.get(i));
    } catch (e) {
        console.log(`[instances] findComponentsInScene failed: ${e}`);
    }
    return found;
}
