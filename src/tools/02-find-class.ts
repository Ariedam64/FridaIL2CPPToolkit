/* =============================================================================
 * TOOL 02 — FIND CLASS / METHOD / FIELD
 * =============================================================================
 * But :
 *   Chercher des classes, méthodes ou champs par pattern (regex insensible
 *   à la casse par défaut). Pour chaque classe trouvée, dumpe la structure
 *   complète (parent, champs, méthodes, statics).
 *
 *   Tu t'en sers juste APRÈS analyze, quand tu sais ce que tu cherches (un nom
 *   qui ressemble à "Inventory", "Damage", "Save"…).
 *
 * Build :
 *   npm run build:find
 *
 * Run :
 *   frida -l build/find-class.js -n FridaCobaye.exe --no-pause
 *
 * Config — édite SEARCH ci-dessous :
 *   CLASS_PATTERN : nom/regex à chercher (ex: "Player", /manager$/i)
 *   METHOD_PATTERN : si défini, filtre aussi les méthodes matchantes
 *   FIELD_PATTERN : idem pour les champs
 *   DUMP_FULL : si true, dumpe toute la classe ; sinon juste son nom
 *
 * Exemple de recherche utile sur un jeu inconnu :
 *   CLASS_PATTERN = /damage|health|hit/i   → classes liées au combat
 *   CLASS_PATTERN = /inventory|item|loot/i → système d'inventaire
 *   CLASS_PATTERN = /save|prefs|config/i   → persistance
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import { findAllClasses, findMethods, findFields, fullClassName } from "../lib";
import { dumpClass } from "../lib/dump";

// ============ CONFIG ============
const CLASS_PATTERN: string | RegExp = /^Player$/;
const METHOD_PATTERN: string | RegExp | null = null;  // ex: /damage|hit/i
const FIELD_PATTERN: string | RegExp | null = null;   // ex: /health|gold/i
const DUMP_FULL = true;
const LIMIT = 30;
// ================================

Il2Cpp.perform(() => {
    console.log(`[find] searching classes matching: ${CLASS_PATTERN}`);
    const matches = findAllClasses(CLASS_PATTERN, LIMIT);
    console.log(`[find] ${matches.length} match(es):`);

    for (const klass of matches) {
        console.log(`  - ${fullClassName(klass)}`);

        if (DUMP_FULL) dumpClass(klass);

        if (METHOD_PATTERN) {
            const meths = findMethods(klass, METHOD_PATTERN);
            if (meths.length) {
                console.log(`    methods matching ${METHOD_PATTERN}:`);
                for (const m of meths) console.log(`      ${m.name}(${m.parameters.length} args)`);
            }
        }
        if (FIELD_PATTERN) {
            const fs = findFields(klass, FIELD_PATTERN);
            if (fs.length) {
                console.log(`    fields matching ${FIELD_PATTERN}:`);
                for (const f of fs) console.log(`      ${f.type.name} ${f.name}`);
            }
        }
    }
});
