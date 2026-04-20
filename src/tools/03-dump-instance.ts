/* =============================================================================
 * TOOL 03 — DUMP INSTANCE
 * =============================================================================
 * But :
 *   Capturer une instance VIVANTE d'une classe (typiquement un MonoBehaviour
 *   comme Player) et dumper tous ses champs avec leurs valeurs courantes.
 *
 *   Pourquoi pas Il2Cpp.gc.choose() ? Parce que sur MonoBehaviour il ne trouve
 *   généralement rien (les GameObject vivent côté natif Unity). On capture donc
 *   via un hook sur une méthode fréquente.
 *
 * Build :
 *   npm run build:dump
 *
 * Run :
 *   frida -l build/dump-instance.js -n FridaCobaye.exe --no-pause
 *
 * Config :
 *   CLASS_NAME   : la classe dont on veut une instance
 *   HOOK_METHOD  : une méthode d'instance appelée souvent (Update, Tick…)
 *   DUMP_AFTER_N : dumpe après la N-ème fois que la méthode est appelée
 *                  (pour laisser le temps au jeu d'initialiser les champs)
 *
 * Sortie attendue :
 *   [capture] armed on Player.Tick, waiting for first call…
 *   [capture] got Player instance via Tick → Player@0x2a3f4b20
 *   === INSTANCE Player@0x2a3f4b20 ===
 *     System.Int32                   health                       = 100
 *     System.Int32                   gold                         = 50
 *     System.String                  playerName                   = "Romann"
 *     System.Int32                   _secretLevel                 = 1
 *     …
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import { dumpFields, findClass, dumpStatics } from "../lib";

// ============ CONFIG ============
const CLASS_NAME   = "Player";
const HOOK_METHOD  = "Tick";
const DUMP_AFTER_N = 1;
const DUMP_STATICS = true;
// ================================

Il2Cpp.perform(() => {
    let seen = 0;
    const klass = findClass(CLASS_NAME);
    if (!klass) { console.log(`[dump] class ${CLASS_NAME} not found`); return; }

    if (DUMP_STATICS) dumpStatics(klass);

    const method = klass.tryMethod(HOOK_METHOD);
    if (!method) { console.log(`[dump] method ${HOOK_METHOD} not found`); return; }

    method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
        const self = this as Il2Cpp.Object;
        seen++;
        if (seen === DUMP_AFTER_N) {
            console.log(`[dump] capturing on ${HOOK_METHOD} call #${seen}`);
            dumpFields(self);
        }
        return self.method(HOOK_METHOD).invoke(...args);
    };

    console.log(`[dump] armed on ${CLASS_NAME}.${HOOK_METHOD}, will dump on call #${DUMP_AFTER_N}`);
});
