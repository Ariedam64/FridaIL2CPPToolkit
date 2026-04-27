/* =============================================================================
 * TOOL 06 — INVOKE (call methods on demand)
 * =============================================================================
 * But :
 *   Appeler une méthode du jeu à la demande, sans attendre que le jeu la
 *   déclenche. Utile pour :
 *     - tester une méthode isolément (ex: Die, Respawn, GiveItem)
 *     - enchaîner plusieurs appels pour créer un scénario
 *     - lire une valeur calculée (ex: GetGold())
 *
 *   Pour les méthodes STATIQUES : appel direct.
 *   Pour les méthodes d'INSTANCE : on capture d'abord une instance via hook.
 *
 * Build :
 *   npm run build:invoke
 *
 * Run :
 *   frida -l build/invoke.js -n FridaCobaye.exe --no-pause
 *
 * Config :
 *   STATIC_CALLS : appels directs au chargement (pas besoin d'instance)
 *
 *   INSTANCE_CALLS : appels à faire sur une instance capturée.
 *     - captureFrom : { className, methodName } pour capturer l'instance
 *     - delayMs : délai avant de lancer les appels (laisse le temps au hook de fire)
 *     - calls : liste de { methodName, args }
 *
 * Exemple :
 *   STATIC_CALLS = [{ className: "Player", methodName: "PrintAliveCount", args: [] }]
 *   → appelle Player.PrintAliveCount() immédiatement après attachement
 *
 *   INSTANCE_CALLS = {
 *     captureFrom: { className: "Player", methodName: "Tick" },
 *     delayMs: 5000,
 *     calls: [
 *       { methodName: "AddGold", args: [1_000_000] },
 *       { methodName: "GetGold", args: [] },
 *     ]
 *   }
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import { callStatic, call, captureViaHook } from "../lib";

// ============ CONFIG ============

const STATIC_CALLS: Array<{ className: string; methodName: string; args: any[] }> = [
    { className: "Player", methodName: "PrintAliveCount", args: [] },
];

const INSTANCE_CALLS = {
    captureFrom: { className: "Player", methodName: "Tick" },
    delayMs: 5000,
    calls: [
        { methodName: "AddGold",  args: [1_000_000] },
        { methodName: "GetGold",  args: [] },
    ],
};

// ================================

Il2Cpp.perform(() => {
    // 1. Static calls d'abord
    for (const c of STATIC_CALLS) {
        try { callStatic(c.className, c.methodName, ...c.args); }
        catch (e) { console.log(`[invoke] ${e}`); }
    }

    // 2. Instance calls après capture
    if (INSTANCE_CALLS && INSTANCE_CALLS.calls.length > 0) {
        const handle = captureViaHook(
            INSTANCE_CALLS.captureFrom.className,
            INSTANCE_CALLS.captureFrom.methodName,
        );

        setTimeout(() => {
            Il2Cpp.perform(() => {
                const inst = handle.get();
                if (!inst) {
                    console.log(`[invoke] no instance captured after ${INSTANCE_CALLS.delayMs}ms, aborting`);
                    return;
                }
                for (const c of INSTANCE_CALLS.calls) {
                    try { call(inst, c.methodName, ...c.args); }
                    catch (e) { console.log(`[invoke] ${e}`); }
                }
            });
        }, INSTANCE_CALLS.delayMs);
    }
});
