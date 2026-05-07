# Dofus 3.0 — Index Cpp2IL avec attributs (Voie B)

> Exécution de la **Voie B** du roadmap : exploiter les DLLs Cpp2IL enrichies
> par les processors `attributeanalyzer + attributeinjector` pour extraire un
> index complet (Token + RVA + FieldOffset + GeneratedCode) et l'enrichir
> dans la déobfuscation map existante.

## TL;DR

Trois nouveaux assets indexés dans [`data/indexed/`](../data/indexed/) :

| Fichier | Taille | Contenu |
|---|---|---|
| `core.classes.json` | 34 MB | 5992 types Core indexés (Token, parent, méthodes RVA, fields offset) |
| `protocol-game.classes.json` | 14 MB | 1608 types Protocol.Game indexés (1442 protoc-generated) |
| `deobmap-enriched.json` | 855 KB | Les 403 entrées de la deob map enrichies avec RVA |
| `frida-rename-table.json` | 150 KB | **Table compacte pour le futur rename layer** |

**Stats du résultat** :
- ✅ **5992 + 1608 = 7600 types indexés** au total
- ✅ **89 081 méthodes indexées avec RVA native** (100% des methods Cpp2IL)
- ✅ **1442 classes protoc-generated** identifiées sans ambiguïté (vs heuristique avant)
- ✅ **349 / 403 classes** de la deob map matchées dans l'index (87 %)
- ✅ **256 méthodes leaked** mappées à leur **`obfuscated_name → original_name → RVA`** (e.g. `egq.ywp = ConsumeKardByCode @ 0x16FD310`)
- ✅ **479 méthodes avec nom original récupéré** au total (compiler-gen leak detection automatique)
- ✅ **5228 fields** avec leur FieldOffset exact dans la struct C++

## Le pipeline en 4 étapes

```
1. Cpp2IL avec processors enrichis  →  DLLs +3.4× taille
   ├─ attributeanalyzer    : analyse les CustomAttributes natifs
   └─ attributeinjector    : injecte [Token] / [Address] / [FieldOffset] / [GeneratedCode]

2. ilspycmd décompile les DLLs enrichies en .cs
   └─ Tous les attributs apparaissent dans les .cs sources

3. index-cpp2il-attrs.py parse les .cs en regex
   └─ Extrait par classe : token, parent, fields, methods (avec RVA)
   └─ Détecte le compiler-gen leak via [AsyncStateMachine(typeof(_003C<Name>_003Ed__N))]

4. enrich-deobmap-with-rva.py + build-frida-rename-table.py
   └─ Cross-réf avec la deob map existante
   └─ Produit la rename table pour le futur Frida hook layer
```

## Pourquoi les RVA changent tout

Avant, pour hooker `egq.ConsumeKardByCode` via Frida :
```javascript
// Demande à frida-il2cpp-bridge de chercher la classe (slow), trouver
// la méthode obfusquée par sa SIGNATURE (encore plus slow), puis la hooker.
const klass = Il2Cpp.Domain.assembly("Core").image.class("egq");
const method = klass.methods.filter(m => /* signature match */)[0];
Interceptor.attach(method.virtualAddress, { ... });
```

Maintenant :
```javascript
// On a la RVA exacte. Hook direct, sans bridge, sans recherche.
const ga = Module.findBaseAddress("GameAssembly.dll");
Interceptor.attach(ga.add(0x16FD310), {
  onEnter(args) { console.log("[HOOK] egq.ConsumeKardByCode called"); }
});
```

**Bénéfices** :
- Pas de recherche par nom = **pas d'intercept-tout** = **pas de crash** (cf. session 2)
- Hook setup : milliseconds vs secondes
- Reproductible build-to-build (les RVA bougent à chaque update mais on peut re-générer)
- Permet de hooker **avant que IL2CPP ne soit init** (si jamais utile)

## Exemples concrets exploitables maintenant

### HAAPI client (`egq`) — 16 méthodes mappées

```javascript
const ga = Module.findBaseAddress("GameAssembly.dll");

const egq = {
  ConsumeKardByCode:        ga.add(0x16FD310),  // (string code, string lang)
  ConsumeKardById:          ga.add(0x16FD420),
  CreateTokenWithPassword:  ga.add(0x16FCBD0),  // (string account, string password, long game)
  GetAccountBids:           ga.add(0x16FD850),
  GetAlmanaxEvent:          ga.add(0x16FCE20),
  // ... 11 autres dans frida-rename-table.json
};

// Log every Almanax event request
Interceptor.attach(egq.GetAlmanaxEvent, {
  onEnter(args) { console.log("[HAAPI] GetAlmanaxEvent"); },
});
```

### Audio FMOD (`els`) — 10 méthodes mappées

```javascript
const els = {
  DoLoadBank:                       ga.add(0x17E7810),
  DoLoadBankWithGuid:               ga.add(0x17E78C0),
  GenerateMapSpatializationAsync:   ga.add(0x17E85F0),
  Init:                             ga.add(0x17E4560),
  Initialize:                       ga.add(0x17E5880),
  // ...
};
```

### Cartography (`eat`) — 10 méthodes mappées

