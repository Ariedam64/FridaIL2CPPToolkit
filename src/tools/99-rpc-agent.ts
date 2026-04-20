/* =============================================================================
 * TOOL 99 — RPC AGENT (advanced)
 * =============================================================================
 * But :
 *   Un AGENT UNIQUE et persistant qui s'attache une fois au jeu et expose toute
 *   la lib via RPC. Tu le pilotes ensuite depuis :
 *     - un hôte Node (TypeScript CLI, REPL, scénarios scriptés)
 *     - ou directement avec la CLI frida : rpc.exports.foo(...)
 *
 *   Avantage vs les tools 01–06 : pas besoin de recompiler/relancer pour chaque
 *   action. Tu explores le jeu interactivement.
 *
 * Build :
 *   npm run build:rpc
 *
 * Run (mode CLI interactive) :
 *   frida -l build/rpc-agent.js -n FridaCobaye.exe --no-pause -i
 *   > rpc.exports.analyze()
 *   > rpc.exports.find('Player')
 *   > rpc.exports.hook('Player', 'TakeDamage')
 *   > rpc.exports.patchStatic('Player', 'totalPlayersAlive', 999)
 *
 * Run (mode hôte Node — voir host/cli.ts à créer plus tard) :
 *   node host/cli.js
 *
 * Exposed API :
 *   analyze()                             → full analyze
 *   find(pattern)                         → liste les classes matchant
 *   dumpClass(name)                       → dump structurel d'une classe
 *   dumpStatics(name)                     → dump des statics d'une classe
 *   hook(className, methodName)           → log-hook une méthode
 *   replaceNoop(className, methodName)    → no-op sur une méthode (god-mode pattern)
 *   patchStatic(className, field, value)  → écrit un static field
 *   forceReturn(className, method, value) → force une valeur de retour
 *   callStatic(className, method, args)   → appelle une méthode statique
 *
 * Limite RPC : les valeurs retournées doivent être sérialisables en JSON.
 * Pour un Il2Cpp.Object, on renvoie son nom et son handle stringifié.
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import * as searchRpc from "../rpc-agent/search";
import * as explorerRpc from "../rpc-agent/explorer";
import * as hooksRpc from "../rpc-agent/hooks";
import * as instanceOpsRpc from "../rpc-agent/instance-ops";
import * as networkRpc from "../rpc-agent/network";

rpc.exports = {
    ...searchRpc,
    ...explorerRpc,
    ...hooksRpc,
    ...instanceOpsRpc,
    ...networkRpc,
};

Il2Cpp.perform(() => {
    console.log("[rpc-agent] ready. Exposed: analyze, find, dumpClass, dumpStatics, hook, replaceNoop, patchStatic, forceReturn, callStatic");
    send({ type: "agent-ready" });
});
