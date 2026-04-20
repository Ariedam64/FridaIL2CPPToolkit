# Frida IL2CPP Toolkit

Boîte à outils TypeScript pour modder des jeux Unity IL2CPP avec [Frida](https://frida.re) et [frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge).

Chaque outil est un petit script autonome à compiler puis charger dans un process cible. Les helpers réutilisables vivent dans [src/lib/](src/lib/) et sont importés par les outils.

## Installation

```bash
cd F:/FridaIL2CPPToolkit
npm install
```

Pré-requis globaux (installés une fois par machine) :

```bash
pip install frida-tools      # donne frida, frida-ps, frida-trace
```

## Architecture

```
src/
├── lib/        ← helpers composables (findClass, hook, patch, invoke, dump…)
├── tools/      ← scripts one-shot, un fichier = un outil
└── presets/    ← configs par jeu cible (noms de classes, champs à surveiller)
```

Chaque `tools/*.ts` commence par un bloc **CONFIG** que tu édites avant de builder — c'est là que tu dis quelle classe hooker, quel champ patcher, etc. Le watch mode (`npm run watch:*`) recompile à chaque sauvegarde, donc tu itères sans relancer quoi que ce soit.

## Workflow type

```text
┌─ 1. analyze ────→  quelles assemblies / combien de classes / MonoBehaviours ?
├─ 2. find-class ──→  où est "Player", "Inventory", "GameManager" ?
├─ 3. dump-instance → attraper une instance vivante + lister tous ses champs
├─ 4. hook-generic → logger les appels d'une méthode pour comprendre les données
├─ 5. patch-values → forcer health=9999, gold=999999, godmode
├─ 6. invoke ──────→ appeler une méthode du jeu à la demande
└─ 99. rpc-agent ──→ agent unique piloté depuis un hôte Node (usage avancé)
```

## Utilisation

### 1. Compile l'outil voulu

```bash
npm run build:analyze      # build one-shot
npm run watch:hook         # recompile à chaque save (dev loop)
```

### 2. Lance-le contre le process cible

```bash
frida -l build/analyze.js -n FridaCobaye.exe --no-pause
```

- `-n <nom>` : attache à un process par nom (cherche avec `frida-ps`)
- `-f <exe>` : lance le binaire et attache au démarrage (utile si le script doit voir l'init)
- `-l <script>` : charge le bundle compilé
- `--no-pause` : ne fige pas le process (sinon il attend un `%resume`)

### 3. Édite la config en haut du script, ré-enregistre, relance

Les `tools/*.ts` ont tous une section `// === CONFIG ===` en tête. Change les constantes, frida-compile recompile (si watch), relance Frida.

## Outils — résumé

| Outil | Rôle | Fichier |
|---|---|---|
| `analyze` | Inventaire global du runtime (assemblies, classes, MonoBehaviours) | [src/tools/01-analyze.ts](src/tools/01-analyze.ts) |
| `find-class` | Recherche regex de classes/méthodes/champs | [src/tools/02-find-class.ts](src/tools/02-find-class.ts) |
| `dump-instance` | Capture une instance via hook et dump tous ses champs | [src/tools/03-dump-instance.ts](src/tools/03-dump-instance.ts) |
| `hook-generic` | Log-hook générique sur n'importe quelle méthode | [src/tools/04-hook-generic.ts](src/tools/04-hook-generic.ts) |
| `patch-values` | Forcer des valeurs de champs (live) | [src/tools/05-patch-values.ts](src/tools/05-patch-values.ts) |
| `invoke` | Appeler une méthode du jeu depuis Frida | [src/tools/06-invoke.ts](src/tools/06-invoke.ts) |
| `rpc-agent` | Agent persistant exposant la lib via RPC | [src/tools/99-rpc-agent.ts](src/tools/99-rpc-agent.ts) |

Chaque outil a un bloc de doc détaillé en tête de son fichier (exemples, pièges, sortie attendue).

## Presets

Quand tu bosses régulièrement sur un jeu, crée [src/presets/monjeu.ts](src/presets/) avec les noms de classes / champs cibles, et importe-le depuis les tools au lieu de hardcoder. Exemple : [src/presets/fridacobaye.ts](src/presets/fridacobaye.ts).

## Pièges IL2CPP à connaître

- **Inlining** : les petites méthodes sont compilées inline dans leurs callers → le hook s'installe mais ne fire jamais. Hooke le caller, ou une feuille (crypto, net, I/O).
- **`Il2Cpp.gc.choose()` sur MonoBehaviour** : souvent vide car les GameObjects vivent côté natif Unity. Utilise `dump-instance` (capture via hook) à la place.
- **Stripping** : en prod, Unity vire les classes non référencées. Si `find-class` retourne rien, la classe a peut-être été éliminée ou renommée par un obfuscateur.
- **Génériques** : les méthodes génériques ont un `<T>` dans leur signature et il peut y avoir plusieurs instanciations côté natif. `klass.methods` les liste toutes.

## Ressources

- [frida-il2cpp-bridge docs](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
- [Il2CppDumper](https://github.com/Perfare/Il2CppDumper) — dump statique préalable conseillé
- [Il2CppInspector](https://github.com/djkaty/Il2CppInspector) — alternative plus poussée
