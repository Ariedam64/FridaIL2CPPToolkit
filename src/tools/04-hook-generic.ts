/* =============================================================================
 * TOOL 04 — HOOK GENERIC
 * =============================================================================
 * But :
 *   Poser un hook de LOG sur une ou plusieurs méthodes, sans changer leur
 *   comportement. Parfait pour comprendre :
 *     - quand une méthode est appelée (fréquence, trigger)
 *     - quels args elle reçoit
 *     - quelle valeur elle retourne
 *   C'est ta loupe pour reverse-engineer la logique d'un jeu.
 *
 * Build :
 *   npm run build:hook
 *
 * Run :
 *   frida -l build/hook-generic.js -n FridaCobaye.exe --no-pause
 *
 * Config :
 *   HOOKS : liste de { className, methodName } à logger.
 *   Tu peux en mettre plusieurs d'un coup pour tracer un flow.
 *
 * Piège inlining :
 *   Si ton hook ne fire jamais alors que la méthode DEVRAIT être appelée,
 *   elle est probablement inlinée par IL2CPP. Hooke :
 *     - le caller à la place (la méthode qui appelle ta cible)
 *     - ou une méthode voisine non-inlinée (souvent plus grosse, virtuelle,
 *       ou qui traverse une frontière : network, I/O, crypto)
 *
 * Exemple de sortie :
 *   [Player.TakeDamage] this=Player@0x2a3f args=(15)
 *   [Player.TakeDamage]   → undefined
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import { hookLog } from "../lib";

// ============ CONFIG ============
const HOOKS: Array<{ className: string; methodName: string }> = [
    { className: "Player", methodName: "TakeDamage" },
    { className: "Player", methodName: "EncryptAndSend" },
    { className: "Player", methodName: "AddGold" },
];
// ================================

Il2Cpp.perform(() => {
    for (const { className, methodName } of HOOKS) {
        hookLog(className, methodName);
    }
    console.log("[hook] all hooks installed, waiting for activity…");
});
