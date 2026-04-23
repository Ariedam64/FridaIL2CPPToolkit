/* =============================================================================
 * PRESET — Dofus Unity (Ankama)
 * =============================================================================
 * Findings confirmées sur Dofus.exe (Unity IL2CPP).
 * Pas obfusqué — les namespaces Ankama.* et Core.* sont lisibles.
 *
 * Usage :
 *   import { DOFUS } from "../presets/dofus";
 *   // dans un tool batch :
 *   hookLog(DOFUS.inventory.class, DOFUS.inventory.methods.getKamas);
 *
 * Dans la web UI : on s'en sert juste comme cheatsheet — copier/coller les noms.
 *
 * Workflow rappelé pour lire une valeur d'inventaire/storage :
 *   1. tab instance → capture via GC → listInstances(className) → captureViaGC(className, 0)
 *   2. callInstance(className, "get_kamas", []) → renvoie la valeur
 * =============================================================================
 */

export const DOFUS = {
    processName: "Dofus.exe",
    mainAssembly: "Core",              // 8919 classes, le gros de la logique jeu
    protocolAssembly: "Ankama.Dofus.Protocol.Game",  // 4892 classes, messages réseau

    // -------------------------------------------------------------------------
    // Mapping des messages protocole obfusqués → noms lisibles
    //   Ces noms changent à chaque build Ankama (obfuscation renommée).
    //   Structure : class (3 lettres) → { readable, fields: { obf → readable } }
    //   Re-valider après chaque maj du jeu en utilisant `dumpClass(obfuscated)` et
    //   en comparant la signature avec ces schémas.
    // -------------------------------------------------------------------------
    protocolMap: {
        // ↑ Outgoing (client → server)
        iri: {
            readable: "GameMapMovementRequestMessage",
            direction: "out",
            fields: {
                bztd: "sprint",      // Bool — is running / sprint mode
                bztf: "timestamp",   // Int64 — client-side timestamp
                bzth: "mapId",       // Int64 — current map id (e.g. 191106052)
                bztj: "cellPath",    // RepeatedField<Int32> — the path cells in order
            },
        },
        isu: {
            readable: "GameMapMovementConfirmMessage",
            direction: "out",
            fields: {},              // no fields — empty marker sent on arrival
        },
        // ↓ Incoming (server → client) — TBD as we decode more
        irl: { readable: "?_server_heartbeat_or_movementAck", direction: "in", fields: {} },
        jnc: { readable: "?_frequent_server_event", direction: "in", fields: {} },
    },

    // -------------------------------------------------------------------------
    // Inventaire du joueur
    // -------------------------------------------------------------------------
    inventory: {
        class: "Core.UILogic.Inventory.Inventory",
        subclasses: {
            player: "PlayerInventory",   // c'est [0] dans gc.choose()
        },
        methods: {
            getKamas: "get_kamas",       // confirmed ✓
        },
        notes: [
            "listInstances retourne [PlayerInventory, Inventory, Inventory]",
            "le [0] PlayerInventory est celui du joueur connecté",
        ],
    },

    // -------------------------------------------------------------------------
    // Storages (banque, coffres, marchands…) — hiérarchie commune
    // -------------------------------------------------------------------------
    storage: {
        abstractClass: "Core.UILogic.Inventory.Uis.AbstractStorageUI",
        methods: {
            getKamas: "get_kamas",       // confirmed ✓ sur BankStorageUI
        },
        concrete: {
            bank: "BankStorageUI",        // confirmed ✓ → 681384 kamas lus via get_kamas()
            // à découvrir quand le jeu charge d'autres storages :
            //   guild:     ?  (coffre de guilde)
            //   merchant:  ?  (mode marchand)
            //   mount:     ?  (équipement monture)
            //   chest:     ?  (coffres de combat/donjon)
        },
        notes: [
            "pour lister tous les storages ouverts en mémoire :",
            "  listInstances('Core.UILogic.Inventory.Uis.AbstractStorageUI')",
            "pour voir toute la hiérarchie :",
            "  explorer → by inheritance → root = AbstractStorageUI",
        ],
    },

    // -------------------------------------------------------------------------
    // Recettes prêtes à l'emploi (copier dans les inputs de la web UI)
    // -------------------------------------------------------------------------
    recipes: {
        readInventoryKamas: {
            description: "lit les kamas du joueur (sac à dos)",
            steps: [
                "tab instance → capture via GC",
                "  class = Core.UILogic.Inventory.Inventory,  index = 0",
                "  → list puis capture",
                "tab instance → call method",
                "  class = Core.UILogic.Inventory.Inventory,  method = get_kamas,  args = []",
            ],
        },
        readBankKamas: {
            description: "lit les kamas de la banque (il faut que l'UI banque soit ouverte en jeu)",
            steps: [
                "tab instance → capture via GC",
                "  class = Core.UILogic.Inventory.Uis.AbstractStorageUI,  index = 0",
                "  → list puis capture",
                "tab instance → call method",
                "  class = Core.UILogic.Inventory.Uis.AbstractStorageUI,  method = get_kamas,  args = []",
            ],
        },
    },

    // -------------------------------------------------------------------------
    // Hôtel de Vente (TradeCenter) — flow complet validé ✓
    // -------------------------------------------------------------------------
    tradeCenter: {
        // Enum des types de HDV (banque de filtres par grande catégorie)
        auctionHouseTypes: "Core.DataCenter.Metadata.TradeCenter.AuctionHouseType",  // None/Equipments/Resources/Consumables/Creatures/Cosmetics/Runes/SoulStones
        currentTypeFieldOnUI: "currentAuctionHouseType",  // enum ObjectFamilyTypeEnum

        mainUI: {
            class: "Core.UILogic.TradeCenter.AuctionHouseUI",
            bidHouseServiceField: "m_bidHouseService",   // interface enz → concrete enb (noms obfusqués, vérifie après chaque màj)
            commonExchangeField:  "m_commonExchangeService", // interface eoo → concrete emq
        },

        // Classe concrète du bid house service (obfuscation : nom à revalider après màj)
        bidHouseServiceConcrete: {
            class: "enb",
            methods: {
                // Déclenche une recherche serveur avec la liste des typeIds à filtrer (1=Amulette, 17=Arc, 19=Anneau, 82=Ceinture, etc.)
                // Signature: void bbed(List<UInt32> typeIds)
                searchByTypeIds: "bbed",
            },
            fields: {
                // Cache des résultats de recherche (réponse serveur brute, sans UI).
                // List<emx> : 1 entrée par typeId déjà recherché dans la session.
                searchCache: "dkmj",

                // Liste des typeIds actuellement filtrés côté UI.
                currentTypeIds: "dkmn",
            },
            nestedTypes: {
                // enb.emx = { dklw: typeId, dklv: List<emy> }
                searchResult: {
                    typeIdField: "dklw",    // UInt32
                    itemsField:  "dklv",    // List<enb.emy>
                },
                // enb.emy = { dkly: itemId, dklx: List<emz> (offres détaillées, vide sans click) }
                itemEntry: {
                    itemIdField:  "dkly",   // UInt32 — itemId du Dofus DB
                    offersField:  "dklx",   // List<enb.emz> — rempli au click sur l'item
                },
            },
        },

        // Service des prix moyens — cache local itemId → avgPrice, sans UI
        averagePricesServiceConcrete: {
            class: "elu",
            fields: {
                // Dictionary<Int32 itemId, Int64 avgPrice>
                avgPriceDict: "<dkhm>k__BackingField",
                lastRefresh:  "<dkhl>k__BackingField",  // DateTime
            },
        },

        // Résolution itemId → ItemData (static, pas besoin d'UI ni d'instance)
        itemDataRepository: {
            class: "Core.DataCenter.Metadata.Item.ItemData",
            methods: {
                // static ItemData GetItemById(Int32 id) — dump tout (nameId, typeId, level, etc.)
                getItemById: "GetItemById",
            },
        },

        // Résolution nameId → string localisée (static)
        localization: {
            class: "Core.Localization.LocalizedStringUtilities",
            methods: {
                // static String GetLocalized(Int32 key) → "Amulette du Koalak"
                // Il y a 3 overloads (Int32/UInt32/String), utiliser callStaticOverload
                getLocalized: "GetLocalized",
                getLocalizedOverload: ["System.Int32"],
            },
        },

        // State manager du panneau "Acheter"
        buyState: {
            class: "Core.UILogic.TradeCenter.Buy.AuctionHouseBuy",
            fields: {
                itemsDisplayed:     "m_itemsDisplayed",      // List<IAuctionHouseBuyGridItem> — items visibles (vrai = ItemInfo runtime)
                allItemsFiltered:   "m_allItemsFiltered",    // Dictionary<Int32, IAuctionHouseBuyGridItem>
                allItems:           "m_allItems",            // List<ItemData>
                openedItems:        "m_openedItems",         // List<IAuctionHouseBuyGridItem> — items dont le détail est ouvert
                lastItemOpened:     "m_lastItemOpened",
            },
        },

        // Chaque ligne de la grille
        itemInfo: {
            class: "Core.UILogic.TradeCenter.ItemInfo",
            getters: {
                id:             "get_id",              // Int32
                itemData:       "get_item",            // ItemData
                averagePrice:   "get_averagePrice",    // Int64 (kamas) — prix moyen marché
                available:      "get_available",       // Boolean
                itemWrapper:    "get_itemWrapper",     // ks (le wrapper universel d'item)
                details:        "get_details",         // List<ItemDetails>
                isOpened:       "get_isOpened",        // Boolean
            },
        },

        // Offres détaillées (listings individuels, chargées au clic sur un item)
        itemDetails: {
            class: "Core.UILogic.TradeCenter.ItemDetails",
            getters: {
                id:           "get_id",           // Int32 (itemTypeId)
                price:        "get_price",        // Int64 — prix total du lot
                unityPrice:   "get_unityPrice",   // Int64 — prix unitaire
                quantity:     "get_quantity",     // Int32 — quantité du lot (1 / 10 / 100 / 1000)
                groupSize:    "get_groupSize",
                item:         "get_item",         // ItemData
                averagePrice: "get_averagePrice", // Int64
            },
        },

        // ks = wrapper universel d'item dans Dofus (inventaire, HDV, banque, marchand…)
        // Méthodes confirmées pour obtenir le nom / description lisibles
        // ⚠️ Ces noms sont obfusqués, ils changeront aux màj — revalider via probeNoArgGetters
        ksItemWrapper: {
            class: "ks",
            getters: {
                name:        "luu",   // String — "Amulette du Koalak"  (alias: mvd, mvf, mxj, lwb, mvb, lur)
                description: "lvz",   // String — description longue
            },
        },
    },

    // -------------------------------------------------------------------------
    // Exemples de recettes HDV (à coller dans la web UI)
    // -------------------------------------------------------------------------
    tradeCenterRecipes: {
        // Scrape des items visibles avec nom + prix moyen
        scrapeVisibleItems: [
            "1. Ouvre le HDV en jeu sur une catégorie",
            "2. capture Core.UILogic.TradeCenter.Buy.AuctionHouseBuy via GC",
            "3. pour i de 0 à N :",
            "   - captureListElement(AuctionHouseBuy, 'm_itemsDisplayed', i, 'item{i}')",
            "   - captureMethodReturn('item{i}', 'get_itemWrapper', [], 'ks{i}')",
            "   - callInstance('item{i}', 'get_id', [])            → id",
            "   - callInstance('item{i}', 'get_averagePrice', [])  → prix moyen",
            "   - callInstance('ks{i}',   'luu', [])               → nom",
        ],

        // Trigger une nouvelle recherche programmatique
        triggerSearch: [
            "captureViaGC('enb', 0)                                → bidHouseService concret",
            "callInstance('enb', 'bbed', [[1]])                    → cherche uniquement typeId=1 (Amulettes)",
            "… attendre ~1s puis relire AuctionHouseBuy.m_itemsDisplayed",
        ],

        // 🔥 Scrape 100% HEADLESS — sans HDV ouvert, avec nom + avgPrice en clair
        //    Exploite les caches réseau (enb, elu) + le DataCenter statique + le localization service.
        scrapeHeadless: [
            "setup (une fois):",
            "  captureViaGC('enb', 0)                                  → bidHouseService",
            "  captureViaGC('elu', 0)                                  → averagePricesService",
            "",
            "pour chaque TYPE_ID à scraper:",
            "  1. callInstance('enb', 'bbed', [[TYPE_ID]])             → déclenche la requête serveur",
            "  2. attendre ~500ms (round-trip)",
            "  3. captureListElement('enb', 'dkmj', <i>, 'emx')        → retrouve l'emx dont dklw == TYPE_ID",
            "  4. readList('emx', 'dklv', 999)                         → liste les emy (un par item)",
            "  5. pour chaque emy: captureListElement puis readField('emy', 'dkly') → itemId",
            "",
            "pour chaque itemId:",
            "  a. callStatic('Core.DataCenter.Metadata.Item.ItemData', 'GetItemById', [itemId])",
            "     → dump de l'ItemData (nameId, typeId, level, etc.) — parser le string",
            "  b. callStaticOverload(",
            "       'Core.Localization.LocalizedStringUtilities',",
            "       'GetLocalized',",
            "       ['System.Int32'],",
            "       [nameId]",
            "     )                                                    → nom FR ex: 'Amulette du Koalak'",
            "  c. dictGet('elu', '<dkhm>k__BackingField', itemId)     → avgPrice en kamas",
            "",
            "Exemple validé:",
            "  id=8003  nameId=37247   avg=35518    Amulette du Koalak",
            "  id=2472  nameId=35731   avg=14731    Gelamu",
            "  id=15996 nameId=486337  avg=318887   Pendentif Curatif",
        ],

        // Obtenir les offres détaillées d'un item
        readItemDetails: [
            "1. Clique sur un item dans le HDV en jeu (popup détail)",
            "2. captureListElement(AuctionHouseBuy, 'm_openedItems', 0, 'openedItem')",
            "3. enumerateList('openedItem', 'm_details', ['get_price','get_quantity','get_unityPrice'], 20)",
            "   → offres individuelles avec prix/qty",
        ],
    },

    // -------------------------------------------------------------------------
    // Pistes à explorer (todo/wip, complète au fur et à mesure)
    // -------------------------------------------------------------------------
    todo: [
        "trouver la classe du personnage (stats, équipement courant)",
        "protocole : hooker les messages ExchangeStarted / StorageKama*",
        "localiser la logique de sort (spell casting) pour comprendre les formules",
        "voir si la carte / position est accessible via une classe Core.UILogic.Map.*",
        "décoder les méthodes obfusquées restantes de ks (muz, lwb, mvb, etc. — probablement variantes de name/ToString/description)",
    ],
};
