/* =============================================================================
 * PRESET — FridaCobaye
 * =============================================================================
 * Config centralisée pour le projet de test FridaCobaye (Unity 6 IL2CPP).
 * Les tools peuvent importer ce preset au lieu de hardcoder les noms.
 *
 * Usage dans un tool :
 *   import { FRIDACOBAYE } from "../presets/fridacobaye";
 *   hookLog(FRIDACOBAYE.player.class, FRIDACOBAYE.player.methods.takeDamage);
 * =============================================================================
 */

export const FRIDACOBAYE = {
    processName: "FridaCobaye.exe",
    assembly: "Assembly-CSharp",

    player: {
        class: "Player",
        methods: {
            start:         "Start",
            update:        "Update",
            tick:          "Tick",
            takeDamage:    "TakeDamage",
            getGold:       "GetGold",
            addGold:       "AddGold",
            encryptAndSend: "EncryptAndSend",
            die:           "Die",
            printAliveCount: "PrintAliveCount",  // static
        },
        instanceFields: {
            health:      "health",
            gold:        "gold",
            playerName:  "playerName",
            secretLevel: "_secretLevel",
            secretKey:   "_secretKey",
            tickTimer:   "_tickTimer",
        },
        staticFields: {
            totalPlayersAlive: "totalPlayersAlive",
        },
    },

    /** Presets de patch prêts à l'emploi. */
    patches: {
        godMode: {
            health: 9999,
        },
        richMode: {
            gold: 999999,
        },
        fullCheat: {
            health: 9999,
            gold: 999999,
            _secretLevel: 99,
        },
    },
};
