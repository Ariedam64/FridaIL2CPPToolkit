# Frida IL2CPP Toolkit — VSCode extension demo

Mini extension qui se connecte à ton RPC Frida existant et expose :

- Sidebar avec **Process Explorer** (assemblies → namespaces → classes)
- Sidebar avec **Active Hooks** (placeholder pour démo)
- Status bar avec état de connexion
- Webview détail de classe au clic
- Commandes accessibles via **Ctrl+Shift+P** :
  - `Frida: Search class`
  - `Frida: Rename class`
  - `Frida: Dump class details`
  - `Frida: Toggle obfuscated names`
  - `Frida: Refresh explorer`
- Renames in-memory (non persistés dans cette démo)

## Installation

```bash
cd dofus-app/vscode-extension
npm install
npm run compile
```

Puis dans VSCode :

1. Ouvre le dossier `dofus-app/vscode-extension/` dans VSCode
2. Appuie **F5** → ouvre une fenêtre "Extension Development Host"
3. Dans cette fenêtre, l'extension est active
4. Clic sur l'icône ⚡ dans la barre latérale gauche → ta sidebar Frida apparaît

L'agent Frida doit tourner sur `localhost:3001/api/call` (ajustable via `Settings → Frida IL2CPP Toolkit`).

## Limitations de cette démo

C'est une preuve de concept ~350 LOC. Manque pour vraie utilité :

- Persistance des labels dans un fichier (JSON par build-guid)
- Hook lifecycle complet (install/uninstall/edit)
- Network sniffer panel
- Object inspector
- Search avancée (fuzzy, par signature)
- Bookmarks / notes / tags persistés
- Profile system

L'idée est juste de te montrer le rendu visuel pour que tu décides si VSCode est la bonne plateforme.
