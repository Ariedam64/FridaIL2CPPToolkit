# BasicPing / BasicPong — protocole keepalive Dofus

Référence du fonctionnement du heartbeat client, pour un usage futur (ex:
sender bot / autopilot qui doit s'aligner sur le rythme officiel pour ne pas
se faire spotter).

## Frames

| Obf | Friendly | Direction |
|---|---|---|
| `jsa` | `BasicPing` | OUT |
| `jsb` | `BasicPong` | IN |

### `jsa` (BasicPing) — fields

```
elyq : null         (réservé)
elys : null         (réservé)
elyu : bool false   (constant — peut-être `isAfk` / `isPaused`, à confirmer)
elyw : bool true    (constant — peut-être `windowFocused`, à confirmer)
```

### `jsb` (BasicPong) — fields

```
elyy : null         (réservé)
elza : bool true    (constant — `acknowledged`)
```

Réponse serveur en ~30-40 ms (très peu de variance).

## Timing — comportement réel observé

**C'est PAS un timer périodique fixe**, contrairement à ce qu'on pourrait
croire. C'est un **heartbeat à 5s avec activity-gating** :

- Le client a un tick interne **toutes les ~5 secondes**
- Sur chaque tick : check "y a-t-il eu **au moins une frame** échangée
  (out OU in, peu importe la classe) depuis le dernier ping fired ?"
  - Oui → `jsa` est envoyé, le compteur d'activité est reset
  - Non → tick silencieux, on attend le tick suivant

### Conséquence

- Si tu spamme des actions → un `jsa` part toutes les ~5.0s pile
- Si tu restes idle → **plus aucun `jsa` ne part** jusqu'à ce qu'une frame
  passe (action client OU push serveur non sollicité)
- Dès qu'une frame passe après une période idle, le `jsa` fire au prochain
  tick 5s (donc entre 0 et 5s de délai après l'activité)

### Vérification empirique

Capture observée sur ~50 secondes avec 28s d'idle au milieu :

```
ping #1  T=0      ← activité juste avant
ping #2  T=30058  ← +30s (le user était idle, tick suppressed pendant 25s)
ping #3  T=35062  ← +5004ms (5s pile après #2, activité dense)
ping #4  T=40067  ← +5005ms
ping #5  T=45082  ← +5015ms
ping #6  T=50092  ← +5010ms
```

## Pourquoi c'est gated par activité

Optimisation : tant qu'aucun paquet ne transite (TCP idle complet),
inutile de maintenir un keepalive applicatif — c'est le keepalive TCP qui
gère la coupure éventuelle. Le `jsa` ne sert qu'à valider que la couche
application ne s'est pas freezée pendant que la session était active.

## Implications pour un sender / bot

Si on construit un sender automatisé :

1. **Pas besoin de générer manuellement les `jsa`** — le client le fait
   tout seul tant qu'on envoie des frames "réelles" (déplacements,
   interactions, etc.)
2. **Si on bypasse le client** (forge directe via Frida) et qu'on veut
   simuler une présence active, il faut envoyer un `jsa` toutes les 5s
   pendant l'activité simulée
3. **Pour rester "discret"**, ne JAMAIS spammer des `jsa` plus rapidement
   que 5s — ça serait le seul comportement détectable côté serveur. Le
   throttle 5s + activity-gate est très spécifique au client officiel.
4. Si on simule de l'idle sans activity, ne pas envoyer de `jsa` du tout.

## Référence dans le LabelStore

Renames déjà appliqués :
- class `jsa` → `BasicPing`
- class `jsb` → `BasicPong`

Les fields `elyu`, `elyw`, `elza` n'ont pas de label (constants, sémantique
non confirmée). Peuvent être renommés après tests :
- minimiser/AFK la fenêtre Dofus pendant un ping → check si `elyw` ou
  `elyu` flippe
