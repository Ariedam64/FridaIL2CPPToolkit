# Game Plugin System (v1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a v1.5 "Game Plugin System" that lets each game have its own folder under `app/plugins/<id>/` contributing a frontend page (with internal sub-tabs) + optional backend HTTP routes, discovered automatically via vite glob (frontend) and an explicit registry (backend).

**Architecture:** Plugins are bundled at vite build time. Frontend uses `import.meta.glob("../../plugins/*/manifest.ts", {eager:true})` to discover manifests; backend uses a hand-maintained `PLUGIN_BACKENDS` array. Each plugin contributes one nav icon, one root page, and zero or more `/api/<id>/*` routes. The page is mounted only when `profile.gameName === plugin.gameName`; otherwise a "attach to <gameName> first" notice is shown.

**Tech Stack:** TypeScript 5.5, vite 5, vitest 2, Express 4, supertest 7, happy-dom 20.

**Spec:** [docs/superpowers/specs/2026-05-07-frida-toolkit-game-plugin-system-design.md](../specs/2026-05-07-frida-toolkit-game-plugin-system-design.md)

**File map:**

| File | Created by Task | Role |
|---|---|---|
| `app/frontend/core/plugin-types.ts` | T1 | Types `GamePlugin`, `PluginPageModule`, `PluginPageContext`, factory `defineGamePlugin`, exported `BUILTIN_TABS` |
| `app/frontend/core/plugin-host.ts` | T2 | Vite glob discovery + `createRegistry(modules)` factory + `listPlugins()`/`getPlugin(id)` |
| `app/frontend/components/plugin-not-attached.ts` | T3 | Notice component "attach to <gameName> first" |
| `app/frontend/components/nav-icons.ts` (modify) | T4 | Append plugin icons after built-ins, with separator |
| `app/frontend/core/mount-plugin-page.ts` | T5 | Async helper `mountPluginPage(host, plugin, profile)` |
| `app/frontend/main.ts` (modify) | T6 | Wire `mountPluginPage` into router; re-mount on profile change |
| `app/backend/plugins/registry.ts` | T7 | `PLUGIN_BACKENDS` array (initially empty) + types |
| `app/backend/server.ts` (modify) | T7 | Mount loop with per-plugin try/catch |
| `app/plugins/dofus/manifest.ts` | T8 | First plugin manifest |
| `app/plugins/dofus/pages/root.ts` | T8 | Root page with sub-tabs Map/Items/State (placeholders) |
| `app/frontend/core/icons.ts` (modify) | T8 | Add `crown` icon for the Dofus nav |
| `app/plugins/dofus/routes/index.ts` | T9 | Backend route stub `GET /api/dofus/map/current` |
| `app/backend/plugins/registry.ts` (modify) | T9 | Add Dofus entry to `PLUGIN_BACKENDS` |
| `app/test/frontend/core/plugin-host.test.ts` | T2 | 4 tests |
| `app/test/frontend/components/plugin-not-attached.test.ts` | T3 | 3 tests |
| `app/test/frontend/core/mount-plugin-page.test.ts` | T5 | 4 tests |
| `app/test/backend/plugins-registry.test.ts` | T7 | 3 tests |
| `app/test/plugins/dofus/manifest.test.ts` | T8 | 2 tests |
| `app/test/plugins/dofus/routes.test.ts` | T9 | 4 tests |
| `app/SMOKE-TEST.md` (modify) | T10 | Append v1.5 smoke checklist |

---

## Task 1: Plugin types + factory

**Files:**
- Create: `app/frontend/core/plugin-types.ts`
- Test: `app/test/frontend/core/plugin-types.test.ts`

- [ ] **Step 1: Create `plugin-types.ts`**

`app/frontend/core/plugin-types.ts`:

```ts
// Game Plugin System — shared types.
// Imported by plugin-host, mount-plugin-page, nav-icons, every plugin manifest.

export interface GamePlugin {
    /** Unique slug, used as the nav tab id and route hash, e.g. "dofus". */
    id: string;
    /** Human-friendly name shown in nav title and notice messages. */
    displayName: string;
    /** Matches profile.manifest.gameName. The plugin page is only mounted when these match. */
    gameName: string;
    /** Key from icons.ts catalog (e.g. "crown", "box"). Resolved at render time. */
    navIcon: string;
    /** Lazy-loaded root page. Vite code-splits it into a separate chunk. */
    rootPage: () => Promise<{ default: PluginPageModule }>;
}

export interface PluginPageModule {
    /** Mount the plugin's root page into `host`. The plugin owns the layout. */
    mount(host: HTMLElement, ctx: PluginPageContext): void;
}

export interface PluginPageContext {
    /** Currently attached profile (gameName already verified to match plugin.gameName). */
    profile: { gameName: string; buildId: string };
    /** Sub-tab key parsed from the URL hash, e.g. "map" if hash is "#/dofus?sub=map". */
    currentSubTab: string | null;
    /** Updates location.hash to "#/<plugin.id>?sub=<key>", triggering a re-mount. */
    setSubTab(key: string): void;
}

/** Identity factory — typed for inference; runtime is pass-through. */
export function defineGamePlugin(p: GamePlugin): GamePlugin {
    return p;
}

/**
 * Tabs reserved by the toolkit core. A plugin with one of these ids is rejected
 * by the host with a console warning.
 */
export const BUILTIN_TABS: ReadonlySet<string> = new Set([
    "explorer", "hooks", "network", "bookmarks", "migrations", "instances", "scripts",
]);
```

- [ ] **Step 2: Write smoke tests**

