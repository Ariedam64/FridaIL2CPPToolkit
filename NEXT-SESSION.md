# Frida IL2CPP Toolkit — Reprise de session

> Aide-mémoire pour reprendre le projet plus tard. État au **2026-04-30**.
> Branche : [`toolkit-core-v1`](https://github.com/Ariedam64/FridaIL2CPPToolkit/tree/toolkit-core-v1) — tag `v1.0.0-core`.

---

## Ce qu'on a fait

### Toolkit Core v1 — VSCode extension générique pour reverse IL2CPP

L'idée : remplacer le bricolage de scripts Frida par un toolkit pro, simple, et extensible. Le tout dans une **extension VSCode** sous `dofus-app/vscode-extension/`.

**Ce qui marche** :
- **Profile par build** stocké sous `~/.frida-toolkit/profiles/<game>/<build-id>/` — détection automatique du build via `boot.config` Unity ou hash du metadata.
- **Renommage live** des classes/méthodes/fields obfusqués → noms réels persistants (avec undo/redo, atomic writes, backup-on-corruption).
- **Process Explorer** : tree assemblies → namespaces → classes, clic ouvre un webview détail.
- **Bookmarks + notes** markdown par classe.
- **Recherche universelle** Quick Pick (`Ctrl+Shift+F`).
- **Migration auto** entre 2 builds : à chaque attache d'un nouveau build, les labels existants sont auto-migrés (token IL2CPP + fingerprint structurel), avec un panel "Migrations" pour reviewer les ambigus.
- **Mode direct** : l'extension parle à Frida **directement** via `frida-node`. Plus besoin de lancer un serveur HTTP manuellement — clic sur "Frida: Attach to process..." et c'est parti.
- **Tests** : 36/36 vitest passants sur les modules purs (labels, annotations, migrations, profile, detect).

**Comment l'utiliser** :
```bash
cd /f/FridaIL2CPPToolkit && npm run build:rpc          # build l'agent une fois
cd dofus-app/vscode-extension && npm install           # deps de l'extension
code .                                                  # ouvre l'extension
# F5 dans VSCode → fenêtre "[Extension Development Host]" s'ouvre
# Ctrl+Shift+P → "Frida: Attach to process..." → pick ton jeu
```

**Architecture** :
```
src/rpc-agent/                  # backend Frida (existant + filesystem.ts + fingerprints.ts)
dofus-app/vscode-extension/     # nouveau frontend VSCode
├── src/core/                   # foundation (profile, labels, annotations, migrations, ...)
├── src/extension.ts            # activate() — wiring slim
├── test/                       # vitest unit tests
└── package.json                # extension manifest
```

**Docs détaillées** :
- Spec design : [`docs/superpowers/specs/2026-04-30-frida-il2cpp-toolkit-core-design.md`](docs/superpowers/specs/2026-04-30-frida-il2cpp-toolkit-core-design.md)
- Plan d'implém : [`docs/superpowers/plans/2026-04-30-frida-il2cpp-toolkit-core.md`](docs/superpowers/plans/2026-04-30-frida-il2cpp-toolkit-core.md)
- Smoke test : [`dofus-app/vscode-extension/SMOKE-TEST.md`](dofus-app/vscode-extension/SMOKE-TEST.md)

---

## Ce qui reste à faire — par ordre de priorité

### Court terme — tech debt v1 (~1 jour)

Petites finitions à boucler avant d'attaquer les plugins. Notées dans la review finale du sprint :

1. **Migration review webview** — le command `frida.openMigrationReview` est référencé dans le tree provider mais son handler n'est pas câblé. Cliquer une entrée "Review" dans le panel Migrations ne fait rien. ~30 min.
2. **Search prefix filters** — `:class`, `:method`, `:field`, `:rva` sont dans le placeholder text mais pas implémentés (la search ne filtre pas par préfixe). ~1h.
3. **Auto-save debounce 500ms** — actuellement chaque rename flush immédiatement (fonctionne mais I/O pas coalescé). ~30 min.
4. **`~` expansion dans `profileRoot` setting** — si le user met `~/foo`, ça crée littéralement un dossier `~`. ~10 min.
5. **`manifest.stats` jamais mis à jour** — totalLabels/Bookmarks/Notes restent à 0 dans le manifest. ~15 min.
6. **Per-plugin storage in-memory** — `CoreApi.storage()` retourne du in-memory ; à brancher sur disque dans `<profile>/plugins/<id>/` avant que les vrais plugins arrivent.

### Moyen terme — backend Frida cleanup (~1 semaine)

L'agent Frida (`src/rpc-agent/`) marche mais a du legacy de bidouille :

- **`gc.choose` en boucle** dans plusieurs modules → freeze parfois le jeu (déjà documenté dans la mémoire claude `feedback_dofus2_dead_features`).
- **Pas de cache de singletons** : chaque RPC re-explore l'IL2CPP from scratch alors qu'on pourrait cacher les managers/services au boot.
- **Modules Dofus-spécifiques** (`gbe-router`, `gbe-probe`, `datacenter`) mélangés au core agent → ils devraient migrer dans un futur plugin Dofus séparé pour que l'agent reste vraiment générique IL2CPP.
- **Error handling hétérogène** : certains modules throw, d'autres return null/empty.

### Long terme — Plugins (la roadmap "fun")

Le Core est pensé comme une **plateforme**. Les vrais outils du quotidien viennent en plugins :

- **v1.1 Plugin Hooks** (~1 semaine) — UI de gestion des hooks, templates (log args, modify return), hot-reload, persistance.
- **v1.2 Plugin Network** (~1.5 semaines) — sniffer Protobuf intégré (style Wireshark), decoder par message via le schéma déjà extrait, rename messages/fields live.
- **v1.3 Plugin Deobfusc engine** (~1 semaine) — auto-suggestion de labels via compiler-gen leaks + type-refs + hiérarchie + strings inlined.
- **v1.4 Plugin Scripts** (~1-2 semaines) — système d'automation type AutoZaap / AutoTravel, écrits en TS avec accès direct aux objets nommés.
- **v2** — refactor en extensions VSCode séparées (publication marketplace).

---

## Pour reprendre

```bash
# Cloner / pull
cd /f/FridaIL2CPPToolkit
git checkout toolkit-core-v1
git pull

# Build l'agent (si pas déjà fait)
npm run build:rpc

# Ouvrir l'extension dans VSCode
cd dofus-app/vscode-extension
npm install
code .

# F5 → ça lance l'Extension Development Host
# Ctrl+Shift+P → "Frida: Attach to process..."
```

**Pour décider quoi faire en premier** :
- Si tu veux **livrer un v1.0 propre** → fais le tech debt court terme d'abord.
- Si tu veux **les vraies fonctionnalités** (hooks visuels, sniffer protocole) → attaque directement v1.1 Plugin Hooks, le tech debt peut attendre.
- Si tu veux **un agent stable à long terme** → fais le backend cleanup, mais c'est moins visible côté UX.

Ma reco : **v1.1 Plugin Hooks** en premier. C'est le plus utile au quotidien et ça forcera à valider la Plugin API (qui pour l'instant n'a aucun consommateur réel).

---

## État Git

- Branche : `toolkit-core-v1` (pushée sur `origin`)
- Tag : `v1.0.0-core` (pushé)
- Commits depuis le plan : 22
- Tests : 36/36 ✅
- Compilation : clean ✅
