# Frida IL2CPP Toolkit — Localhost App (v2.0)

## Quick start

```bash
cd app
npm install
npm run dev
```

Then open http://localhost:5173 in your browser.

The agent (`build/rpc-agent.js`) must be built first:

```bash
cd ..
npm run build:rpc
```

## Architecture

See `docs/superpowers/specs/2026-05-06-frida-toolkit-localhost-webapp-design.md`.

## Known limitations

### Frida `method.implementation` vtable cross-talk

Hooks installed via `method.implementation = wrapper` patch the IL2CPP method's
vtable slot. When a method is shared via inheritance or interface dispatch
(e.g., property getters like `get_kamas` on a class that inherits from a
base type also implemented by `System.Reflection.RuntimeParameterInfo`),
the wrapper fires for ALL types reaching that slot — not just the target.

The auto-revert protection catches lookup errors and uninstalls the hook
to keep the game stable. But for hot getters/setters and interface
methods, prefer hooking the **callers** rather than the property accessor
itself.

If you see `auto-reverted (lookup-error)` in the Hook Log Stream right after
installing a hook, it's likely a vtable cross-talk. Try a different method.