`app/test/frontend/core/plugin-types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineGamePlugin, BUILTIN_TABS } from "../../../frontend/core/plugin-types";

describe("plugin-types", () => {
    it("defineGamePlugin is identity (returns the input unchanged)", () => {
        const p = defineGamePlugin({
            id: "test",
            displayName: "Test",
            gameName: "test",
            navIcon: "box",
            rootPage: async () => ({ default: { mount: () => undefined } }),
        });
        expect(p.id).toBe("test");
        expect(typeof p.rootPage).toBe("function");
    });

    it("BUILTIN_TABS includes the 7 known toolkit tabs", () => {
        expect(BUILTIN_TABS.has("explorer")).toBe(true);
        expect(BUILTIN_TABS.has("hooks")).toBe(true);
        expect(BUILTIN_TABS.has("network")).toBe(true);
        expect(BUILTIN_TABS.has("bookmarks")).toBe(true);
        expect(BUILTIN_TABS.has("migrations")).toBe(true);
        expect(BUILTIN_TABS.has("instances")).toBe(true);
        expect(BUILTIN_TABS.has("scripts")).toBe(true);
    });

    it("BUILTIN_TABS does NOT include arbitrary plugin ids", () => {
        expect(BUILTIN_TABS.has("dofus")).toBe(false);
        expect(BUILTIN_TABS.has("tof")).toBe(false);
    });
});
```

- [ ] **Step 3: Run tests**

```bash
cd app && npx vitest run test/frontend/core/plugin-types.test.ts
```

Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/core/plugin-types.ts app/test/frontend/core/plugin-types.test.ts
git commit -m "feat(plugins): plugin-types — GamePlugin/PluginPageContext/defineGamePlugin + BUILTIN_TABS"
```

---

## Task 2: Plugin host (discovery via vite glob)

**Files:**
- Create: `app/frontend/core/plugin-host.ts`
- Test: `app/test/frontend/core/plugin-host.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/frontend/core/plugin-host.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRegistry } from "../../../frontend/core/plugin-host";
import type { GamePlugin } from "../../../frontend/core/plugin-types";

const fakePlugin = (id: string): GamePlugin => ({
    id,
    displayName: id,
    gameName: id,
    navIcon: "box",
    rootPage: async () => ({ default: { mount: () => undefined } }),
});

