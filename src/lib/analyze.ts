import "frida-il2cpp-bridge";
import { banner, fullClassName } from "./util";
import { findSubclasses } from "./search";

/** Liste les assemblies chargées avec le nombre de classes de chacune. */
export function listAssemblies(): void {
    banner("ASSEMBLIES");
    for (const asm of Il2Cpp.domain.assemblies) {
        let count = 0;
        try { count = asm.image.classes.length; } catch { /* ignore */ }
        console.log(`  ${asm.name.padEnd(40)} ${count} classes`);
    }
}

/** Stats globales : total classes / méthodes / champs. */
export function countStats(): void {
    banner("STATS");
    let nClasses = 0, nMethods = 0, nFields = 0;
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                nClasses++;
                nMethods += k.methods.length;
                nFields += k.fields.length;
            }
        } catch { /* ignore */ }
    }
    console.log(`  classes : ${nClasses}`);
    console.log(`  methods : ${nMethods}`);
    console.log(`  fields  : ${nFields}`);
}

/**
 * Liste les classes qui héritent de UnityEngine.MonoBehaviour.
 * Ces classes sont les "scripts" gameplay — c'est quasi toujours là que tu veux hooker.
 */
export function listMonoBehaviours(limit = 200): void {
    banner("MonoBehaviour subclasses");
    const subs = findSubclasses("MonoBehaviour", limit);
    for (const k of subs) {
        console.log(`  ${fullClassName(k)}`);
    }
    console.log(`  (${subs.length}${subs.length >= limit ? "+" : ""} total)`);
}

/** Les gros helpers Unity souvent clés : SceneManager, GameObject, etc. */
export function listCommonTargets(): void {
    banner("Common Unity targets");
    const targets = [
        "UnityEngine.GameObject",
        "UnityEngine.Transform",
        "UnityEngine.SceneManagement.SceneManager",
        "UnityEngine.Time",
        "UnityEngine.Input",
        "UnityEngine.PlayerPrefs",
    ];
    for (const t of targets) {
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                const k = asm.image.tryClass(t);
                if (k) { console.log(`  ${t}  (in ${asm.name})`); break; }
            } catch { /* ignore */ }
        }
    }
}

/** Run complet : assemblies + stats + MonoBehaviours + targets communs. */
export function fullAnalyze(): void {
    listAssemblies();
    countStats();
    listCommonTargets();
    listMonoBehaviours();
}
