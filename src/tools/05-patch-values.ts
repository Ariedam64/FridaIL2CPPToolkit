/* =============================================================================
 * TOOL 05 — PATCH VALUES
 * =============================================================================
 * But :
 *   Modifier des valeurs en live :
 *     - champs statiques (directement, sans instance)
 *     - champs d'instance (via un hook qui ré-écrit à chaque tick)
 *     - valeurs de retour de méthodes (force TakeDamage à ne rien faire, etc.)
 *
 * Build :
 *   npm run build:patch
 *
 * Run :
 *   frida -l build/patch-values.js -n FridaCobaye.exe --no-pause
 *
 * Config — 3 sections indépendantes :
 *
 *   STATIC_PATCHES : écriture ONE-SHOT sur des champs statiques au démarrage.
 *
 *   INSTANCE_PATCHES : écriture RÉCURRENTE sur des champs d'instance, déclenchée
 *     à chaque appel de tickMethod. Pratique pour maintenir health=9999 malgré
 *     les dégâts qui passent.
 *
 *   RETURN_PATCHES : force une méthode à toujours retourner la même valeur
 *     (ou à ne rien faire : value=undefined).
 *
 * Piège :
 *   INSTANCE_PATCHES écrit AVANT l'appel original. Si tickMethod lit les champs
 *   au tout début, ça marche. Si au contraire tickMethod recalcule/écrase le
 *   champ pendant son exécution, ton patch est perdu — dans ce cas bascule en
 *   post-invoke (écrire après le `invoke(...)`) ou utilise forceReturn() sur
 *   la méthode fautive.
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import { setStatic, forceReturn, findClass } from "../lib";

// ============ CONFIG ============

const STATIC_PATCHES: Array<{ className: string; fieldName: string; value: any }> = [
    // { className: "Player", fieldName: "totalPlayersAlive", value: 999 },
];

const INSTANCE_PATCHES: {
    className: string;
    tickMethod: string;       // méthode qu'on hooke pour déclencher les patches
    patches: Record<string, any>;
} = {
    className: "Player",
    tickMethod: "Tick",
    patches: {
        health: 9999,
        gold: 999999,
        _secretLevel: 42,
    },
};

const RETURN_PATCHES: Array<{ className: string; methodName: string; value: any }> = [
    // Force TakeDamage à ne rien faire (god mode)
    // { className: "Player", methodName: "TakeDamage", value: undefined },
];

// ================================

Il2Cpp.perform(() => {
    // 1. Static patches (one-shot)
    for (const p of STATIC_PATCHES) {
        setStatic(p.className, p.fieldName, p.value);
    }

    // 2. Return patches
    for (const p of RETURN_PATCHES) {
        forceReturn(p.className, p.methodName, p.value);
    }

    // 3. Instance patches (hook récurrent)
    if (INSTANCE_PATCHES && Object.keys(INSTANCE_PATCHES.patches).length > 0) {
        const klass = findClass(INSTANCE_PATCHES.className);
        if (!klass) { console.log(`[patch] class ${INSTANCE_PATCHES.className} not found`); return; }
        const method = klass.tryMethod(INSTANCE_PATCHES.tickMethod);
        if (!method) { console.log(`[patch] method ${INSTANCE_PATCHES.tickMethod} not found`); return; }

        method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
            const self = this as Il2Cpp.Object;
            for (const [name, val] of Object.entries(INSTANCE_PATCHES.patches)) {
                try { self.field<any>(name).value = val; }
                catch (e) { console.log(`[patch] field ${name}: ${e}`); }
            }
            return self.method(INSTANCE_PATCHES.tickMethod).invoke(...args);
        };
        console.log(`[patch] recurring patches armed via ${INSTANCE_PATCHES.className}.${INSTANCE_PATCHES.tickMethod}`);
    }

    console.log("[patch] all patches installed.");
});
