/* =============================================================================
 * TOOL 01 — ANALYZE
 * =============================================================================
 * But :
 *   Faire un inventaire du runtime IL2CPP dès que le jeu est lancé :
 *     - liste des assemblies chargées + nb de classes
 *     - stats globales (classes / méthodes / champs)
 *     - classes communes Unity (GameObject, SceneManager, Time, Input…)
 *     - toutes les classes qui héritent de MonoBehaviour (= scripts gameplay)
 *
 *   C'est le PREMIER outil à lancer sur un jeu inconnu. Tu l'utilises une fois,
 *   tu sauvegardes la sortie dans un fichier, et tu t'y réfères ensuite.
 *
 * Build :
 *   npm run build:analyze
 *
 * Run :
 *   frida -l build/analyze.js -n FridaCobaye.exe --no-pause
 *   ou pour sauver la sortie :
 *   frida -l build/analyze.js -n FridaCobaye.exe --no-pause -o analyze.log
 *
 * Sortie attendue (extrait) :
 *   === ASSEMBLIES ===
 *     Assembly-CSharp                          42 classes
 *     UnityEngine.CoreModule                   1204 classes
 *     …
 *   === STATS ===
 *     classes : 5120
 *     methods : 43210
 *     fields  : 18765
 *   === MonoBehaviour subclasses ===
 *     Player
 *     GameManager
 *     …
 *
 * Config :
 *   Aucune, ça tourne tel quel.
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import { fullAnalyze } from "../lib";

console.log("[+] analyze tool loaded, waiting for IL2CPP…");

Il2Cpp.perform(() => {
    console.log("[+] IL2CPP ready, running full analysis…");
    fullAnalyze();
    console.log("\n[+] analyze done.");
});