describe("plugin-host createRegistry", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("loads valid manifests into the registry", () => {
        const reg = createRegistry({
            "/path/dofus/manifest.ts": { default: fakePlugin("dofus") },
            "/path/tof/manifest.ts":   { default: fakePlugin("tof") },
        });
        expect(reg.size).toBe(2);
        expect(reg.get("dofus")?.id).toBe("dofus");
        expect(reg.get("tof")?.id).toBe("tof");
    });

    it("rejects plugins whose id collides with a built-in tab", () => {
        const reg = createRegistry({
            "/path/hooks/manifest.ts": { default: fakePlugin("hooks") },
            "/path/dofus/manifest.ts": { default: fakePlugin("dofus") },
        });
        expect(reg.has("hooks")).toBe(false);
        expect(reg.has("dofus")).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/built-in.*hooks/));
    });

    it("rejects duplicate ids (keeps the first, warns on the rest)", () => {
        const reg = createRegistry({
            "/path/a/manifest.ts": { default: fakePlugin("dup") },
            "/path/b/manifest.ts": { default: { ...fakePlugin("dup"), displayName: "Second" } },
        });
        expect(reg.size).toBe(1);
        expect(reg.get("dup")?.displayName).toBe("dup");  // first one kept
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/duplicate.*dup/));
    });

    it("returns empty registry when no modules", () => {
        const reg = createRegistry({});
        expect(reg.size).toBe(0);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/frontend/core/plugin-host.test.ts
```

Expected: ALL FAIL (file does not exist).

- [ ] **Step 3: Implement `plugin-host.ts`**

`app/frontend/core/plugin-host.ts`:

```ts
import { BUILTIN_TABS, type GamePlugin } from "./plugin-types";

/**
 * Build a registry from a glob result. Pure factory — testable without vite.
 * Order of iteration follows the input modules object (insertion order),
 * so the "first wins" rule for duplicates is deterministic.
 */
export function createRegistry(
    modules: Record<string, { default: GamePlugin }>,
): Map<string, GamePlugin> {
    const map = new Map<string, GamePlugin>();
    for (const m of Object.values(modules)) {
        const p = m.default;
        if (BUILTIN_TABS.has(p.id)) {
            console.warn(`[plugin-host] plugin id '${p.id}' collides with a built-in tab, skipping`);
            continue;
        }
        if (map.has(p.id)) {
            console.warn(`[plugin-host] duplicate plugin id '${p.id}', skipping`);
            continue;
        }
        map.set(p.id, p);
    }
    return map;
}

// Vite eager glob: all manifests are evaluated at build time.
const modules = import.meta.glob<{ default: GamePlugin }>(
    "../../plugins/*/manifest.ts",
    { eager: true },
);

const PLUGINS = createRegistry(modules);

export function listPlugins(): GamePlugin[] {
    return Array.from(PLUGINS.values());
}

export function getPlugin(id: string): GamePlugin | null {
    return PLUGINS.get(id) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run test/frontend/core/plugin-host.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/core/plugin-host.ts app/test/frontend/core/plugin-host.test.ts
git commit -m "feat(plugins): plugin-host — createRegistry + vite glob discovery + collision detection"
```

---

## Task 3: PluginNotAttached notice component

**Files:**
- Create: `app/frontend/components/plugin-not-attached.ts`
- Test: `app/test/frontend/components/plugin-not-attached.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/frontend/components/plugin-not-attached.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { renderPluginNotAttached } from "../../../frontend/components/plugin-not-attached";
import type { GamePlugin } from "../../../frontend/core/plugin-types";

const dummyPlugin: GamePlugin = {
    id: "dofus", displayName: "Dofus", gameName: "dofus", navIcon: "crown",
    rootPage: async () => ({ default: { mount: () => undefined } }),
};

describe("renderPluginNotAttached", () => {
    let host: HTMLElement;
    let onAttachClick: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        const window = new Window();
        host = (window.document as unknown as Document).createElement("div") as unknown as HTMLElement;
        onAttachClick = vi.fn();
    });

    it("renders the 'no process attached' message when currentGameName is null", () => {
        renderPluginNotAttached(host, { plugin: dummyPlugin, currentGameName: null, onAttachClick });
        expect(host.textContent).toContain("Dofus plugin");
        expect(host.textContent).toContain("dofus");
        expect(host.textContent?.toLowerCase()).toContain("no process attached");
    });

    it("renders the 'currently attached to X' message when gameName mismatches", () => {
        renderPluginNotAttached(host, { plugin: dummyPlugin, currentGameName: "tof", onAttachClick });
        expect(host.textContent).toContain("Currently attached to");
        expect(host.textContent).toContain("tof");
    });

    it("attach button click invokes onAttachClick", () => {
        renderPluginNotAttached(host, { plugin: dummyPlugin, currentGameName: null, onAttachClick });
        const btn = host.querySelector<HTMLButtonElement>("[data-testid='attach-btn']")!;
        btn.click();
        expect(onAttachClick).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/frontend/components/plugin-not-attached.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `plugin-not-attached.ts`**

`app/frontend/components/plugin-not-attached.ts`:

```ts
import type { GamePlugin } from "../core/plugin-types";

export interface PluginNotAttachedOpts {
    plugin: GamePlugin;
    currentGameName: string | null;
    onAttachClick: () => void;
}

export function renderPluginNotAttached(host: HTMLElement, opts: PluginNotAttachedOpts): void {
    const { plugin, currentGameName, onAttachClick } = opts;
    const detail = currentGameName
        ? `Currently attached to <code>${escapeHtml(currentGameName)}</code>.`
        : `No process attached.`;

    host.innerHTML = `
        <div style="margin:auto;padding:32px;max-width:520px;text-align:center">
            <h2 style="margin-top:0">${escapeHtml(plugin.displayName)} plugin</h2>
            <p>This plugin requires attaching to <code>${escapeHtml(plugin.gameName)}</code>.</p>
            <p style="color:var(--text-faint)">${detail}</p>
            <button data-testid="attach-btn" class="btn primary" style="margin-top:16px">Attach to a process…</button>
        </div>
    `;

    host.querySelector<HTMLButtonElement>("[data-testid='attach-btn']")!
        .addEventListener("click", () => onAttachClick());
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
    ));
}
```

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/frontend/components/plugin-not-attached.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/components/plugin-not-attached.ts app/test/frontend/components/plugin-not-attached.test.ts
git commit -m "feat(plugins): plugin-not-attached notice component"
```

---

## Task 4: Nav icons — append plugin entries

**Files:**
- Modify: `app/frontend/components/nav-icons.ts`
- (No new test file — covered by integration in T6 smoke)

- [ ] **Step 1: Read existing `nav-icons.ts`**

```bash
cat app/frontend/components/nav-icons.ts
```

Confirm the structure: a `NavTab` union type, a `renderNavIcons(host, cfg)` function with hardcoded built-in icons, click handlers wired by `data-tab`.

- [ ] **Step 2: Modify `nav-icons.ts` to append plugin icons**

Replace the entire file contents with:

```ts
// app/frontend/components/nav-icons.ts
import { icons } from "../core/icons.js";
import { listPlugins } from "../core/plugin-host.js";

// NavTab is a string at runtime. Built-ins are listed here for clarity, but the
// runtime type accepts any string (plugin ids extend it dynamically).
export type NavTab =
    | "explorer" | "hooks" | "network" | "bookmarks" | "migrations" | "instances" | "scripts"
    | string;

export interface NavIconsConfig {
    onSelect(tab: NavTab): void;
    badges?: Partial<Record<string, number>>;
}

export function renderNavIcons(host: HTMLElement, cfg: NavIconsConfig): { setActive(t: NavTab): void; setBadge(t: NavTab, n: number): void } {
    host.className = "nav-icons";

    const builtin = `
        <div class="nav-icon" data-tab="explorer" title="Process Explorer">${icons.box(18)}</div>
        <div class="nav-icon" data-tab="hooks" title="Hooks"><span class="badge-count" hidden></span>${icons.hook(18)}</div>
        <div class="nav-icon" data-tab="network" title="Network">${icons.network(18)}</div>
        <div class="nav-icon" data-tab="bookmarks" title="Bookmarks">${icons.star(18)}</div>
        <div class="nav-icon" data-tab="migrations" title="Migrations">${icons.refresh(18)}</div>
        <div class="nav-icon" data-tab="instances" title="Instances">${icons.crosshair(18)}</div>
        <div class="nav-icon" data-tab="scripts" title="Scripts">${icons.play(18)}</div>
    `;

    const plugins = listPlugins();
    const pluginHtml = plugins.map((p) => {
        const iconFn = (icons as Record<string, ((s: number) => string) | undefined>)[p.navIcon];
        const svg = iconFn ? iconFn(18) : `<span style="font-size:14px">?</span>`;
        return `<div class="nav-icon plugin-icon" data-tab="${escapeAttr(p.id)}" title="${escapeAttr(p.displayName)}">${svg}</div>`;
    }).join("");

    const sep = pluginHtml ? `<div class="nav-sep" style="height:8px"></div>` : "";
    host.innerHTML = builtin + sep + pluginHtml;

    let activeTab: NavTab = "explorer";

    host.querySelectorAll<HTMLElement>(".nav-icon").forEach((el) => {
        el.addEventListener("click", () => {
            const t = el.dataset.tab as NavTab;
            cfg.onSelect(t);
            setActive(t);
        });
    });

    function setActive(t: NavTab): void {
        activeTab = t;
        host.querySelectorAll<HTMLElement>(".nav-icon").forEach((el) => {
            el.classList.toggle("active", el.dataset.tab === t);
        });
    }
    function setBadge(t: NavTab, n: number): void {
        const el = host.querySelector<HTMLElement>(`.nav-icon[data-tab="${t}"] .badge-count`);
        if (!el) return;
        if (n <= 0) { el.hidden = true; }
        else { el.hidden = false; el.textContent = String(n); }
    }
    setActive(activeTab);
    if (cfg.badges) {
        for (const [t, n] of Object.entries(cfg.badges)) setBadge(t, n ?? 0);
    }
    return { setActive, setBadge };
}

function escapeAttr(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
    ));
}
```

- [ ] **Step 3: Run all frontend tests to verify no regression**

```bash
cd app && npx vitest run test/frontend/
```

Expected: all existing frontend tests pass (the nav-icons changes are additive — no built-in test depends on a closed `NavTab` union since the existing pages tests don't import the type).

- [ ] **Step 4: Type-check**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit
```

Expected: clean. The `NavTab` change to `... | string` is permissive — any existing code that passed a literal still type-checks.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/components/nav-icons.ts
git commit -m "feat(plugins): nav-icons — append plugin entries with separator after built-ins"
```

---

## Task 5: mount-plugin-page helper

**Files:**
- Create: `app/frontend/core/mount-plugin-page.ts`
- Test: `app/test/frontend/core/mount-plugin-page.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/frontend/core/mount-plugin-page.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { mountPluginPage } from "../../../frontend/core/mount-plugin-page";
import type { GamePlugin, PluginPageModule } from "../../../frontend/core/plugin-types";

function fakePlugin(rootPage: () => Promise<{ default: PluginPageModule }>): GamePlugin {
    return {
        id: "dofus", displayName: "Dofus", gameName: "dofus", navIcon: "crown",
        rootPage,
    };
}

describe("mountPluginPage", () => {
    let host: HTMLElement;
    let onAttachClick: ReturnType<typeof vi.fn>;
    let setSubTab: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        const window = new Window();
        host = (window.document as unknown as Document).createElement("div") as unknown as HTMLElement;
        (globalThis as { document?: unknown }).document = window.document;
        onAttachClick = vi.fn();
        setSubTab = vi.fn();
    });

    it("mounts the plugin's root page when profile.gameName matches", async () => {
        const pageMount = vi.fn();
        const plugin = fakePlugin(async () => ({ default: { mount: pageMount } }));

        await mountPluginPage(host, plugin, {
            profile: { gameName: "dofus", buildId: "abc123" },
            currentSubTab: "map",
            setSubTab,
            onAttachClick,
        });

        expect(pageMount).toHaveBeenCalledTimes(1);
        const ctx = pageMount.mock.calls[0][1];
        expect(ctx.profile.gameName).toBe("dofus");
        expect(ctx.currentSubTab).toBe("map");
        expect(typeof ctx.setSubTab).toBe("function");
    });

    it("renders the not-attached notice when profile is null", async () => {
        const pageMount = vi.fn();
        const plugin = fakePlugin(async () => ({ default: { mount: pageMount } }));

        await mountPluginPage(host, plugin, {
            profile: null,
            currentSubTab: null,
            setSubTab,
            onAttachClick,
        });

        expect(pageMount).not.toHaveBeenCalled();
        expect(host.textContent?.toLowerCase()).toContain("no process attached");
    });

    it("renders the not-attached notice when gameName mismatches", async () => {
        const pageMount = vi.fn();
        const plugin = fakePlugin(async () => ({ default: { mount: pageMount } }));

        await mountPluginPage(host, plugin, {
            profile: { gameName: "tof", buildId: "xyz" },
            currentSubTab: null,
            setSubTab,
            onAttachClick,
        });

        expect(pageMount).not.toHaveBeenCalled();
        expect(host.textContent).toContain("Currently attached to");
        expect(host.textContent).toContain("tof");
    });

    it("falls back to an error message if rootPage import rejects", async () => {
        const plugin = fakePlugin(async () => { throw new Error("boom: chunk load failed"); });

        await mountPluginPage(host, plugin, {
            profile: { gameName: "dofus", buildId: "abc" },
            currentSubTab: null,
            setSubTab,
            onAttachClick,
        });

        expect(host.textContent).toContain("Failed to load");
        expect(host.textContent).toContain("boom: chunk load failed");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/frontend/core/mount-plugin-page.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `mount-plugin-page.ts`**

`app/frontend/core/mount-plugin-page.ts`:

```ts
import { renderPluginNotAttached } from "../components/plugin-not-attached";
import type { GamePlugin, PluginPageContext } from "./plugin-types";

export interface MountPluginPageOpts {
    profile: { gameName: string; buildId: string } | null;
    currentSubTab: string | null;
    setSubTab: (key: string) => void;
    onAttachClick: () => void;
}

/**
 * Mounts a plugin's root page into the host element, or renders a "not attached"
 * notice when the active profile doesn't match the plugin's targetted gameName.
 *
 * Pure helper — no global state. main.ts is responsible for passing in the
 * current profile + handlers.
 */
export async function mountPluginPage(
    host: HTMLElement,
    plugin: GamePlugin,
    opts: MountPluginPageOpts,
): Promise<void> {
    if (!opts.profile || opts.profile.gameName !== plugin.gameName) {
        renderPluginNotAttached(host, {
            plugin,
            currentGameName: opts.profile?.gameName ?? null,
            onAttachClick: opts.onAttachClick,
        });
        return;
    }

    let pageModule;
    try {
        const m = await plugin.rootPage();
        pageModule = m.default;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        host.innerHTML = `
            <div style="margin:auto;padding:32px;max-width:520px;text-align:center;color:var(--text-faint)">
                <h2 style="color:#f87171">Failed to load ${escapeHtml(plugin.displayName)} plugin</h2>
                <pre style="white-space:pre-wrap;text-align:left">${escapeHtml(msg)}</pre>
            </div>
        `;
        return;
    }

    const ctx: PluginPageContext = {
        profile: opts.profile,
        currentSubTab: opts.currentSubTab,
        setSubTab: opts.setSubTab,
    };
    pageModule.mount(host, ctx);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
    ));
}
```

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/frontend/core/mount-plugin-page.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/core/mount-plugin-page.ts app/test/frontend/core/mount-plugin-page.test.ts
git commit -m "feat(plugins): mount-plugin-page helper — async, profile-checked, error-tolerant"
```

---

## Task 6: main.ts integration — wire plugins into router

**Files:**
- Modify: `app/frontend/main.ts`
- (No new test — covered by smoke in T10)

- [ ] **Step 1: Read current main.ts**

```bash
cat app/frontend/main.ts
```

Identify these spots to modify:
- Imports (top of file)
- `mountPage(tab)` function (becomes async)
- `hashchange` listener (`void mountPage(tab)`)
- Initial mount at boot (`void mountPage(initialTab)`)
- Profile event handlers (add re-mount of active plugin on profile change)

- [ ] **Step 2: Modify `main.ts`**

Apply these edits:

**Add imports** at the top alongside existing page imports:

```ts
import { getPlugin } from "./core/plugin-host.js";
import { mountPluginPage } from "./core/mount-plugin-page.js";
```

**Add a profile cache** near the top-level state. Find the line with `const sb = renderStatusBar(...)` and add right after it:

```ts
let cachedProfile: { gameName: string; buildId: string } | null = null;
```

**Update `refreshProfile`** to populate the cache. Find the existing `async function refreshProfile()` and modify to set `cachedProfile`:

```ts
async function refreshProfile(): Promise<void> {
    try {
        const { profile } = await api.getProfile();
        if (profile) {
            cachedProfile = { gameName: profile.manifest.gameName, buildId: profile.manifest.buildId };
            sb.setConnection(`${profile.manifest.gameName} / ${profile.manifest.buildId.slice(0, 8)}`, true);
            connBadge.textContent = "connected";
            connBadge.classList.remove("disconnected");
        } else {
            cachedProfile = null;
            sb.setConnection("no connection", false);
            connBadge.textContent = "disconnected";
            connBadge.classList.add("disconnected");
        }
    } catch (e) { console.warn("getProfile failed:", e); }
}
```

**Replace `mountPage`** — make it async and add the plugin fallback:

```ts
async function mountPage(tab: NavTab): Promise<void> {
    pageHost.innerHTML = "";
    pageHost.style.cssText = "";
    pageHost.style.flex = "1";
    pageHost.style.display = "flex";
    pageHost.style.minHeight = "0";

    if (tab === "explorer") return mountExplorerPage(pageHost);
    if (tab === "hooks") return mountHooksPage(pageHost);
    if (tab === "network") return mountNetworkPage(pageHost);
    if (tab === "bookmarks") return mountBookmarksPage(pageHost);
    if (tab === "migrations") return mountMigrationsPage(pageHost);
    if (tab === "instances") return mountInstancesPage(pageHost);
    if (tab === "scripts") return mountScriptsPage(pageHost);

    // Plugin fallback
    const plugin = getPlugin(tab);
    if (plugin) {
        await mountPluginPage(pageHost, plugin, {
            profile: cachedProfile,
            currentSubTab: parseSubTab(location.hash),
            setSubTab: (key) => { location.hash = `#/${plugin.id}?sub=${encodeURIComponent(key)}`; },
            onAttachClick: () => void showProcessPicker(),
        });
        return;
    }

    // Unknown tab → default to explorer
    return mountExplorerPage(pageHost);
}

function parseSubTab(hash: string): string | null {
    const m = /\?sub=([^&]+)/.exec(hash);
    return m ? decodeURIComponent(m[1]) : null;
}
```

**Update the `hashchange` listener** to use `void`:

```ts
window.addEventListener("hashchange", () => {
    const tab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
    navHandle.setActive(tab);
    void mountPage(tab);
});
```

**Update the initial mount** at the bottom of the file:

```ts
const initialTab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
navHandle.setActive(initialTab);
void mountPage(initialTab);
```

**Update navHandle's onSelect** to use `void`:

```ts
const navHandle = renderNavIcons(document.getElementById("nav-icons-host")!, {
    onSelect: (tab: NavTab) => {
        location.hash = `#/${tab}`;
        void mountPage(tab);
    },
});
```

**Add re-mount on profile change.** Replace the existing two `subscribe` calls for profile events with:

```ts
subscribe("profile-attached", () => { void refreshProfile().then(maybeRemountPlugin); });
subscribe("profile-detached", () => { void refreshProfile().then(maybeRemountPlugin); });

function maybeRemountPlugin(): void {
    const tab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
    if (getPlugin(tab)) void mountPage(tab);
}
```

- [ ] **Step 3: Run all tests + type-check + build**

```bash
cd app && npx vitest run && npx tsc -p tsconfig.frontend.json --noEmit && npm run build
```

Expected: all tests pass (no test was broken — `mountPage` returning `Promise<void>` is fine because all call sites use `void`); TS clean; build clean.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/main.ts
git commit -m "feat(plugins): main.ts — wire plugin pages, async mountPage, re-mount on profile change"
```

---

## Task 7: Backend plugin registry + server.ts mount loop

**Files:**
- Create: `app/backend/plugins/registry.ts`
- Modify: `app/backend/server.ts`
- Test: `app/test/backend/plugins-registry.test.ts`

- [ ] **Step 1: Create the empty registry**

`app/backend/plugins/registry.ts`:

```ts
import type { Express } from "express";
import type { Session } from "../session";

/**
 * Backend mount function for a plugin. Receives the Express app and the
 * shared session. The plugin should mount routes under /api/<plugin.id>/...
 */
export interface PluginBackend {
    id: string;
    mount: (app: Express, deps: PluginBackendDeps) => void;
}

export interface PluginBackendDeps {
    session: Session;
}

/**
 * Hand-maintained list of plugins that have backend routes. Add a new entry
 * here when a plugin needs server-side functionality. Plugins without backend
 * routes (frontend-only) do not need to appear in this list.
 */
export const PLUGIN_BACKENDS: PluginBackend[] = [
    // Dofus is added in T9.
];
```

- [ ] **Step 2: Write the failing tests**

`app/test/backend/plugins-registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mountAllPluginBackends } from "../../backend/plugins/registry";
import type { PluginBackend } from "../../backend/plugins/registry";

const fakeSession = {} as never;

describe("mountAllPluginBackends", () => {
    it("invokes each plugin's mount with the shared deps", () => {
        const a: PluginBackend = { id: "a", mount: vi.fn() };
        const b: PluginBackend = { id: "b", mount: vi.fn() };
        const app = express();
        mountAllPluginBackends(app, { session: fakeSession }, [a, b]);
        expect(a.mount).toHaveBeenCalledWith(app, { session: fakeSession });
        expect(b.mount).toHaveBeenCalledWith(app, { session: fakeSession });
    });

    it("isolates a failing plugin — others still mount, server still works", () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const broken: PluginBackend = {
            id: "broken",
            mount: () => { throw new Error("kaboom at mount"); },
        };
        const ok: PluginBackend = {
            id: "ok",
            mount: (app) => { app.get("/api/ok/ping", (_req, res) => res.json({ pong: true })); },
        };
        const app = express();
        mountAllPluginBackends(app, { session: fakeSession }, [broken, ok]);
        expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/broken/), expect.any(Error));
    });

    it("plugin routes are reachable after mount (smoke via supertest)", async () => {
        const plugin: PluginBackend = {
            id: "smoke",
            mount: (app) => { app.get("/api/smoke/echo", (_req, res) => res.json({ ok: true })); },
        };
        const app = express();
        mountAllPluginBackends(app, { session: fakeSession }, [plugin]);
        const r = await request(app).get("/api/smoke/echo");
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true });
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/plugins-registry.test.ts
```

Expected: ALL FAIL (`mountAllPluginBackends` not exported yet).

- [ ] **Step 4: Add `mountAllPluginBackends` to `registry.ts`**

Append to `app/backend/plugins/registry.ts`:

```ts
/**
 * Mount every plugin backend, isolating failures so one broken plugin can't
 * take down the rest of the server. The `plugins` parameter defaults to
 * `PLUGIN_BACKENDS` for production; tests can pass a custom list.
 */
export function mountAllPluginBackends(
    app: Express,
    deps: PluginBackendDeps,
    plugins: PluginBackend[] = PLUGIN_BACKENDS,
): void {
    for (const plugin of plugins) {
        try {
            plugin.mount(app, deps);
            console.log(`[plugins] mounted backend for '${plugin.id}'`);
        } catch (err) {
            console.error(`[plugins] failed to mount backend for '${plugin.id}':`, err);
        }
    }
}
```

- [ ] **Step 5: Wire into `app/backend/server.ts`**

Read the existing `server.ts` to find where the other `mountX(app, deps)` calls live (look for `mountInstances`, `mountHooks`, etc.).

Add an import at the top:

```ts
import { mountAllPluginBackends } from "./plugins/registry.js";
```

After the last existing `mountX(...)` call in the same setup block, add:

```ts
mountAllPluginBackends(app, { session });
```

- [ ] **Step 6: Run all backend tests**

```bash
cd app && npx vitest run test/backend/ && npx tsc -p tsconfig.backend.json --noEmit
```

Expected: 3 new tests + all existing pass; TS clean.

- [ ] **Step 7: Commit**

```bash
git add app/backend/plugins/registry.ts app/backend/server.ts app/test/backend/plugins-registry.test.ts
git commit -m "feat(plugins): backend registry + mountAllPluginBackends with per-plugin isolation"
```

---

## Task 8: Dofus plugin — manifest + root page + crown icon

**Files:**
- Create: `app/plugins/dofus/manifest.ts`
- Create: `app/plugins/dofus/pages/root.ts`
- Modify: `app/frontend/core/icons.ts`
- Test: `app/test/plugins/dofus/manifest.test.ts`

- [ ] **Step 1: Add the `crown` icon to `icons.ts`**

Read `app/frontend/core/icons.ts` to understand the format. Append a new entry inside the `icons = {...}` object literal (after the existing entries, before the closing brace):

```ts
    crown:      (s = 14) => svg(`<path d="M2 7l6 4 4-6 4 6 6-4-2 12H4z"/><line x1="6" y1="17" x2="18" y2="17"/>`, s),
```

- [ ] **Step 2: Create `manifest.ts`**

`app/plugins/dofus/manifest.ts`:

```ts
import { defineGamePlugin } from "../../frontend/core/plugin-types";

export default defineGamePlugin({
    id: "dofus",
    displayName: "Dofus",
    gameName: "dofus",
    navIcon: "crown",
    rootPage: () => import("./pages/root"),
});
```

- [ ] **Step 3: Create `pages/root.ts`**

`app/plugins/dofus/pages/root.ts`:

```ts
import type { PluginPageModule, PluginPageContext } from "../../../frontend/core/plugin-types";

const SUBS = ["map", "items", "state"] as const;
type Sub = typeof SUBS[number];
const DEFAULT_SUB: Sub = "map";

const mod: PluginPageModule = {
    mount(host: HTMLElement, ctx: PluginPageContext): void {
        const requested = ctx.currentSubTab;
        const sub: Sub = (requested && (SUBS as readonly string[]).includes(requested) ? requested : DEFAULT_SUB) as Sub;

        host.innerHTML = `
            <div style="display:flex;flex-direction:column;flex:1;min-height:0">
                <div data-testid="dofus-subnav" style="display:flex;gap:8px;padding:8px;border-bottom:1px solid #333">
                    ${SUBS.map((s) => `
                        <button data-sub="${s}" style="padding:4px 10px;background:${s === sub ? "#1e3a8a" : "transparent"};color:${s === sub ? "#fff" : "inherit"};border:1px solid #333;border-radius:4px;cursor:pointer">${s}</button>
                    `).join("")}
                </div>
                <div data-testid="dofus-sub-host" style="flex:1;overflow:auto;padding:16px;color:#888">
                    <p>Dofus plugin — <strong>${sub}</strong> sub-page (placeholder).</p>
                    <p>Profile: <code>${ctx.profile.gameName} / ${ctx.profile.buildId.slice(0, 8)}</code></p>
                    <p style="margin-top:24px;font-style:italic">The actual ${sub} feature ships in a follow-up sub-project.</p>
                </div>
            </div>
        `;

        host.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((btn) => {
            btn.addEventListener("click", () => ctx.setSubTab(btn.dataset.sub!));
        });
    },
};

export default mod;
```

- [ ] **Step 4: Write the failing test**

`app/test/plugins/dofus/manifest.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Window } from "happy-dom";
import dofusManifest from "../../../plugins/dofus/manifest";
import type { PluginPageContext } from "../../../frontend/core/plugin-types";

describe("dofus manifest", () => {
    it("exports a valid GamePlugin shape", () => {
        expect(dofusManifest.id).toBe("dofus");
        expect(dofusManifest.gameName).toBe("dofus");
        expect(dofusManifest.displayName).toBe("Dofus");
        expect(dofusManifest.navIcon).toBe("crown");
        expect(typeof dofusManifest.rootPage).toBe("function");
    });

    it("rootPage() lazy-resolves to a module with a mount function, which renders sub-tabs", async () => {
        const window = new Window();
        (globalThis as { document?: unknown }).document = window.document;
        const host = (window.document as unknown as Document).createElement("div") as unknown as HTMLElement;

        const m = await dofusManifest.rootPage();
        expect(typeof m.default.mount).toBe("function");

        const ctx: PluginPageContext = {
            profile: { gameName: "dofus", buildId: "abcd1234" },
            currentSubTab: null,
            setSubTab: () => undefined,
        };
        m.default.mount(host, ctx);

        const subnav = host.querySelector("[data-testid='dofus-subnav']");
        expect(subnav).not.toBeNull();
        const buttons = host.querySelectorAll("[data-sub]");
        expect(buttons.length).toBe(3);  // map, items, state
    });
});
```

- [ ] **Step 5: Run tests**

```bash
cd app && npx vitest run test/plugins/dofus/manifest.test.ts test/frontend/
```

Expected: 2 new tests pass + all existing frontend tests pass (now that a real plugin is in `app/plugins/dofus/`, `plugin-host`'s real glob will pick it up — that's expected and fine for the integration tests).

- [ ] **Step 6: Type-check + build**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit && npm run build
```

Expected: TS clean; build clean (Dofus chunk should appear in the build output).

- [ ] **Step 7: Commit**

```bash
git add app/frontend/core/icons.ts app/plugins/dofus/manifest.ts app/plugins/dofus/pages/root.ts app/test/plugins/dofus/manifest.test.ts
git commit -m "feat(plugins): dofus manifest + root page (sub-tabs placeholders) + crown icon"
```

---

## Task 9: Dofus plugin — backend route stub + register

**Files:**
- Create: `app/plugins/dofus/routes/index.ts`
- Modify: `app/backend/plugins/registry.ts`
- Test: `app/test/plugins/dofus/routes.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/plugins/dofus/routes.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mount as mountDofusRoutes } from "../../../plugins/dofus/routes";
import type { PluginBackendDeps } from "../../../backend/plugins/registry";

function makeApp(opts: { regList?: { className: string; handle: string; isAlive: boolean; key: string }[]; agentResponse?: unknown; agentThrows?: boolean } = {}): { app: express.Express } {
    const app = express();
    app.use(express.json());
    const regList = opts.regList ?? null;
    const fakeRegistry = regList ? { list: () => regList } : null;
    const deps: PluginBackendDeps = {
        session: {
            instanceRegistry: () => fakeRegistry,
            fridaClient: {
                call: vi.fn(async () => {
                    if (opts.agentThrows) throw new Error("agent boom");
                    return opts.agentResponse;
                }),
            },
        } as never,
    };
    mountDofusRoutes(app, deps);
    return { app };
}

describe("dofus routes — /api/dofus/map/current", () => {
    it("returns 503 when not attached (no instanceRegistry)", async () => {
        const { app } = makeApp({});
        const r = await request(app).get("/api/dofus/map/current");
        expect(r.status).toBe(503);
        expect(r.body.error).toMatch(/not attached/);
    });

    it("returns 404 when PlayerManager is not in the registry", async () => {
        const { app } = makeApp({ regList: [] });
        const r = await request(app).get("/api/dofus/map/current");
        expect(r.status).toBe(404);
        expect(r.body.error).toMatch(/PlayerManager/);
    });

    it("returns the mapId from the agent when PlayerManager is captured", async () => {
        const { app } = makeApp({
            regList: [{ className: "PlayerManager", handle: "0xab", isAlive: true, key: "p" }],
            agentResponse: 12345,
        });
        const r = await request(app).get("/api/dofus/map/current");
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ mapId: 12345 });
    });

    it("returns 500 when the agent throws", async () => {
        const { app } = makeApp({
            regList: [{ className: "PlayerManager", handle: "0xab", isAlive: true, key: "p" }],
            agentThrows: true,
        });
        const r = await request(app).get("/api/dofus/map/current");
        expect(r.status).toBe(500);
        expect(r.body.error).toMatch(/agent boom/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/plugins/dofus/routes.test.ts
```

Expected: ALL FAIL (`routes/index.ts` does not exist).

- [ ] **Step 3: Implement `routes/index.ts`**

`app/plugins/dofus/routes/index.ts`:

```ts
import type { Express } from "express";
import type { PluginBackendDeps } from "../../../backend/plugins/registry";

export function mount(app: Express, deps: PluginBackendDeps): void {
    /**
     * Returns the player's current mapId. Requires a PlayerManager instance
     * captured into the registry (via the Instances plugin or a script).
     */
    app.get("/api/dofus/map/current", async (_req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) {
            res.status(503).json({ error: "not attached" });
            return;
        }
        const player = reg.list().find((c) => c.className === "PlayerManager" && c.isAlive);
        if (!player) {
            res.status(404).json({ error: "PlayerManager not captured yet (open the Instances plugin to capture it)" });
            return;
        }
        try {
            const mapId = await deps.session.fridaClient.call(
                "readField",
                [player.className, player.handle, "currentMapId"],
            );
            res.json({ mapId });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
}
```

- [ ] **Step 4: Wire Dofus into the backend registry**

In `app/backend/plugins/registry.ts`, add an import at the top and an entry to `PLUGIN_BACKENDS`:

```ts
import * as dofusRoutes from "../../plugins/dofus/routes";
```

Then update the array (replace the empty version):

```ts
export const PLUGIN_BACKENDS: PluginBackend[] = [
    { id: "dofus", mount: dofusRoutes.mount },
];
```

- [ ] **Step 5: Run tests + type-check + build**

```bash
cd app && npx vitest run && npx tsc -p tsconfig.backend.json --noEmit && npm run build
```

Expected: 4 new dofus route tests + all ~352 total tests pass (329 baseline + 23 new); TS clean; build clean.

- [ ] **Step 6: Commit**

```bash
git add app/plugins/dofus/routes/index.ts app/backend/plugins/registry.ts app/test/plugins/dofus/routes.test.ts
git commit -m "feat(plugins): dofus backend route /api/dofus/map/current + register plugin backend"
```

---

## Task 10: End-to-end smoke + docs polish

**Files:**
- Modify: `app/SMOKE-TEST.md`

- [ ] **Step 1: Run the full suite + tsc + build one last time**

```bash
cd app && npx vitest run && npx tsc -p tsconfig.backend.json --noEmit && npx tsc -p tsconfig.frontend.json --noEmit && npm run build
```

Expected: all tests pass; both TS configs clean; build clean. Manual smoke on Dofus is the user's job.

- [ ] **Step 2: Append the v1.5 smoke section to `app/SMOKE-TEST.md`**

Read the existing file to confirm format, then append:

```markdown
## v1.5 Game Plugin System (2026-05-07)

This section is to be filled by the user during manual smoke testing on a real IL2CPP target.

### Setup
1. Start backend: `cd app && npm run dev`
2. Open the web-app at `http://localhost:3001`.

### Smoke checklist — without attaching
- [ ] After page load, the nav bar shows the 7 built-in icons + a small gap + the Dofus crown icon.
- [ ] Click the Dofus crown icon. The page shows the "Dofus plugin — This plugin requires attaching to dofus" notice with an "Attach to a process…" button.
- [ ] Click the "Attach to a process…" button. The process picker opens.

### Smoke checklist — attached to Dofus
1. Attach to a Dofus process via the picker.
2. Verify the status bar shows `dofus / <buildId>`.
3. Click the Dofus crown icon. The Dofus root page renders with three sub-tabs (Map, Items, State) — Map is selected by default.
- [ ] Each sub-tab click updates `location.hash` to `#/dofus?sub=<tab>` and the placeholder text changes.
- [ ] The placeholder shows the current `profile.gameName / buildId.slice(0,8)`.
- [ ] Refreshing the page on `#/dofus?sub=items` lands directly on the Items sub-tab.

### Smoke checklist — backend route
- [ ] `curl http://localhost:3001/api/dofus/map/current` returns 503 if not attached, 404 if PlayerManager not captured, or `{"mapId": <int>}` if it is.

### Smoke checklist — attaching to a non-Dofus process
1. Attach to a non-Dofus IL2CPP process (e.g., a Unity demo).
2. Click the Dofus crown icon.
- [ ] The notice now reads "Currently attached to <gameName>" (instead of "No process attached").
- [ ] The "Attach to a process…" button still works.

### Smoke checklist — plugin discovery
- [ ] Console shows `[plugins] mounted backend for 'dofus'` at server startup.
- [ ] No console warnings about duplicate plugin ids or built-in collisions.
```

- [ ] **Step 3: Commit**

```bash
git add app/SMOKE-TEST.md
git commit -m "test(plugins): smoke checklist for v1.5 game plugin system"
```

---

## Spec coverage check

| Spec section | Covered by |
|---|---|
| Architecture (file layout, 10 files) | T1–T9 |
| Manifest format + `defineGamePlugin` | T1 |
| Plugin host discovery (vite glob, collision detection) | T2 |
| Frontend mount flow (profile-checked, async, error-tolerant) | T5 |
| `mountPage` async transition + re-mount on profile change | T6 |
| Nav icons append after built-ins with separator | T4 |
| `BUILTIN_TABS` shared between plugin-host and (implicitly) nav | T1 |
| Backend registry + per-plugin isolation | T7 |
| Sub-tab navigation via URL hash | T6 (parseSubTab) + T8 (root page wiring) |
| Static asset serving (per-plugin Express routes) | T9 (route example reads from instances; no file-serving needed for v1) |
| Plugin contributing nav icon, root page, backend routes | T8 + T9 |
| First plugin: Dofus scaffolding | T8 + T9 |
| Tests (~20) | T1 (3) + T2 (4) + T3 (3) + T5 (4) + T7 (3) + T8 (2) + T9 (4) = 23 |
| Smoke checklist | T10 |

**Coverage gap notes:**
- The spec mentions an icon catalog (`icons.ts`) gaining a `crown` entry — covered in T8 step 1.
- The spec mentions `currentTab()` helper for `maybeRemountPlugin` — T6 inlines the same parsing logic instead of extracting a helper (smaller diff, single use).
- The spec's "Static assets" out-of-scope note covers T9's choice not to serve files (route returns data fetched at runtime).
- The spec's `currentProfile()` cache is the `cachedProfile` variable in T6 (not a separate module).

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-07-frida-toolkit-game-plugin-system.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review (spec then quality) after each, fast iteration.
2. **Inline Execution** — Execute tasks in this session, batch with checkpoints for review.

Which approach?