```javascript
const eat = {
  CenterToPlayerPosition:    ga.add(0x15FD730),
  Display:                   ga.add(0x15F1CF0),
  DisplayWhenReady:          ga.add(0x15FD6B0),
  LoadCartographyImages:     ga.add(0x15F28C0),
  LoadLod:                   ga.add(0x15F29F0),
  // ...
};
```

(Liste complète dans `data/indexed/frida-rename-table.json` sous `methods`.)

## Le compiler-gen leak: comment ça marche

OPS Obfuscator renomme `eat.LoadCartographyImages` en `eat.vyp`. Mais la
state machine async pour le `await` est compiler-generated par `csc.exe`
**après** l'obfuscation, sous le nom `eat.<LoadCartographyImages>d__52`.

ilspycmd décompile cela en :

```csharp
[AsyncStateMachine(typeof(_003CLoadCartographyImages_003Ed__52))]
[Token(Token = "0x600C123")]
[Address(RVA = "0x15F28C0", Length = "0xB4")]
private async Task vyp(int id, CancellationToken token) { throw null; }

private struct _003CLoadCartographyImages_003Ed__52 : IAsyncStateMachine
{
    // ... state machine fields & MoveNext()
}
```

Le parser extrait `LoadCartographyImages` depuis le `[AsyncStateMachine]`
attribute et l'attache à la méthode `vyp` → **mapping certain
`obf_method → original_name`**, pas une heuristique.

Ce vecteur fonctionne partout où `async` ou `yield` est utilisé. Sur Core,
ça donne **483 méthodes nommées automatiquement** (vs 7 que la deob map
listait avant).

## Field offsets exacts pour scan/read direct

Pour `gui` (l'envelope universelle) :

| Field | Type | Offset C++ |
|---|---|---|
| `dudn` (UnknownFieldSet) | `UnknownFieldSet` | `0x10` |
| `dudr` (oneof storage) | `object` | `0x18` |
| `duds` (oneof case enum) | `gui.guh` | `0x20` |

Côté Frida :
```javascript
const guiInstance = /* ... pointer to a gui object ... */;
const oneofCase = guiInstance.add(0x20).readU32();  // duds = case
const payloadPtr = guiInstance.add(0x18).readPointer();  // dudr = payload
```

Plus besoin d'utiliser `frida-il2cpp-bridge` field accessors qui font 3
allocations + une lookup par accès. **Direct memory read, ~10× plus rapide**.

## Limite : 54 classes obfusquées non matchées

54 entrées de la deob map (genre `fpz\`1`, `fqd\`2`) sont des **types
génériques avec arity** (notation \`N). Mon parser actuel ne les match pas
correctement quand le nom inclut le backtick. À fixer si besoin.

Les autres 349 sont matchées avec `token` + `namespace` + `parents` + `RVA`
de toutes leurs méthodes.

## Outputs

### Scripts
- [`scripts/index-cpp2il-attrs.py`](../scripts/index-cpp2il-attrs.py) — parser principal des .cs
- [`scripts/enrich-deobmap-with-rva.py`](../scripts/enrich-deobmap-with-rva.py) — cross-ref avec la deob map
- [`scripts/build-frida-rename-table.py`](../scripts/build-frida-rename-table.py) — produit la rename table

### Données
- [`data/indexed/core.classes.json`](../data/indexed/core.classes.json) — index complet Core
- [`data/indexed/protocol-game.classes.json`](../data/indexed/protocol-game.classes.json) — index complet Protocol.Game
- [`data/indexed/deobmap-enriched.json`](../data/indexed/deobmap-enriched.json) — deob map + RVA
- [`data/indexed/frida-rename-table.json`](../data/indexed/frida-rename-table.json) — **table de rename pour Frida hook layer**

### Reproduire
```bash
# 1. Decompile DLLs enrichies (si pas déjà fait)
ilspycmd -p "%TEMP%\cpp2il_attrs_out\Core.dll" -o "%TEMP%\cpp2il_attrs_decomp_core"
ilspycmd -p "%TEMP%\cpp2il_attrs_out\Ankama.Dofus.Protocol.Game.dll" -o "%TEMP%\cpp2il_attrs_decomp"

# 2. Index
python dofus-app/scripts/index-cpp2il-attrs.py "%TEMP%\cpp2il_attrs_decomp_core" dofus-app/data/indexed/core.classes.json Core
python dofus-app/scripts/index-cpp2il-attrs.py "%TEMP%\cpp2il_attrs_decomp" dofus-app/data/indexed/protocol-game.classes.json Ankama.Dofus.Protocol.Game

# 3. Enrich + rename table
python dofus-app/scripts/enrich-deobmap-with-rva.py
python dofus-app/scripts/build-frida-rename-table.py
```

À refaire à chaque update Dofus (les RVA changent).

## Étape suivante

Avec cette base on peut maintenant :

1. **Voie A — Match Dofus 2 community .proto** (1-2h, offline) — donne les noms
   `.proto` réels des 1323 messages. Combiné à cet index → mapping protocole
   complet.
2. **Rename layer Frida** (1h) — consume `frida-rename-table.json` pour
   afficher les noms réels partout dans le toolkit. UX énorme.
3. **`gbe` singleton dump** (30 min, read-only sûr) — confirme runtime la
   topologie statique des handlers.
