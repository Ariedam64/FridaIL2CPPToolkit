# Frida Toolkit Localhost Web App (v2.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the VSCode extension with a localhost web app — Node.js backend (Express + WebSocket) embedding `frida-node`, Vanilla TS frontend (Vite) rendering an "IDE Pro" layout in indigo palette. Keep all existing profile / labels / annotations / hooks persistence intact.

**Architecture:** Single Node process at `localhost:3001`. HTTP `/api/*` for synchronous calls, WS `/events` for the Frida `send()` stream. Frontend is a SPA built with Vanilla TS + Vite, no React. Backend reuses ≥80% of modules from `dofus-app/vscode-extension/src/core/` by copying the vscode-free files into `app/backend/core/`.

**Tech Stack:** Node.js 20+, TypeScript, Express, `ws`, `frida-node`, Vite, Vanilla TS, vitest, supertest.

**Spec:** [`docs/superpowers/specs/2026-05-06-frida-toolkit-localhost-webapp-design.md`](../specs/2026-05-06-frida-toolkit-localhost-webapp-design.md)

**Visual reference:** [`docs/superpowers/specs/assets/2026-05-06-hybrid-mock.html`](../specs/assets/2026-05-06-hybrid-mock.html)

---

## File Structure

```
app/
├── package.json                          # backend + frontend deps + scripts
├── tsconfig.backend.json
├── tsconfig.frontend.json
├── vite.config.ts
├── README.md
├── backend/
│   ├── server.ts                         # entry — Express + WS bootstrap
│   ├── frida-client.ts                   # FridaDirectClient wrapper (reused)
│   ├── ws-bridge.ts                      # WS broadcaster
│   ├── routes/
│   │   ├── api-call.ts                   # POST /api/call → frida-client
│   │   ├── profile.ts                    # GET /api/profile, POST attach/detach
│   │   ├── labels.ts                     # POST /api/labels/...
│   │   ├── annotations.ts                # POST /api/annotations/...
│   │   ├── hooks.ts                      # POST /api/hooks/...
│   │   └── migrations.ts                 # GET /api/migrations + POST accept/reject
│   ├── session.ts                        # process-wide session state (current profile, etc.)
│   └── core/                             # COPIED vscode-free modules
│       ├── labels.ts
│       ├── annotations.ts
│       ├── profile.ts
│       ├── paths.ts
│       ├── plugin-storage.ts
│       ├── search-filters.ts
│       ├── types.ts
│       ├── detect.ts
│       ├── migrations.ts
│       └── hooks/
│           ├── hook-store.ts
│           ├── hook-spec-validation.ts
│           ├── hook-event-bus.ts
│           └── types.ts
├── frontend/
│   ├── index.html
│   ├── main.ts                           # entry point — bootstraps router + ws
│   ├── styles/
│   │   ├── theme.css                     # CSS vars (indigo, dark OLED)
│   │   ├── fonts.css                     # Google Fonts @import
│   │   └── app.css                       # layout shell + components
│   ├── core/
│   │   ├── api.ts                        # fetch wrapper for /api/*
│   │   ├── ws.ts                         # WebSocket client + dispatcher
│   │   ├── store.ts                      # global pub/sub store
│   │   ├── router.ts                     # hash-based routing
│   │   ├── tabs.ts                       # multi-tab manager
│   │   └── types.ts                      # shared types (mirror backend)
│   ├── components/
│   │   ├── nav-icons.ts
│   │   ├── process-explorer.ts
│   │   ├── class-detail.ts
│   │   ├── hook-log.ts
│   │   ├── command-palette.ts
│   │   ├── status-bar.ts
│   │   ├── breadcrumb.ts
│   │   ├── tabs-bar.ts
│   │   └── bookmarks-list.ts
│   └── pages/
│       ├── explorer.ts
│       ├── hooks.ts
│       ├── bookmarks.ts
│       └── migrations.ts
└── test/
    ├── backend/
    │   ├── routes-api-call.test.ts
    │   ├── routes-labels.test.ts
    │   ├── routes-hooks.test.ts
    │   └── ws-bridge.test.ts
    └── frontend/
        ├── store.test.ts
        ├── router.test.ts
        └── tabs.test.ts
```

The 4 test files in `app/test/backend/core/` (the copied label/annotation/profile/hooks tests from v1) just live in `app/test/backend/core/` mirroring their source files. They run via vitest unchanged.

**Ultimate cleanup**: `dofus-app/vscode-extension/` is deleted in Task 30.

---

## Working directory

All commands assume working directory `f:/FridaIL2CPPToolkit` unless otherwise specified.

---

## Task 1: Branch + scaffold app/ directory

**Files:**
- Create: `app/package.json`
- Create: `app/.gitignore`
- Create: `app/README.md`
- Create: `app/tsconfig.backend.json`
- Create: `app/tsconfig.frontend.json`

- [ ] **Step 1: Create branch**

```bash
git checkout -b localhost-v2
```

- [ ] **Step 2: Create app/package.json**

```json
{
  "name": "frida-il2cpp-toolkit-app",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -n backend,frontend -c blue,magenta \"npm:dev:backend\" \"npm:dev:frontend\"",
    "dev:backend": "tsx watch backend/server.ts",
    "dev:frontend": "vite",
    "build": "npm run build:backend && npm run build:frontend",
    "build:backend": "tsc -p tsconfig.backend.json",
    "build:frontend": "vite build",
    "start": "node dist/backend/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^4.21.0",
    "frida": "^17.9.6",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.0.0",
    "@types/supertest": "^6.0.2",
    "@types/ws": "^8.5.13",
    "concurrently": "^9.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create app/.gitignore**

```
node_modules/
dist/
.vite/
*.log
```

- [ ] **Step 4: Create app/README.md**

```markdown
# Frida IL2CPP Toolkit — Localhost App (v2.0)

## Quick start

```bash
cd app
npm install
npm run dev
```

Then open http://localhost:3001 in your browser.

The agent (`build/rpc-agent.js`) must be built first:

```bash
cd ..
npm run build:rpc
```

## Architecture

See `docs/superpowers/specs/2026-05-06-frida-toolkit-localhost-webapp-design.md`.
```

- [ ] **Step 5: Create app/tsconfig.backend.json**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "./dist/backend",
    "rootDir": "./backend",
    "declaration": false
  },
  "include": ["backend/**/*.ts"]
}
```

- [ ] **Step 6: Create app/tsconfig.frontend.json**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["frontend/**/*.ts"]
}
```

- [ ] **Step 7: Install deps**

```bash
cd app
npm install
```

Expected: clean install, no peer warnings beyond what's normal.

- [ ] **Step 8: Commit**

```bash
cd ..
git add app/package.json app/.gitignore app/README.md app/tsconfig.backend.json app/tsconfig.frontend.json
git commit -m "feat(app): scaffold v2.0 localhost app — backend+frontend dirs"
```

---

## Task 2: Copy vscode-free core modules into app/backend/core/

**Files:**
- Create: `app/backend/core/labels.ts` (copy from `dofus-app/vscode-extension/src/core/labels.ts`)
- Create: `app/backend/core/annotations.ts`
- Create: `app/backend/core/profile.ts`
- Create: `app/backend/core/paths.ts`
- Create: `app/backend/core/plugin-storage.ts`
- Create: `app/backend/core/search-filters.ts`
- Create: `app/backend/core/types.ts`
- Create: `app/backend/core/detect.ts`
- Create: `app/backend/core/migrations.ts`
- Create: `app/backend/core/rpc.ts` (the HttpRpcClient, used as a type interface)
- Create: `app/backend/core/hooks/hook-store.ts`
- Create: `app/backend/core/hooks/hook-spec-validation.ts`
- Create: `app/backend/core/hooks/hook-event-bus.ts`
- Create: `app/backend/core/hooks/types.ts`

- [ ] **Step 1: Bulk copy via shell**

```bash
mkdir -p app/backend/core/hooks app/test/backend/core/hooks

# Core modules
cp dofus-app/vscode-extension/src/core/labels.ts            app/backend/core/labels.ts
cp dofus-app/vscode-extension/src/core/annotations.ts       app/backend/core/annotations.ts
cp dofus-app/vscode-extension/src/core/profile.ts           app/backend/core/profile.ts
cp dofus-app/vscode-extension/src/core/paths.ts             app/backend/core/paths.ts
cp dofus-app/vscode-extension/src/core/plugin-storage.ts    app/backend/core/plugin-storage.ts
cp dofus-app/vscode-extension/src/core/search-filters.ts    app/backend/core/search-filters.ts
cp dofus-app/vscode-extension/src/core/types.ts             app/backend/core/types.ts
cp dofus-app/vscode-extension/src/core/detect.ts            app/backend/core/detect.ts
cp dofus-app/vscode-extension/src/core/migrations.ts        app/backend/core/migrations.ts
cp dofus-app/vscode-extension/src/core/rpc.ts               app/backend/core/rpc.ts

# Hooks plugin core modules
cp dofus-app/vscode-extension/src/plugins/hooks/hook-store.ts             app/backend/core/hooks/hook-store.ts
cp dofus-app/vscode-extension/src/plugins/hooks/hook-spec-validation.ts   app/backend/core/hooks/hook-spec-validation.ts
cp dofus-app/vscode-extension/src/plugins/hooks/hook-event-bus.ts         app/backend/core/hooks/hook-event-bus.ts
cp dofus-app/vscode-extension/src/plugins/hooks/types.ts                  app/backend/core/hooks/types.ts

# Existing tests for the copied modules
cp dofus-app/vscode-extension/test/labels.test.ts                  app/test/backend/core/labels.test.ts
cp dofus-app/vscode-extension/test/annotations.test.ts             app/test/backend/core/annotations.test.ts
cp dofus-app/vscode-extension/test/profile.test.ts                 app/test/backend/core/profile.test.ts
cp dofus-app/vscode-extension/test/paths.test.ts                   app/test/backend/core/paths.test.ts
cp dofus-app/vscode-extension/test/plugin-storage.test.ts          app/test/backend/core/plugin-storage.test.ts
cp dofus-app/vscode-extension/test/migrations.test.ts              app/test/backend/core/migrations.test.ts
cp dofus-app/vscode-extension/test/detect.test.ts                  app/test/backend/core/detect.test.ts
cp dofus-app/vscode-extension/test/search.test.ts                  app/test/backend/core/search-filters.test.ts
cp dofus-app/vscode-extension/test/plugins/hooks/hook-spec-validation.test.ts app/test/backend/core/hooks/hook-spec-validation.test.ts
cp dofus-app/vscode-extension/test/plugins/hooks/hook-store.test.ts        app/test/backend/core/hooks/hook-store.test.ts
cp dofus-app/vscode-extension/test/plugins/hooks/hook-event-bus.test.ts    app/test/backend/core/hooks/hook-event-bus.test.ts
```

- [ ] **Step 2: Update test imports**

The copied test files reference `../../src/core/...`. Update to point at the new locations.

```bash
cd app/test/backend/core
sed -i 's|\.\./\.\./\.\./src/core/|../../../backend/core/|g' *.test.ts
sed -i 's|\.\./\.\./\.\./src/plugins/hooks/|../../../backend/core/hooks/|g' hooks/*.test.ts
cd ../../..
```

(On Windows, use Git Bash sed or substitute manually.)

- [ ] **Step 3: Verify sed paths in one test file**

Open `app/test/backend/core/labels.test.ts` and confirm imports look like:

```ts
import { LabelStore } from "../../../backend/core/labels";
import type { LabelKey } from "../../../backend/core/types";
```

If anything looks off, fix manually.

- [ ] **Step 4: Add app/vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node",
        globals: false,
        passWithNoTests: true,
    },
});
```

- [ ] **Step 5: Run tests**

```bash
cd app
npm test
```

Expected: 89/89 tests pass (same as v1). If imports are off, fix them now.

- [ ] **Step 6: Commit**

```bash
cd ..
git add app/backend/core/ app/test/backend/ app/vitest.config.ts
git commit -m "feat(app): copy vscode-free core modules + tests into app/backend/core"
```

---

## Task 3: FridaClient backend wrapper

**Files:**
- Create: `app/backend/frida-client.ts`

The previous `FridaDirectClient` was tightly coupled to VSCode (used `vscode.EventEmitter`). We rewrite a minimal Node-pure version using `EventEmitter` from `node:events`.

- [ ] **Step 1: Write the file**

```ts
// app/backend/frida-client.ts
//
// Wraps frida-node into a Node-pure RPC client. Same surface as the
// old vscode-coupled FridaDirectClient — call(method, args), isHealthy(),
// listProcesses(), attach(pid), detach() — but emits via EventEmitter
// from node:events instead of vscode.EventEmitter.

import { EventEmitter } from "node:events";
import * as frida from "frida";
import * as fs from "node:fs";

export interface ProcessInfo {
    pid: number;
    name: string;
}

export interface AttachInfo {
    pid: number;
    name: string;
}

export class FridaClient extends EventEmitter {
    private session: frida.Session | null = null;
    private script: frida.Script | null = null;
    private currentPid: number | null = null;

    constructor(private readonly agentScriptPath: string) {
        super();
    }

    async listProcesses(): Promise<ProcessInfo[]> {
        const dev = await frida.getLocalDevice();
        const processes = await dev.enumerateProcesses();
        return processes.map((p) => ({ pid: p.pid, name: p.name }));
    }

    async attach(pid: number): Promise<AttachInfo> {
        if (this.session) {
            await this.detach();
        }
        const dev = await frida.getLocalDevice();
        const session = await dev.attach(pid);
        const source = fs.readFileSync(this.agentScriptPath, "utf-8");
        const script = await session.createScript(source);

        // Wait for agent-ready before resolving so the first /api/call works.
        const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("agent-ready timeout (10s)")), 10_000);
            const onMessage = (msg: any): void => {
                if (msg.type === "send" && msg.payload?.type === "agent-ready") {
                    clearTimeout(timer);
                    script.message.disconnect(onMessage);
                    resolve();
                }
            };
            script.message.connect(onMessage);
        });
        await script.load();
        await ready;

        // Forward all subsequent send() payloads.
        script.message.connect((msg: any) => {
            if (msg.type === "send" && msg.payload !== undefined) {
                this.emit("agent-message", msg.payload);
            }
        });

        const procName = await this.findProcessName(pid);
        this.session = session;
        this.script = script;
        this.currentPid = pid;
        this.emit("attached", { pid, name: procName });
        return { pid, name: procName };
    }

    async detach(): Promise<void> {
        try { await this.script?.unload(); } catch { /* ignore */ }
        try { await this.session?.detach(); } catch { /* ignore */ }
        this.script = null;
        this.session = null;
        this.currentPid = null;
        this.emit("detached");
    }

    isAttached(): boolean { return this.session !== null && this.script !== null; }
    currentProcess(): number | null { return this.currentPid; }

    async isHealthy(): Promise<boolean> {
        if (!this.script) return false;
        try { await this.script.exports.analyze; return true; }
        catch { return false; }
    }

    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
        if (!this.script) throw new Error("not attached");
        const exp = (this.script.exports as Record<string, (...a: unknown[]) => Promise<T>>)[method];
        if (typeof exp !== "function") throw new Error(`unknown rpc method: ${method}`);
        return await exp(...args);
    }

    private async findProcessName(pid: number): Promise<string> {
        try {
            const dev = await frida.getLocalDevice();
            const procs = await dev.enumerateProcesses();
            return procs.find((p) => p.pid === pid)?.name ?? `pid-${pid}`;
        } catch { return `pid-${pid}`; }
    }
}
```

- [ ] **Step 2: Build to verify**

```bash
cd app
npx tsc -p tsconfig.backend.json --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd ..
git add app/backend/frida-client.ts
git commit -m "feat(app): FridaClient — Node-pure wrapper around frida-node"
```

---

## Task 4: Backend session state singleton

**Files:**
- Create: `app/backend/session.ts`

Centralizes the current Profile, FridaClient instance, label/annotation/hook stores. Other routes import from here.

- [ ] **Step 1: Write the file**

```ts
// app/backend/session.ts
//
// Process-wide singleton holding the current Frida session + profile
// + per-profile stores (labels, annotations, hooks). Routes import this
// to read/mutate state. Profile lifecycle: created on attach, replaced
// on re-attach to a different process/build, cleared on detach.

import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";

import { FridaClient } from "./frida-client.js";
import { ProfileManager, type Profile } from "./core/profile.js";
import { detectBuildId } from "./core/detect.js";
import { matchFingerprints } from "./core/migrations.js";
import { HookStore } from "./core/hooks/hook-store.js";
import { expandHome } from "./core/paths.js";
import type { ClassFingerprint, MigrationResult } from "./core/types.js";

const PROFILE_ROOT = expandHome(process.env.FRIDA_TOOLKIT_PROFILE_ROOT ?? "")
    || path.join(os.homedir(), ".frida-toolkit", "profiles");

export class Session extends EventEmitter {
    readonly fridaClient: FridaClient;
    readonly profileManager: ProfileManager;
    private currentProfile: Profile | null = null;
    private currentHookStore: HookStore | null = null;
    private currentMigrations: { result: MigrationResult; oldFps: ClassFingerprint[]; currentFps: ClassFingerprint[] } | null = null;

    constructor(agentScriptPath: string) {
        super();
        this.fridaClient = new FridaClient(agentScriptPath);
        this.profileManager = new ProfileManager(PROFILE_ROOT);
        this.fridaClient.on("agent-message", (payload) => this.emit("agent-message", payload));
        this.fridaClient.on("detached", () => this.handleDetach());
    }

    profile(): Profile | null { return this.currentProfile; }
    hookStore(): HookStore | null { return this.currentHookStore; }
    migrations(): { result: MigrationResult } | null {
        return this.currentMigrations ? { result: this.currentMigrations.result } : null;
    }

    async attach(pid: number): Promise<Profile> {
        await this.fridaClient.attach(pid);

        const detected = await detectBuildId({
            call: <T>(m: string, a?: unknown[]): Promise<T> => this.fridaClient.call<T>(m, a),
            isHealthy: () => this.fridaClient.isHealthy(),
        });

        const gameName = await this.deriveGameName();
        let profile: Profile;
        try {
            profile = await this.profileManager.loadProfile(gameName, detected.buildId);
        } catch {
            const previous = await this.profileManager.findMostRecentBuild(gameName, detected.buildId);
            profile = await this.profileManager.createProfile({
                gameName,
                buildId: detected.buildId,
                buildIdSource: detected.source,
                derivedFromBuildId: previous ?? undefined,
            });
        }

        // Migrations
        let currentFps: ClassFingerprint[] = [];
        try {
            currentFps = await this.fridaClient.call<ClassFingerprint[]>("listClassFingerprints");
        } catch (e) {
            console.warn("listClassFingerprints failed:", e);
        }

        const wasNewlyCreated = profile.manifest.derivedFrom !== null
            && profile.manifest.attachedFirstAt === profile.manifest.attachedLastAt;
        if (wasNewlyCreated && profile.manifest.derivedFrom) {
            const previousBuildId = profile.manifest.derivedFrom.split("/")[1];
            const oldFps = await this.profileManager.loadFingerprints(gameName, previousBuildId);
            if (oldFps && currentFps.length > 0) {
                const oldLabels = await this.profileManager.loadProfileLabels(gameName, previousBuildId);
                const result = matchFingerprints({ oldFps, newFps: currentFps, oldLabels });
                for (const m of result.auto) {
                    profile.labels.set({ kind: "class", className: m.newObf }, m.label);
                }
                await profile.labels.flush();
                this.currentMigrations = { result, oldFps, currentFps };
            }
        }

        if (currentFps.length > 0) {
            try { await this.profileManager.saveFingerprints(profile, currentFps); }
            catch (e) { console.warn("saveFingerprints failed:", e); }
        }

        this.currentProfile = profile;
        // HookStore needs an RPC client and a storage. Use the FridaClient
        // for RPC and a DiskPluginStorage rooted at the profile.
        const { DiskPluginStorage } = await import("./core/plugin-storage.js");
        const storage = new DiskPluginStorage(profile.rootPath, "hooks");
        this.currentHookStore = new HookStore(storage, {
            call: <T>(m: string, a?: unknown[]) => this.fridaClient.call<T>(m, a),
        });

        // Forward label/annotation events from the stores so WS bridge can broadcast them.
        profile.labels.onChange((evt) => this.emit("label-change", evt));
        profile.annotations.onChange((evt) => this.emit("annotation-change", evt));
        this.currentHookStore.onChange(() => this.emit("hook-store-change"));

        // Update manifest stats once.
        await this.profileManager.updateStats(profile).catch((e) => console.warn("updateStats failed:", e));

        // Pre-warm the agent's explorer index so the first user click is instant.
        try { await this.fridaClient.call<{ assemblies: number; classes: number }>("prewarmExplorerIndex"); }
        catch (e) { console.warn("prewarmExplorerIndex failed:", e); }

        this.emit("profile-attached", profile);
        return profile;
    }

    async detach(): Promise<void> {
        await this.fridaClient.detach();
        // handleDetach() will clear state and emit events.
    }

    private handleDetach(): void {
        if (this.currentProfile) {
            // Drain pending writes before clearing.
            void this.currentProfile.labels.flush().catch(() => {});
            void this.currentProfile.annotations.flush().catch(() => {});
        }
        this.currentProfile = null;
        this.currentHookStore = null;
        this.currentMigrations = null;
        this.emit("profile-detached");
    }

    private async deriveGameName(): Promise<string> {
        try {
            const dataPath = await this.fridaClient.call<string>("getDataPath");
            if (!dataPath) return "unknown-process";
            const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
            return seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
        } catch { return "unknown-process"; }
    }
}
```

- [ ] **Step 2: Build to verify**

```bash
cd app
npx tsc -p tsconfig.backend.json --noEmit
```

Expected: clean (might emit warnings about importing `.js` extensions — that's correct for ESM).

- [ ] **Step 3: Commit**

```bash
cd ..
git add app/backend/session.ts
git commit -m "feat(app): backend Session singleton — profile lifecycle + stores"
```

---

## Task 5: Backend Express server skeleton + /api/call route (TDD)

**Files:**
- Create: `app/backend/server.ts`
- Create: `app/backend/routes/api-call.ts`
- Create: `app/test/backend/routes-api-call.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// app/test/backend/routes-api-call.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { EventEmitter } from "node:events";

import { mountApiCall } from "../../backend/routes/api-call.js";

class FakeFridaClient extends EventEmitter {
    isAttached(): boolean { return true; }
    async call<T>(method: string, args: unknown[] = []): Promise<T> {
        if (method === "echo") return args[0] as T;
        if (method === "boom") throw new Error("kaboom");
        throw new Error(`unknown method ${method}`);
    }
}

let app: express.Express;

beforeEach(() => {
    app = express();
    app.use(express.json());
    mountApiCall(app, { fridaClient: new FakeFridaClient() as any });
});

describe("POST /api/call", () => {
    it("returns the RPC result on success", async () => {
        const res = await request(app)
            .post("/api/call")
            .send({ method: "echo", args: ["hello"] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: "hello" });
    });

    it("returns 500 with error message on RPC failure", async () => {
        const res = await request(app)
            .post("/api/call")
            .send({ method: "boom" });
        expect(res.status).toBe(500);
        expect(res.body.error).toContain("kaboom");
    });

    it("returns 400 when method is missing", async () => {
        const res = await request(app).post("/api/call").send({});
        expect(res.status).toBe(400);
    });

    it("returns 503 when not attached", async () => {
        const detached = new (class extends FakeFridaClient {
            isAttached() { return false; }
        })();
        const app2 = express();
        app2.use(express.json());
        mountApiCall(app2, { fridaClient: detached as any });
        const res = await request(app2).post("/api/call").send({ method: "echo", args: [] });
        expect(res.status).toBe(503);
    });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd app
npm test -- routes-api-call
```

Expected: FAIL — `mountApiCall` not found.

- [ ] **Step 3: Implement the route**

```ts
// app/backend/routes/api-call.ts
import type { Express } from "express";
import type { FridaClient } from "../frida-client.js";

export interface ApiCallDeps {
    fridaClient: FridaClient;
}

export function mountApiCall(app: Express, deps: ApiCallDeps): void {
    app.post("/api/call", async (req, res) => {
        const { method, args } = req.body ?? {};
        if (typeof method !== "string" || method.length === 0) {
            res.status(400).json({ error: "method required" });
            return;
        }
        if (!deps.fridaClient.isAttached()) {
            res.status(503).json({ error: "not attached" });
            return;
        }
        try {
            const result = await deps.fridaClient.call(method, Array.isArray(args) ? args : []);
            res.json({ result });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });
}
```

- [ ] **Step 4: Implement minimal server.ts**

```ts
// app/backend/server.ts
import express from "express";
import * as path from "node:path";
import * as url from "node:url";

import { Session } from "./session.js";
import { mountApiCall } from "./routes/api-call.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = "127.0.0.1";

const agentScriptPath = process.env.FRIDA_AGENT_SCRIPT
    ?? path.resolve(__dirname, "../../../build/rpc-agent.js");

const session = new Session(agentScriptPath);
const app = express();
app.use(express.json({ limit: "5mb" }));

mountApiCall(app, { fridaClient: session.fridaClient });

app.listen(PORT, HOST, () => {
    console.log(`[frida-toolkit] backend listening on http://${HOST}:${PORT}`);
    console.log(`[frida-toolkit] agent script: ${agentScriptPath}`);
});
```

- [ ] **Step 5: Run test (should pass)**

```bash
cd app
npm test -- routes-api-call
```

Expected: 4/4 pass.

- [ ] **Step 6: Verify backend boots**

```bash
cd app
npm run dev:backend &
sleep 2
curl -s -X POST http://127.0.0.1:3001/api/call -H "Content-Type: application/json" -d '{"method":"echo"}' | head
# Expected: {"error":"not attached"} (since no agent attached, but server is reachable)
kill %1 2>/dev/null
```

- [ ] **Step 7: Commit**

```bash
cd ..
git add app/backend/server.ts app/backend/routes/api-call.ts app/test/backend/routes-api-call.test.ts
git commit -m "feat(app): Express server + POST /api/call (TDD)"
```

---

## Task 6: Profile attach/detach routes (TDD)

**Files:**
- Create: `app/backend/routes/profile.ts`
- Create: `app/test/backend/routes-profile.test.ts`
- Modify: `app/backend/server.ts` (mount the new route)

- [ ] **Step 1: Write failing test**

```ts
// app/test/backend/routes-profile.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import { mountProfile } from "../../backend/routes/profile.js";

function makeFakeSession() {
    let prof: any = null;
    return {
        profile: () => prof,
        async attach(pid: number) {
            prof = { manifest: { profileId: `dofus/${pid}-build`, gameName: "dofus" } };
            return prof;
        },
        async detach() { prof = null; },
        fridaClient: {
            async listProcesses() { return [{ pid: 1234, name: "Dofus.exe" }]; },
        },
    };
}

let app: express.Express;
let session: ReturnType<typeof makeFakeSession>;

beforeEach(() => {
    session = makeFakeSession();
    app = express();
    app.use(express.json());
    mountProfile(app, { session: session as any });
});

describe("profile routes", () => {
    it("GET /api/profile returns null before attach", async () => {
        const res = await request(app).get("/api/profile");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ profile: null });
    });

    it("POST /api/profile/attach attaches and returns the profile", async () => {
        const res = await request(app).post("/api/profile/attach").send({ pid: 1234 });
        expect(res.status).toBe(200);
        expect(res.body.profile.manifest.profileId).toBe("dofus/1234-build");
    });

    it("GET /api/profile returns the profile after attach", async () => {
        await request(app).post("/api/profile/attach").send({ pid: 1234 });
        const res = await request(app).get("/api/profile");
        expect(res.body.profile.manifest.gameName).toBe("dofus");
    });

    it("POST /api/profile/detach clears the profile", async () => {
        await request(app).post("/api/profile/attach").send({ pid: 1234 });
        await request(app).post("/api/profile/detach");
        const res = await request(app).get("/api/profile");
        expect(res.body.profile).toBeNull();
    });

    it("GET /api/profile/processes returns the process list", async () => {
        const res = await request(app).get("/api/profile/processes");
        expect(res.status).toBe(200);
        expect(res.body.processes).toEqual([{ pid: 1234, name: "Dofus.exe" }]);
    });

    it("POST /api/profile/attach without pid returns 400", async () => {
        const res = await request(app).post("/api/profile/attach").send({});
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd app && npm test -- routes-profile
```

Expected: FAIL — `mountProfile` not found.

- [ ] **Step 3: Implement the route**

```ts
// app/backend/routes/profile.ts
import type { Express } from "express";
import type { Session } from "../session.js";

export interface ProfileDeps {
    session: Session;
}

function serializeProfile(p: ReturnType<Session["profile"]>) {
    if (!p) return null;
    return {
        manifest: p.manifest,
        rootPath: p.rootPath,
    };
}

export function mountProfile(app: Express, deps: ProfileDeps): void {
    app.get("/api/profile", (_req, res) => {
        res.json({ profile: serializeProfile(deps.session.profile()) });
    });

    app.get("/api/profile/processes", async (_req, res) => {
        try {
            const processes = await deps.session.fridaClient.listProcesses();
            res.json({ processes });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    app.post("/api/profile/attach", async (req, res) => {
        const { pid } = req.body ?? {};
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
            res.status(400).json({ error: "pid (positive integer) required" });
            return;
        }
        try {
            const profile = await deps.session.attach(pid);
            res.json({ profile: serializeProfile(profile) });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    app.post("/api/profile/detach", async (_req, res) => {
        try {
            await deps.session.detach();
            res.json({ ok: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });
}
```

- [ ] **Step 4: Mount in server.ts**

In `app/backend/server.ts`, add after `mountApiCall`:

```ts
import { mountProfile } from "./routes/profile.js";
// ...
mountProfile(app, { session });
```

- [ ] **Step 5: Run tests (should pass)**

```bash
cd app && npm test -- routes-profile
```

Expected: 6/6 pass.

- [ ] **Step 6: Commit**

```bash
cd ..
git add app/backend/routes/profile.ts app/test/backend/routes-profile.test.ts app/backend/server.ts
git commit -m "feat(app): /api/profile routes — attach/detach/list (TDD)"
```

---

## Task 7: Labels routes (TDD)

**Files:**
- Create: `app/backend/routes/labels.ts`
- Create: `app/test/backend/routes-labels.test.ts`
- Modify: `app/backend/server.ts` (mount)

- [ ] **Step 1: Write failing test**

```ts
// app/test/backend/routes-labels.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LabelStore } from "../../backend/core/labels.js";
import { mountLabels } from "../../backend/routes/labels.js";

function makeSession(store: LabelStore) {
    return {
        profile: () => ({ labels: store }),
    };
}

let tmpDir: string;
let store: LabelStore;
let app: express.Express;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labels-routes-"));
    store = new LabelStore(path.join(tmpDir, "labels.json"));
    app = express();
    app.use(express.json());
    mountLabels(app, { session: makeSession(store) as any });
});

describe("labels routes", () => {
    it("GET /api/labels returns the bulk export", async () => {
        store.set({ kind: "class", className: "egq" }, "HaapiService");
        const res = await request(app).get("/api/labels");
        expect(res.status).toBe(200);
        expect(res.body.classes.egq.label).toBe("HaapiService");
    });

    it("POST /api/labels/class sets a class label", async () => {
        const res = await request(app)
            .post("/api/labels/class")
            .send({ key: { className: "egq" }, label: "HaapiService" });
        expect(res.status).toBe(200);
        expect(store.get({ kind: "class", className: "egq" })).toBe("HaapiService");
    });

    it("POST /api/labels/method sets a method label", async () => {
        const res = await request(app)
            .post("/api/labels/method")
            .send({ key: { className: "egq", methodName: "ywp" }, label: "Consume" });
        expect(res.status).toBe(200);
        expect(store.get({ kind: "method", className: "egq", methodName: "ywp" })).toBe("Consume");
    });

    it("POST /api/labels/class with remove:true removes the label", async () => {
        store.set({ kind: "class", className: "egq" }, "HaapiService");
        await request(app)
            .post("/api/labels/class")
            .send({ key: { className: "egq" }, remove: true });
        expect(store.get({ kind: "class", className: "egq" })).toBeNull();
    });

    it("POST /api/labels/undo + redo work end-to-end", async () => {
        store.set({ kind: "class", className: "egq" }, "HaapiService");
        await request(app).post("/api/labels/undo");
        expect(store.get({ kind: "class", className: "egq" })).toBeNull();
        await request(app).post("/api/labels/redo");
        expect(store.get({ kind: "class", className: "egq" })).toBe("HaapiService");
    });

    it("returns 503 when no profile attached", async () => {
        const app2 = express();
        app2.use(express.json());
        mountLabels(app2, { session: { profile: () => null } as any });
        const res = await request(app2).get("/api/labels");
        expect(res.status).toBe(503);
    });
});
```

- [ ] **Step 2: Run test (fails)**

```bash
cd app && npm test -- routes-labels
```

Expected: FAIL.

- [ ] **Step 3: Implement the route**

```ts
// app/backend/routes/labels.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import type { LabelKey } from "../core/types.js";

export interface LabelsDeps { session: Session; }

function ensureProfile(deps: LabelsDeps) {
    const p = deps.session.profile();
    if (!p) return null;
    return p;
}

function buildKey(kind: "class" | "method" | "field", raw: any): LabelKey | null {
    if (!raw || typeof raw !== "object") return null;
    if (kind === "class") {
        if (typeof raw.className !== "string") return null;
        return { kind, className: raw.className };
    }
    if (kind === "method") {
        if (typeof raw.className !== "string" || typeof raw.methodName !== "string") return null;
        return { kind, className: raw.className, methodName: raw.methodName };
    }
    if (typeof raw.className !== "string" || typeof raw.fieldName !== "string") return null;
    return { kind, className: raw.className, fieldName: raw.fieldName };
}

export function mountLabels(app: Express, deps: LabelsDeps): void {
    app.get("/api/labels", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        res.json(p.labels.bulkExport());
    });

    for (const kind of ["class", "method", "field"] as const) {
        app.post(`/api/labels/${kind}`, (req, res) => {
            const p = ensureProfile(deps);
            if (!p) { res.status(503).json({ error: "not attached" }); return; }
            const key = buildKey(kind, req.body?.key);
            if (!key) { res.status(400).json({ error: "invalid key" }); return; }
            if (req.body?.remove === true) {
                p.labels.remove(key);
            } else {
                if (typeof req.body?.label !== "string" || req.body.label.length === 0) {
                    res.status(400).json({ error: "label required" });
                    return;
                }
                p.labels.set(key, req.body.label);
            }
            p.labels.scheduleFlush();
            res.json({ ok: true });
        });
    }

    app.post("/api/labels/undo", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const ok = p.labels.undo();
        if (ok) p.labels.scheduleFlush();
        res.json({ ok });
    });

    app.post("/api/labels/redo", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const ok = p.labels.redo();
        if (ok) p.labels.scheduleFlush();
        res.json({ ok });
    });
}
```

- [ ] **Step 4: Mount + run tests**

In `app/backend/server.ts`, add `import { mountLabels } from "./routes/labels.js";` and `mountLabels(app, { session });`.

```bash
cd app && npm test -- routes-labels
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd ..
git add app/backend/routes/labels.ts app/test/backend/routes-labels.test.ts app/backend/server.ts
git commit -m "feat(app): /api/labels routes (TDD)"
```

---

## Task 8: Annotations routes (TDD)

**Files:**
- Create: `app/backend/routes/annotations.ts`
- Create: `app/test/backend/routes-annotations.test.ts`
- Modify: `app/backend/server.ts`

- [ ] **Step 1: Write failing test**

```ts
// app/test/backend/routes-annotations.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AnnotationStore } from "../../backend/core/annotations.js";
import { mountAnnotations } from "../../backend/routes/annotations.js";

let tmpDir: string;
let store: AnnotationStore;
let app: express.Express;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "annot-routes-"));
    store = new AnnotationStore(path.join(tmpDir, "annotations.json"));
    app = express();
    app.use(express.json());
    mountAnnotations(app, { session: { profile: () => ({ annotations: store }) } as any });
});

describe("annotations routes", () => {
    it("GET /api/annotations returns bookmarks + notes lists", async () => {
        store.toggleBookmark({ kind: "class", className: "egq" });
        store.setNote({ kind: "class", className: "egq" }, "important");
        const res = await request(app).get("/api/annotations");
        expect(res.status).toBe(200);
        expect(res.body.bookmarks).toContainEqual({ kind: "class", className: "egq" });
        expect(res.body.notes.find((n: any) => n.key.className === "egq").markdown).toBe("important");
    });

    it("POST /api/annotations/bookmark toggles", async () => {
        await request(app).post("/api/annotations/bookmark")
            .send({ key: { kind: "class", className: "egq" } });
        expect(store.isBookmarked({ kind: "class", className: "egq" })).toBe(true);
        await request(app).post("/api/annotations/bookmark")
            .send({ key: { kind: "class", className: "egq" } });
        expect(store.isBookmarked({ kind: "class", className: "egq" })).toBe(false);
    });

    it("POST /api/annotations/note sets and removes", async () => {
        await request(app).post("/api/annotations/note")
            .send({ key: { kind: "class", className: "egq" }, markdown: "hello" });
        expect(store.getNote({ kind: "class", className: "egq" })).toBe("hello");
        await request(app).post("/api/annotations/note")
            .send({ key: { kind: "class", className: "egq" }, remove: true });
        expect(store.getNote({ kind: "class", className: "egq" })).toBeNull();
    });
});
```

- [ ] **Step 2: Implement**

```ts
// app/backend/routes/annotations.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import type { LabelKey } from "../core/types.js";

export interface AnnotationsDeps { session: Session; }

function asKey(raw: any): LabelKey | null {
    if (!raw || typeof raw !== "object") return null;
    if (raw.kind === "class" && typeof raw.className === "string") {
        return { kind: "class", className: raw.className };
    }
    if (raw.kind === "method" && typeof raw.className === "string" && typeof raw.methodName === "string") {
        return { kind: "method", className: raw.className, methodName: raw.methodName };
    }
    if (raw.kind === "field" && typeof raw.className === "string" && typeof raw.fieldName === "string") {
        return { kind: "field", className: raw.className, fieldName: raw.fieldName };
    }
    return null;
}

export function mountAnnotations(app: Express, deps: AnnotationsDeps): void {
    function profile() {
        const p = deps.session.profile();
        if (!p) return null;
        return p;
    }

    app.get("/api/annotations", (_req, res) => {
        const p = profile();
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const bookmarks = p.annotations.listBookmarks();
        const notes = p.annotations.listNoted().map((key) => ({
            key, markdown: p.annotations.getNote(key) ?? "",
        }));
        res.json({ bookmarks, notes });
    });

    app.post("/api/annotations/bookmark", (req, res) => {
        const p = profile();
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const key = asKey(req.body?.key);
        if (!key) { res.status(400).json({ error: "invalid key" }); return; }
        p.annotations.toggleBookmark(key);
        p.annotations.scheduleFlush();
        res.json({ ok: true });
    });

    app.post("/api/annotations/note", (req, res) => {
        const p = profile();
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const key = asKey(req.body?.key);
        if (!key) { res.status(400).json({ error: "invalid key" }); return; }
        if (req.body?.remove === true) {
            p.annotations.removeNote(key);
        } else {
            if (typeof req.body?.markdown !== "string") {
                res.status(400).json({ error: "markdown required" });
                return;
            }
            p.annotations.setNote(key, req.body.markdown);
        }
        p.annotations.scheduleFlush();
        res.json({ ok: true });
    });
}
```

- [ ] **Step 3: Mount in server.ts + run tests**

```bash
cd app && npm test -- routes-annotations
```

Expected: 3/3 pass.

- [ ] **Step 4: Commit**

```bash
cd ..
git add app/backend/routes/annotations.ts app/test/backend/routes-annotations.test.ts app/backend/server.ts
git commit -m "feat(app): /api/annotations routes (TDD)"
```

---

## Task 9: Hooks routes (TDD)

**Files:**
- Create: `app/backend/routes/hooks.ts`
- Create: `app/test/backend/routes-hooks.test.ts`
- Modify: `app/backend/server.ts`

- [ ] **Step 1: Write failing test**

```ts
// app/test/backend/routes-hooks.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiskPluginStorage } from "../../backend/core/plugin-storage.js";
import { HookStore } from "../../backend/core/hooks/hook-store.js";
import { mountHooks } from "../../backend/routes/hooks.js";

function fakeRpc(state: { calls: any[]; nextHookId: number }) {
    return {
        async call<T>(method: string, args: unknown[] = []): Promise<T> {
            state.calls.push({ method, args });
            if (method === "installHook") return { hookId: `h${state.nextHookId++}` } as T;
            if (method === "revertHook") return { reverted: true } as T;
            if (method === "clearAllHooks") return { count: 0 } as T;
            return undefined as T;
        },
    };
}

let tmpDir: string;
let store: HookStore;
let state: { calls: any[]; nextHookId: number };
let app: express.Express;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-routes-"));
    state = { calls: [], nextHookId: 1 };
    store = new HookStore(new DiskPluginStorage(tmpDir, "hooks"), fakeRpc(state));
    app = express();
    app.use(express.json());
    const session = {
        hookStore: () => store,
        fridaClient: fakeRpc(state),
    };
    mountHooks(app, { session: session as any });
});

describe("hooks routes", () => {
    const SPEC = { template: "log", className: "ecu", methodName: "xbe" };

    it("POST /api/hooks/add stores a hook", async () => {
        const res = await request(app).post("/api/hooks/add").send({ spec: SPEC });
        expect(res.status).toBe(200);
        expect(res.body.stored.spec).toEqual(SPEC);
        expect(store.list()).toHaveLength(1);
    });

    it("POST /api/hooks/install routes through the store", async () => {
        const stored = store.add(SPEC);
        const res = await request(app).post("/api/hooks/install").send({ id: stored.id });
        expect(res.status).toBe(200);
        expect(state.calls.find(c => c.method === "installHook")).toBeTruthy();
    });

    it("POST /api/hooks/uninstall reverts", async () => {
        const stored = store.add(SPEC);
        await store.install(stored.id);
        await request(app).post("/api/hooks/uninstall").send({ id: stored.id });
        expect(state.calls.find(c => c.method === "revertHook")).toBeTruthy();
    });

    it("POST /api/hooks/remove deletes from disk", async () => {
        const stored = store.add(SPEC);
        await request(app).post("/api/hooks/remove").send({ id: stored.id });
        expect(store.list()).toHaveLength(0);
    });

    it("GET /api/hooks lists all hooks", async () => {
        store.add(SPEC);
        const res = await request(app).get("/api/hooks");
        expect(res.body.hooks).toHaveLength(1);
    });

    it("POST /api/hooks/add validates the spec", async () => {
        const res = await request(app).post("/api/hooks/add")
            .send({ spec: { template: "garbage", className: "x", methodName: "y" } });
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Implement**

```ts
// app/backend/routes/hooks.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import { validateHookSpec } from "../core/hooks/hook-spec-validation.js";

export interface HooksDeps { session: Session; }

export function mountHooks(app: Express, deps: HooksDeps): void {
    function store() { return deps.session.hookStore(); }

    app.get("/api/hooks", (_req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        res.json({ hooks: s.list() });
    });

    app.post("/api/hooks/add", (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const spec = req.body?.spec;
        const v = validateHookSpec(spec);
        if (!v.ok) { res.status(400).json({ error: v.reason }); return; }
        const stored = s.add(spec);
        res.json({ stored });
    });

    app.post("/api/hooks/update", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        const spec = req.body?.spec;
        const v = validateHookSpec(spec);
        if (typeof id !== "string" || !v.ok) { res.status(400).json({ error: v.ok ? "id required" : v.reason }); return; }
        try {
            await s.update(id, spec);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/install", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        if (typeof id !== "string") { res.status(400).json({ error: "id required" }); return; }
        try {
            await s.install(id);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/uninstall", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        if (typeof id !== "string") { res.status(400).json({ error: "id required" }); return; }
        try {
            await s.uninstall(id);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/remove", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        if (typeof id !== "string") { res.status(400).json({ error: "id required" }); return; }
        try {
            await s.remove(id);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/clear-all", async (_req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        try {
            const r = await deps.session.fridaClient.call<{ count: number }>("clearAllHooks");
            s.markAllDisarmed();
            res.json(r);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
}
```

- [ ] **Step 3: Mount + run tests**

```bash
cd app && npm test -- routes-hooks
```

Expected: 6/6 pass.

- [ ] **Step 4: Commit**

```bash
cd ..
git add app/backend/routes/hooks.ts app/test/backend/routes-hooks.test.ts app/backend/server.ts
git commit -m "feat(app): /api/hooks routes (TDD)"
```

---

## Task 10: Migrations routes

**Files:**
- Create: `app/backend/routes/migrations.ts`
- Modify: `app/backend/server.ts`

No new tests — covered by smoke. Migrations is a thin pass-through.

- [ ] **Step 1: Implement**

```ts
// app/backend/routes/migrations.ts
import type { Express } from "express";
import type { Session } from "../session.js";

export interface MigrationsDeps { session: Session; }

export function mountMigrations(app: Express, deps: MigrationsDeps): void {
    app.get("/api/migrations", (_req, res) => {
        const m = deps.session.migrations();
        if (!m) { res.json({ result: { auto: [], review: [], lost: [] } }); return; }
        res.json(m);
    });

    app.post("/api/migrations/accept", async (req, res) => {
        const p = deps.session.profile();
        const m = deps.session.migrations();
        if (!p || !m) { res.status(503).json({ error: "no migrations or no profile" }); return; }
        const { oldObf, newObf } = req.body ?? {};
        if (typeof oldObf !== "string" || typeof newObf !== "string") {
            res.status(400).json({ error: "oldObf + newObf required" });
            return;
        }
        const idx = m.result.review.findIndex(r => r.oldObf === oldObf);
        if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
        const entry = m.result.review[idx];
        p.labels.set({ kind: "class", className: newObf }, entry.label);
        p.labels.scheduleFlush();
        m.result.review.splice(idx, 1);
        m.result.auto.push({
            key: entry.key, label: entry.label, oldObf: entry.oldObf, newObf,
            reason: "user accepted",
        });
        res.json({ ok: true });
    });

    app.post("/api/migrations/reject", (req, res) => {
        const m = deps.session.migrations();
        if (!m) { res.status(503).json({ error: "no migrations" }); return; }
        const { oldObf } = req.body ?? {};
        if (typeof oldObf !== "string") { res.status(400).json({ error: "oldObf required" }); return; }
        const idx = m.result.review.findIndex(r => r.oldObf === oldObf);
        if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
        const entry = m.result.review[idx];
        m.result.review.splice(idx, 1);
        m.result.lost.push({
            key: entry.key, label: entry.label, oldObf: entry.oldObf,
            reason: "user rejected",
        });
        res.json({ ok: true });
    });
}
```

- [ ] **Step 2: Mount in server.ts**

```ts
import { mountMigrations } from "./routes/migrations.js";
// ...
mountMigrations(app, { session });
```

- [ ] **Step 3: Build to verify**

```bash
cd app && npx tsc -p tsconfig.backend.json --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd ..
git add app/backend/routes/migrations.ts app/backend/server.ts
git commit -m "feat(app): /api/migrations routes (accept/reject)"
```

---

## Task 11: WebSocket bridge for live events

**Files:**
- Create: `app/backend/ws-bridge.ts`
- Modify: `app/backend/server.ts` (wire ws server)

- [ ] **Step 1: Implement ws-bridge**

```ts
// app/backend/ws-bridge.ts
//
// Broadcasts session events (Frida send() payloads, label/annotation/hook
// changes, profile attach/detach) to all connected WebSocket clients on /events.

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Session } from "./session.js";

interface OutboundEvent {
    type: string;
    payload?: unknown;
    [k: string]: unknown;
}

export function mountWsBridge(server: HttpServer, session: Session): void {
    const wss = new WebSocketServer({ server, path: "/events" });

    const clients = new Set<WebSocket>();
    wss.on("connection", (ws) => {
        clients.add(ws);
        ws.on("close", () => clients.delete(ws));
    });

    const broadcast = (evt: OutboundEvent): void => {
        const data = JSON.stringify(evt);
        for (const c of clients) {
            if (c.readyState === c.OPEN) {
                try { c.send(data); } catch { /* drop */ }
            }
        }
    };

    session.on("agent-message", (payload: unknown) => {
        // Pass through hook-event / hook-auto-revert / agent-ready / etc.
        if (payload && typeof payload === "object" && "type" in (payload as Record<string, unknown>)) {
            broadcast(payload as OutboundEvent);
        } else {
            broadcast({ type: "agent-message", payload });
        }
    });
    session.on("label-change", (evt) => broadcast({ type: "label-change", ...evt }));
    session.on("annotation-change", (evt) => broadcast({ type: "annotation-change", ...evt }));
    session.on("hook-store-change", () => broadcast({ type: "hook-store-change" }));
    session.on("profile-attached", (profile) => broadcast({
        type: "profile-attached",
        profile: { manifest: profile.manifest, rootPath: profile.rootPath },
    }));
    session.on("profile-detached", () => broadcast({ type: "profile-detached" }));
}
```

- [ ] **Step 2: Wire in server.ts**

Replace the bottom of `server.ts` with:

```ts
// app/backend/server.ts (final layout)
import express from "express";
import * as path from "node:path";
import * as url from "node:url";
import * as http from "node:http";

import { Session } from "./session.js";
import { mountApiCall } from "./routes/api-call.js";
import { mountProfile } from "./routes/profile.js";
import { mountLabels } from "./routes/labels.js";
import { mountAnnotations } from "./routes/annotations.js";
import { mountHooks } from "./routes/hooks.js";
import { mountMigrations } from "./routes/migrations.js";
import { mountWsBridge } from "./ws-bridge.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = "127.0.0.1";

const agentScriptPath = process.env.FRIDA_AGENT_SCRIPT
    ?? path.resolve(__dirname, "../../../build/rpc-agent.js");

const session = new Session(agentScriptPath);

const app = express();
app.use(express.json({ limit: "5mb" }));

mountApiCall(app, { fridaClient: session.fridaClient });
mountProfile(app, { session });
mountLabels(app, { session });
mountAnnotations(app, { session });
mountHooks(app, { session });
mountMigrations(app, { session });

const server = http.createServer(app);
mountWsBridge(server, session);

server.listen(PORT, HOST, () => {
    console.log(`[frida-toolkit] backend listening on http://${HOST}:${PORT}`);
    console.log(`[frida-toolkit] ws events at ws://${HOST}:${PORT}/events`);
    console.log(`[frida-toolkit] agent script: ${agentScriptPath}`);
});
```

- [ ] **Step 3: Build to verify**

```bash
cd app && npx tsc -p tsconfig.backend.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
cd ..
git add app/backend/ws-bridge.ts app/backend/server.ts
git commit -m "feat(app): WebSocket bridge — broadcast session events on /events"
```

---

## Task 12: Vite frontend setup + theme tokens

**Files:**
- Create: `app/vite.config.ts`
- Create: `app/frontend/index.html`
- Create: `app/frontend/main.ts`
- Create: `app/frontend/styles/theme.css`
- Create: `app/frontend/styles/fonts.css`
- Create: `app/frontend/styles/app.css`

- [ ] **Step 1: vite.config.ts**

```ts
// app/vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
    root: "frontend",
    build: {
        outDir: "../dist/frontend",
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        proxy: {
            "/api": "http://127.0.0.1:3001",
            "/events": { target: "ws://127.0.0.1:3001", ws: true },
        },
    },
});
```

- [ ] **Step 2: index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Frida IL2CPP Toolkit</title>
    <link rel="stylesheet" href="./styles/fonts.css">
    <link rel="stylesheet" href="./styles/theme.css">
    <link rel="stylesheet" href="./styles/app.css">
</head>
<body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
</body>
</html>
```

- [ ] **Step 3: fonts.css**

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
```

- [ ] **Step 4: theme.css**

```css
:root {
    --bg-base:        #08080c;
    --bg-panel:       #0a0a0f;
    --bg-elevated:    #0d0d12;
    --bg-tile:        #14141c;
    --bg-tile-hover:  #1a1a24;
    --border:         #18181f;
    --border-strong:  #1f1f2a;
    --text-primary:   #f0f6fc;
    --text-secondary: #e6edf3;
    --text-muted:     #9ca3af;
    --text-faint:     #6b7280;
    --indigo:         #6366f1;
    --indigo-hover:   #818cf8;
    --indigo-deep:    #4f46e5;
    --indigo-bg:      rgba(99, 102, 241, 0.15);
    --indigo-bg-soft: rgba(99, 102, 241, 0.04);
    --indigo-border:  rgba(99, 102, 241, 0.4);
    --indigo-glow:    0 4px 12px rgba(99, 102, 241, 0.3);
    --success:        #22c55e;
    --warning:        #f59e0b;
    --danger:         #ef4444;
    --method:         #a78bfa;
    --field:          #22c55e;
    --syntax-keyword: #ff7b72;
    --syntax-type:    #79c0ff;
    --syntax-name:    #f0f6fc;
    --syntax-string:  #a5d6ff;
    --syntax-return:  #7ee787;
    --font-ui:        'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    --font-code:      'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    --radius-sm:      4px;
    --radius:         6px;
    --radius-lg:      8px;
    --radius-xl:      12px;
    --transition:     150ms ease;
    --transition-fast: 100ms ease;
}

html, body { margin: 0; padding: 0; height: 100%; }
body {
    background: var(--bg-base);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
input, button, select { font-family: inherit; font-size: inherit; }
button { cursor: pointer; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }
```

- [ ] **Step 5: app.css (layout shell)**

```css
/* app/frontend/styles/app.css — layout shell */

#app {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
}

.titlebar {
    height: 32px;
    background: var(--bg-base);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 8px;
    flex-shrink: 0;
}
.titlebar .title { font-size: 11px; color: var(--text-faint); }
.titlebar .badge {
    margin-left: auto;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 10px;
    background: rgba(34, 197, 94, 0.12);
    color: var(--success);
    border: 1px solid rgba(34, 197, 94, 0.2);
    display: flex;
    align-items: center;
    gap: 6px;
}
.titlebar .badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
}
.titlebar .badge.disconnected {
    background: rgba(239, 68, 68, 0.12);
    color: var(--danger);
    border-color: rgba(239, 68, 68, 0.2);
}
.titlebar .badge.disconnected::before {
    background: var(--danger);
    box-shadow: 0 0 6px var(--danger);
}
.titlebar .kbd {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    background: var(--bg-tile);
    color: var(--indigo-hover);
    border: 1px solid var(--border-strong);
    font-family: var(--font-code);
    margin-left: 12px;
}

.main-row { flex: 1; display: flex; min-height: 0; }

.statusbar {
    height: 26px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 14px;
    gap: 14px;
    font-size: 10px;
    color: var(--text-faint);
    flex-shrink: 0;
}
.statusbar .item { display: flex; align-items: center; gap: 6px; }
.statusbar .right { margin-left: auto; }
.statusbar .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--success); box-shadow: 0 0 6px var(--success);
}
```

- [ ] **Step 6: main.ts (layout shell mount)**

```ts
// app/frontend/main.ts — bootstrap

const root = document.getElementById("app")!;

function renderShell(): void {
    root.innerHTML = `
        <div class="titlebar">
            <span class="title">Frida IL2CPP Toolkit</span>
            <span class="kbd">⌘K</span>
            <span class="badge disconnected" id="conn-badge">disconnected</span>
        </div>
        <div class="main-row" id="main-row">
            <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-faint)">
                Loading…
            </div>
        </div>
        <div class="statusbar">
            <span class="item" id="status-conn">no connection</span>
            <span class="right">v2.0</span>
        </div>
    `;
}

renderShell();
console.log("[frida-toolkit] frontend loaded");
```

- [ ] **Step 7: Run frontend**

```bash
cd app
npm run dev:frontend &
# Wait 2s, open http://localhost:5173
sleep 2
curl -s http://127.0.0.1:5173 | head
kill %1 2>/dev/null
```

Expected: Vite serves the page; HTML contains `<div id="app">`.

- [ ] **Step 8: Commit**

```bash
cd ..
git add app/vite.config.ts app/frontend/index.html app/frontend/main.ts app/frontend/styles/
git commit -m "feat(app): Vite + frontend layout shell + theme tokens"
```

---

## Task 13: Frontend api + ws clients (TDD on logic, smoke on integration)

**Files:**
- Create: `app/frontend/core/api.ts`
- Create: `app/frontend/core/ws.ts`
- Create: `app/frontend/core/store.ts`
- Create: `app/frontend/core/types.ts`

- [ ] **Step 1: types.ts (mirror backend)**

```ts
// app/frontend/core/types.ts — mirror of agent + backend types

export interface ProfileLite {
    manifest: {
        profileId: string;
        gameName: string;
        buildId: string;
        buildIdSource: string;
        attachedFirstAt: string;
        attachedLastAt: string;
        derivedFrom: string | null;
        stats: { totalLabels: number; totalBookmarks: number; totalNotes: number };
    };
    rootPath: string;
}

export type LabelKey =
    | { kind: "class"; className: string }
    | { kind: "method"; className: string; methodName: string }
    | { kind: "field"; className: string; fieldName: string };

export type HookTemplate = "log" | "noop" | "force-return" | "log-stack";

export interface HookSpec {
    template: HookTemplate;
    className: string;
    methodName: string;
    forceReturnValue?: unknown;
    stackCaptureCount?: number;
}

export interface StoredHook {
    id: string;
    spec: HookSpec;
    installedHookId: string | null;
    addedAt: number;
}

export interface HookEvent {
    type: "hook-event";
    hookId: string;
    ts: number;
    self: string | null;
    args: string[];
    retval: string | null;
    error?: string;
    stackFrames?: string[];
}

export interface ProcessInfo { pid: number; name: string; }
```

- [ ] **Step 2: api.ts**

```ts
// app/frontend/core/api.ts — fetch wrapper for /api/*

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? `${res.status} ${res.statusText}`);
    }
    return await res.json() as T;
}

export const api = {
    rpc<T = unknown>(method: string, args: unknown[] = []): Promise<{ result: T }> {
        return call("POST", "/api/call", { method, args });
    },
    getProfile() { return call<{ profile: import("./types.js").ProfileLite | null }>("GET", "/api/profile"); },
    listProcesses() { return call<{ processes: import("./types.js").ProcessInfo[] }>("GET", "/api/profile/processes"); },
    attach(pid: number) { return call("POST", "/api/profile/attach", { pid }); },
    detach() { return call("POST", "/api/profile/detach"); },

    getLabels() { return call<any>("GET", "/api/labels"); },
    setLabel(kind: "class" | "method" | "field", key: any, label: string) {
        return call("POST", `/api/labels/${kind}`, { key, label });
    },
    removeLabel(kind: "class" | "method" | "field", key: any) {
        return call("POST", `/api/labels/${kind}`, { key, remove: true });
    },
    undoLabel() { return call("POST", "/api/labels/undo"); },
    redoLabel() { return call("POST", "/api/labels/redo"); },

    getAnnotations() { return call<{ bookmarks: any[]; notes: any[] }>("GET", "/api/annotations"); },
    toggleBookmark(key: any) { return call("POST", "/api/annotations/bookmark", { key }); },
    setNote(key: any, markdown: string) { return call("POST", "/api/annotations/note", { key, markdown }); },
    removeNote(key: any) { return call("POST", "/api/annotations/note", { key, remove: true }); },

    getHooks() { return call<{ hooks: import("./types.js").StoredHook[] }>("GET", "/api/hooks"); },
    addHook(spec: import("./types.js").HookSpec) { return call<{ stored: import("./types.js").StoredHook }>("POST", "/api/hooks/add", { spec }); },
    installHook(id: string) { return call("POST", "/api/hooks/install", { id }); },
    uninstallHook(id: string) { return call("POST", "/api/hooks/uninstall", { id }); },
    updateHook(id: string, spec: import("./types.js").HookSpec) { return call("POST", "/api/hooks/update", { id, spec }); },
    removeHook(id: string) { return call("POST", "/api/hooks/remove", { id }); },
    clearAllHooks() { return call<{ count: number }>("POST", "/api/hooks/clear-all"); },

    getMigrations() { return call<any>("GET", "/api/migrations"); },
    acceptMigration(oldObf: string, newObf: string) { return call("POST", "/api/migrations/accept", { oldObf, newObf }); },
    rejectMigration(oldObf: string) { return call("POST", "/api/migrations/reject", { oldObf }); },
};
```

- [ ] **Step 3: ws.ts**

```ts
// app/frontend/core/ws.ts — WebSocket client + dispatcher

type Handler = (payload: any) => void;

let _ws: WebSocket | null = null;
const handlers = new Map<string, Set<Handler>>();

function ensure(): WebSocket {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
        return _ws;
    }
    const url = location.protocol === "https:" ? "wss://" : "ws://";
    _ws = new WebSocket(`${url}${location.host}/events`);
    _ws.addEventListener("message", (m) => {
        let data: any;
        try { data = JSON.parse(m.data); } catch { return; }
        if (!data || typeof data.type !== "string") return;
        const set = handlers.get(data.type);
        if (set) for (const h of set) { try { h(data); } catch (e) { console.error(e); } }
    });
    _ws.addEventListener("close", () => {
        // Attempt reconnect after 1s.
        setTimeout(() => { _ws = null; ensure(); }, 1000);
    });
    return _ws;
}

export function subscribe(type: string, handler: Handler): () => void {
    ensure();
    let set = handlers.get(type);
    if (!set) { set = new Set(); handlers.set(type, set); }
    set.add(handler);
    return () => set!.delete(handler);
}

export function connectWs(): void { ensure(); }
```

- [ ] **Step 4: store.ts (TDD)**

Create test first:

```ts
// app/test/frontend/store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../../frontend/core/store.js";

interface S { count: number; name: string; }

let store: Store<S>;
beforeEach(() => { store = new Store<S>({ count: 0, name: "" }); });

describe("Store", () => {
    it("returns initial state", () => {
        expect(store.get()).toEqual({ count: 0, name: "" });
    });

    it("notifies subscribers on update", () => {
        let seen: S | null = null;
        store.subscribe((s) => { seen = s; });
        store.update({ count: 5 });
        expect(seen).toEqual({ count: 5, name: "" });
    });

    it("merges partial updates", () => {
        store.update({ count: 1 });
        store.update({ name: "x" });
        expect(store.get()).toEqual({ count: 1, name: "x" });
    });

    it("unsubscribes cleanly", () => {
        let calls = 0;
        const off = store.subscribe(() => calls++);
        store.update({ count: 1 });
        off();
        store.update({ count: 2 });
        expect(calls).toBe(1);
    });

    it("does not call subscribers on no-op update", () => {
        let calls = 0;
        store.subscribe(() => calls++);
        store.update({ count: 0 });
        expect(calls).toBe(0);
    });
});
```

Update `app/vitest.config.ts` to include frontend tests:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node",
        globals: false,
        passWithNoTests: true,
    },
});
```

(Already correct — frontend tests live under `app/test/frontend/`.)

Run failing test:

```bash
cd app && npm test -- store
```

Expected: FAIL.

Implement:

```ts
// app/frontend/core/store.ts
type Listener<S> = (state: S) => void;

export class Store<S extends object> {
    private state: S;
    private listeners = new Set<Listener<S>>();

    constructor(initial: S) { this.state = { ...initial }; }

    get(): S { return this.state; }

    update(patch: Partial<S>): void {
        let changed = false;
        for (const k of Object.keys(patch) as (keyof S)[]) {
            if (this.state[k] !== patch[k]) {
                changed = true;
                break;
            }
        }
        if (!changed) return;
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners) {
            try { l(this.state); } catch (e) { console.error(e); }
        }
    }

    subscribe(fn: Listener<S>): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}
```

Run test:

```bash
cd app && npm test -- store
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd ..
git add app/frontend/core/ app/test/frontend/
git commit -m "feat(app): frontend core — api / ws / store + tests"
```

---

## Task 14: Frontend nav + status-bar components, wire to ws

**Files:**
- Create: `app/frontend/components/nav-icons.ts`
- Create: `app/frontend/components/status-bar.ts`
- Modify: `app/frontend/main.ts`

- [ ] **Step 1: nav-icons.ts**

```ts
// app/frontend/components/nav-icons.ts

export type NavTab = "explorer" | "hooks" | "bookmarks" | "migrations";

export interface NavIconsConfig {
    onSelect(tab: NavTab): void;
    badges?: Partial<Record<NavTab, number>>;
}

export function renderNavIcons(host: HTMLElement, cfg: NavIconsConfig): { setActive(t: NavTab): void; setBadge(t: NavTab, n: number): void } {
    host.className = "nav-icons";
    host.innerHTML = `
        <div class="nav-icon" data-tab="explorer" title="Process Explorer">📦</div>
        <div class="nav-icon" data-tab="hooks" title="Hooks"><span class="badge-count" hidden></span>🪝</div>
        <div class="nav-icon" data-tab="bookmarks" title="Bookmarks">⭐</div>
        <div class="nav-icon" data-tab="migrations" title="Migrations">🔄</div>
    `;
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
        for (const [t, n] of Object.entries(cfg.badges)) setBadge(t as NavTab, n ?? 0);
    }
    return { setActive, setBadge };
}
```

Append CSS to `app/frontend/styles/app.css`:

```css
.nav-icons {
    width: 48px;
    background: var(--bg-base);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px 0;
    gap: 4px;
    flex-shrink: 0;
}
.nav-icon {
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-lg);
    color: var(--text-faint);
    transition: all var(--transition);
    position: relative;
}
.nav-icon:hover { background: var(--bg-tile); color: var(--text-secondary); }
.nav-icon.active {
    color: white;
    background: linear-gradient(135deg, var(--indigo), var(--indigo-deep));
    box-shadow: var(--indigo-glow);
}
.badge-count {
    position: absolute; top: 2px; right: 2px;
    background: var(--danger); color: white;
    font-size: 8px; padding: 0 4px; border-radius: 8px;
    min-width: 14px; text-align: center; font-weight: 700;
}
```

- [ ] **Step 2: status-bar.ts**

```ts
// app/frontend/components/status-bar.ts

export interface StatusBarHandle {
    setConnection(text: string, ok: boolean): void;
    setRight(text: string): void;
}

export function renderStatusBar(host: HTMLElement): StatusBarHandle {
    host.className = "statusbar";
    host.innerHTML = `
        <span class="item" id="sb-conn"><span class="dot"></span><span class="conn-text">no connection</span></span>
        <span class="right" id="sb-right">v2.0</span>
    `;
    const dot = host.querySelector<HTMLElement>(".dot")!;
    const text = host.querySelector<HTMLElement>(".conn-text")!;
    const right = host.querySelector<HTMLElement>("#sb-right")!;
    return {
        setConnection(t, ok) {
            text.textContent = t;
            dot.style.background = ok ? "var(--success)" : "var(--danger)";
            dot.style.boxShadow = `0 0 6px ${ok ? "var(--success)" : "var(--danger)"}`;
        },
        setRight(t) { right.textContent = t; },
    };
}
```

- [ ] **Step 3: Update main.ts to wire layout**

```ts
// app/frontend/main.ts
import { connectWs, subscribe } from "./core/ws.js";
import { api } from "./core/api.js";
import { renderNavIcons, type NavTab } from "./components/nav-icons.js";
import { renderStatusBar } from "./components/status-bar.js";

const root = document.getElementById("app")!;
root.innerHTML = `
    <div class="titlebar">
        <span class="title">Frida IL2CPP Toolkit</span>
        <span class="kbd">⌘K</span>
        <span class="badge disconnected" id="conn-badge">disconnected</span>
    </div>
    <div class="main-row" id="main-row">
        <div id="nav-icons-host"></div>
        <div id="page-host" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-faint)">
            Loading…
        </div>
    </div>
    <div id="statusbar-host"></div>
`;

const navHandle = renderNavIcons(document.getElementById("nav-icons-host")!, {
    onSelect: (tab: NavTab) => {
        location.hash = `#/${tab}`;
    },
});
const sb = renderStatusBar(document.getElementById("statusbar-host")!);
const connBadge = document.getElementById("conn-badge")!;

async function refreshProfile(): Promise<void> {
    try {
        const { profile } = await api.getProfile();
        if (profile) {
            sb.setConnection(`${profile.manifest.gameName} / ${profile.manifest.buildId.slice(0, 8)}`, true);
            connBadge.textContent = "connected";
            connBadge.classList.remove("disconnected");
        } else {
            sb.setConnection("no connection", false);
            connBadge.textContent = "disconnected";
            connBadge.classList.add("disconnected");
        }
    } catch (e) {
        console.warn("getProfile failed:", e);
    }
}

connectWs();
subscribe("profile-attached", refreshProfile);
subscribe("profile-detached", refreshProfile);
void refreshProfile();
```

- [ ] **Step 4: Smoke**

```bash
cd app
npm run dev:frontend &
sleep 2
# Open http://localhost:5173 — should see titlebar + nav-icons stub + statusbar
kill %1 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
cd ..
git add app/frontend/components/nav-icons.ts app/frontend/components/status-bar.ts app/frontend/main.ts app/frontend/styles/app.css
git commit -m "feat(app): frontend nav-icons + status-bar + ws wiring"
```

---

## Task 15: Process Explorer component (frontend)

**Files:**
- Create: `app/frontend/components/process-explorer.ts`
- Create: `app/frontend/pages/explorer.ts`
- Modify: `app/frontend/styles/app.css` (add explorer styles)
- Modify: `app/frontend/main.ts` (route to explorer page)

- [ ] **Step 1: Append explorer styles to app.css**

```css
/* app/frontend/styles/app.css — append */

.explorer-panel {
    width: 280px;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    flex-shrink: 0;
    min-height: 0;
}
.explorer-header {
    padding: 12px 16px 8px;
    display: flex; align-items: center; justify-content: space-between;
}
.explorer-header h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.explorer-header .meta { font-size: 10px; color: var(--text-faint); }
.filter-pill {
    margin: 0 12px 12px;
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-tile);
    padding: 7px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-strong);
    transition: border-color var(--transition);
}
.filter-pill:focus-within { border-color: var(--indigo); }
.filter-pill input {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--text-secondary); font-size: 11px;
}
.filter-pill .kbd-mini {
    background: var(--border-strong); padding: 1px 6px;
    border-radius: 4px; font-size: 9px; color: var(--text-faint);
    font-family: var(--font-code);
}
.tree {
    flex: 1; overflow-y: auto; padding: 0 8px 12px;
}
.tree-node {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; border-radius: var(--radius);
    cursor: pointer; white-space: nowrap;
    transition: background var(--transition-fast);
}
.tree-node:hover { background: var(--bg-tile); }
.tree-node.selected {
    background: linear-gradient(90deg, rgba(99, 102, 241, 0.18), rgba(99, 102, 241, 0.04));
    border-left: 2px solid var(--indigo);
    padding-left: 6px;
}
.tree-node .chevron { width: 12px; color: var(--text-faint); font-size: 9px; }
.tree-node .icon { font-size: 11px; }
.tree-node .label { flex: 1; color: var(--text-secondary); }
.tree-node .count { color: var(--text-faint); font-size: 10px; }
.tree-node[data-depth="1"] { padding-left: 18px; }
.tree-node[data-depth="1"].selected { padding-left: 16px; }
.tree-node[data-depth="2"] { padding-left: 32px; }
.tree-node[data-depth="2"].selected { padding-left: 30px; }
.tree-node.cls .label .friendly { font-weight: 500; color: var(--text-primary); }
.tree-node.cls .label .obf-tag {
    color: var(--text-faint); font-size: 10px; margin-left: 4px;
    font-family: var(--font-code);
}
```

- [ ] **Step 2: process-explorer.ts**

```ts
// app/frontend/components/process-explorer.ts

import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";

interface AssemblyInfo { name: string; classes: number; }
interface NamespaceInfo { ns: string; classes: number; }
interface ClassEnriched {
    obfName: string; fullName: string; label: string | null;
    bookmarked: boolean; hasNote: boolean;
}

export interface ExplorerHandle {
    onClassSelect(cb: (fullName: string) => void): void;
}

export function renderProcessExplorer(host: HTMLElement): ExplorerHandle {
    host.className = "explorer-panel";
    host.innerHTML = `
        <div class="explorer-header">
            <h3>Process Explorer</h3>
            <span class="meta" id="exp-meta"></span>
        </div>
        <div class="filter-pill">
            <span style="color:var(--text-faint)">🔍</span>
            <input id="exp-filter" placeholder="Filter…" />
            <span class="kbd-mini">/</span>
        </div>
        <div class="tree" id="exp-tree"><div style="color:var(--text-faint);padding:1em">Loading…</div></div>
    `;
    const tree = host.querySelector<HTMLDivElement>("#exp-tree")!;
    const meta = host.querySelector<HTMLElement>("#exp-meta")!;
    const filter = host.querySelector<HTMLInputElement>("#exp-filter")!;
    const nsCache = new Map<string, NamespaceInfo[]>();
    const clsCache = new Map<string, ClassEnriched[]>();
    let onSelect: (fullName: string) => void = () => {};

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    async function loadAssemblies(): Promise<void> {
        try {
            const { result } = await api.rpc<AssemblyInfo[]>("listAssembliesInfo");
            tree.innerHTML = "";
            let total = 0;
            for (const a of result) {
                total += a.classes;
                tree.appendChild(renderAsmNode(a));
            }
            meta.textContent = `${(total / 1000).toFixed(1)}k cls`;
            applyFilter();
        } catch (e) {
            tree.innerHTML = `<div style="color:var(--danger);padding:1em">${escape(String(e))}</div>`;
        }
    }

    function renderAsmNode(a: AssemblyInfo): HTMLElement {
        const el = document.createElement("div");
        el.className = "tree-node assembly";
        el.dataset.depth = "0";
        el.dataset.assembly = a.name;
        el.dataset.expanded = "false";
        el.innerHTML = `
            <span class="chevron">▶</span>
            <span class="icon">📦</span>
            <span class="label">${escape(a.name)}</span>
            <span class="count">${a.classes}</span>
        `;
        el.addEventListener("click", () => toggleAsm(el));
        return el;
    }

    async function toggleAsm(el: HTMLElement): Promise<void> {
        const asm = el.dataset.assembly!;
        if (el.dataset.expanded === "true") {
            // collapse: remove following non-assembly siblings
            let next = el.nextElementSibling;
            while (next && (next as HTMLElement).dataset.depth !== "0") {
                const r = next; next = next.nextElementSibling; r.remove();
            }
            el.dataset.expanded = "false";
            el.querySelector(".chevron")!.textContent = "▶";
            return;
        }
        let nsList = nsCache.get(asm);
        if (!nsList) {
            const { result } = await api.rpc<NamespaceInfo[]>("listNamespaces", [asm]);
            nsList = result;
            nsCache.set(asm, nsList);
        }
        const frag = document.createDocumentFragment();
        for (const n of nsList) frag.appendChild(renderNsNode(asm, n));
        el.after(frag);
        el.dataset.expanded = "true";
        el.querySelector(".chevron")!.textContent = "▼";
        applyFilter();
    }

    function renderNsNode(asm: string, n: NamespaceInfo): HTMLElement {
        const el = document.createElement("div");
        el.className = "tree-node namespace";
        el.dataset.depth = "1";
        el.dataset.assembly = asm;
        el.dataset.ns = n.ns;
        el.dataset.expanded = "false";
        el.innerHTML = `
            <span class="chevron">▶</span>
            <span class="icon">📁</span>
            <span class="label">${escape(n.ns || "(root)")}</span>
            <span class="count">${n.classes}</span>
        `;
        el.addEventListener("click", (ev) => { ev.stopPropagation(); toggleNs(el); });
        return el;
    }

    async function toggleNs(el: HTMLElement): Promise<void> {
        const asm = el.dataset.assembly!;
        const ns = el.dataset.ns!;
        if (el.dataset.expanded === "true") {
            const indent = parseInt(el.style.paddingLeft || "0", 10);
            let next = el.nextElementSibling;
            while (next && (next as HTMLElement).dataset.depth === "2") {
                const r = next; next = next.nextElementSibling; r.remove();
            }
            el.dataset.expanded = "false";
            el.querySelector(".chevron")!.textContent = "▶";
            return;
        }
        const key = `${asm}::${ns}`;
        let list = clsCache.get(key);
        if (!list) {
            const { result } = await api.rpc<string[]>("listClassesIn", [asm, ns]);
            const profileLabels = (await api.getLabels()) as { classes: Record<string, { label: string }> };
            const annotations = await api.getAnnotations();
            const bookmarked = new Set<string>();
            const noted = new Set<string>();
            for (const k of annotations.bookmarks) {
                if (k.kind === "class") bookmarked.add(k.className);
            }
            for (const n of annotations.notes) {
                if (n.key.kind === "class") noted.add(n.key.className);
            }
            list = result.map((obfName) => ({
                obfName,
                fullName: ns ? `${ns}.${obfName}` : obfName,
                label: profileLabels.classes[obfName]?.label ?? null,
                bookmarked: bookmarked.has(obfName),
                hasNote: noted.has(obfName),
            }));
            clsCache.set(key, list);
        }
        const frag = document.createDocumentFragment();
        for (const c of list) frag.appendChild(renderClsNode(asm, ns, c));
        el.after(frag);
        el.dataset.expanded = "true";
        el.querySelector(".chevron")!.textContent = "▼";
        applyFilter();
    }

    function renderClsNode(asm: string, ns: string, c: ClassEnriched): HTMLElement {
        const el = document.createElement("div");
        el.className = "tree-node cls";
        el.dataset.depth = "2";
        el.dataset.fullname = c.fullName;
        el.dataset.obf = c.obfName;
        let labelHtml = c.label
            ? `<span class="friendly">${escape(c.label)}</span><span class="obf-tag">[${escape(c.obfName)}]</span>`
            : escape(c.obfName);
        if (c.bookmarked) labelHtml += ' <span style="font-size:9px">⭐</span>';
        if (c.hasNote) labelHtml += ' <span style="font-size:9px">📝</span>';
        el.innerHTML = `
            <span class="chevron">·</span>
            <span class="icon">🔷</span>
            <span class="label">${labelHtml}</span>
        `;
        el.addEventListener("click", (ev) => { ev.stopPropagation(); selectClass(el, c.fullName); });
        return el;
    }

    function selectClass(el: HTMLElement, fullName: string): void {
        host.querySelectorAll<HTMLElement>(".tree-node.selected").forEach((n) => n.classList.remove("selected"));
        el.classList.add("selected");
        onSelect(fullName);
    }

    function applyFilter(): void {
        const q = filter.value.toLowerCase();
        if (!q) {
            tree.querySelectorAll<HTMLElement>(".tree-node").forEach((n) => n.style.display = "");
            return;
        }
        tree.querySelectorAll<HTMLElement>(".tree-node").forEach((n) => {
            const lbl = n.querySelector<HTMLElement>(".label")?.textContent?.toLowerCase() ?? "";
            n.style.display = lbl.includes(q) ? "" : "none";
        });
    }

    filter.addEventListener("input", applyFilter);

    // Subscribe to label/annotation changes to refresh visible class nodes
    subscribe("label-change", (evt: any) => {
        if (evt.key?.kind === "class") {
            tree.querySelectorAll<HTMLElement>(`.tree-node.cls[data-obf="${CSS.escape(evt.key.className)}"]`).forEach((el) => {
                const labelEl = el.querySelector<HTMLElement>(".label")!;
                if (evt.newLabel) {
                    labelEl.innerHTML = `<span class="friendly">${escape(evt.newLabel)}</span><span class="obf-tag">[${escape(evt.key.className)}]</span>`;
                } else {
                    labelEl.textContent = evt.key.className;
                }
            });
        }
    });

    subscribe("profile-attached", () => { nsCache.clear(); clsCache.clear(); void loadAssemblies(); });
    subscribe("profile-detached", () => { tree.innerHTML = `<div style="color:var(--text-faint);padding:1em">No process attached.</div>`; });

    void loadAssemblies();

    return {
        onClassSelect(cb) { onSelect = cb; },
    };
}
```

- [ ] **Step 3: Commit (page integration in next task)**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit
cd ..
git add app/frontend/components/process-explorer.ts app/frontend/styles/app.css
git commit -m "feat(app): Process Explorer component (lazy expand + filter)"
```

---

## Task 16: Class Detail component (frontend)

**Files:**
- Create: `app/frontend/components/class-detail.ts`
- Modify: `app/frontend/styles/app.css` (append class-detail styles)

- [ ] **Step 1: Append CSS**

```css
/* app/frontend/styles/app.css — append */

.class-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg-elevated); }
.breadcrumb { padding: 12px 24px 8px; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-faint); }
.breadcrumb .crumb.last { color: var(--text-secondary); font-weight: 500; }
.breadcrumb .sep { opacity: 0.4; }

.class-header {
    padding: 0 24px 14px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 14px;
}
.class-header h1 {
    margin: 0; font-size: 22px; font-weight: 700;
    color: var(--text-primary); letter-spacing: -0.5px;
}
.class-header .badge-tag {
    background: var(--indigo-bg); color: var(--indigo-hover);
    padding: 3px 10px; border-radius: var(--radius);
    font-size: 10px; font-weight: 500;
    border: 1px solid var(--indigo-border);
}
.class-header .actions { margin-left: auto; display: flex; gap: 6px; }

.pill {
    background: var(--bg-tile); border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    padding: 5px 12px; border-radius: var(--radius);
    font-size: 11px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 5px;
    transition: all var(--transition);
}
.pill:hover { border-color: var(--indigo); background: var(--bg-tile-hover); }
.pill.primary {
    background: linear-gradient(135deg, var(--indigo), var(--indigo-deep));
    border: none; color: white; font-weight: 500;
}
.pill.primary:hover { box-shadow: var(--indigo-glow); }

.class-content { flex: 1; overflow-y: auto; padding: 16px 24px; min-height: 0; }
.section-h {
    font-size: 11px; color: var(--text-faint); text-transform: uppercase;
    letter-spacing: 1px; margin: 16px 0 8px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
}
.section-h .count-badge {
    background: var(--bg-tile); color: var(--text-muted);
    padding: 1px 7px; border-radius: 999px; font-size: 9px;
    border: 1px solid var(--border-strong);
}

.member-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: var(--radius-lg);
    font-family: var(--font-code); font-size: 11px;
    transition: all var(--transition); cursor: pointer;
    border: 1px solid transparent;
}
.member-row:hover { background: var(--bg-tile); border-color: var(--border-strong); }
.member-row .kind-tag {
    padding: 2px 7px; border-radius: 4px; font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    font-family: var(--font-ui); flex-shrink: 0;
}
.member-row .kind-tag.method { background: rgba(167, 139, 250, 0.15); color: var(--method); }
.member-row .kind-tag.field { background: rgba(34, 197, 94, 0.15); color: var(--field); }
.member-row .static-badge { color: var(--warning); font-style: italic; font-size: 10px; }
.member-row .ret { color: var(--syntax-return); }
.member-row .name { color: var(--syntax-name); font-weight: 500; }
.member-row .params { color: var(--text-muted); }
.member-row .type { color: var(--syntax-type); }
.member-row .actions {
    margin-left: auto; display: flex; gap: 4px;
    opacity: 0; transition: opacity var(--transition-fast);
}
.member-row:hover .actions { opacity: 1; }
.icon-btn-mini {
    background: transparent; border: 1px solid var(--border-strong);
    color: var(--text-muted);
    padding: 3px 9px; border-radius: 5px; font-size: 10px;
    cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    font-family: var(--font-ui); transition: all var(--transition);
}
.icon-btn-mini:hover { background: var(--bg-tile-hover); color: white; border-color: var(--indigo); }

.member-filter-pill { margin: 12px 24px 0; }
```

- [ ] **Step 2: class-detail.ts**

```ts
// app/frontend/components/class-detail.ts
import { api } from "../core/api.js";

interface MethodEntry { isStatic: boolean; returnType: string; name: string; params: string; }
interface FieldEntry { isStatic: boolean; type: string; name: string; }

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseDump(dump: string): { fields: FieldEntry[]; methods: MethodEntry[] } {
    const lines = dump.split("\n");
    const fields: FieldEntry[] = [];
    const methods: MethodEntry[] = [];
    let mode: "none" | "fields" | "methods" = "none";
    for (const line of lines) {
        if (line.startsWith("**Fields")) { mode = "fields"; continue; }
        if (line.startsWith("**Methods")) { mode = "methods"; continue; }
        if (!line.startsWith("- ")) continue;
        const body = line.slice(2);
        if (mode === "fields") {
            const isStatic = body.startsWith("static ");
            const rest = isStatic ? body.slice(7) : body;
            const sp = rest.indexOf(" ");
            if (sp < 0) continue;
            fields.push({ isStatic, type: rest.slice(0, sp), name: rest.slice(sp + 1) });
        } else if (mode === "methods") {
            const isStatic = body.startsWith("static ");
            const rest = isStatic ? body.slice(7) : body;
            const m = /^(\S+)\s+(\w+)\((.*)\)$/.exec(rest);
            if (m) methods.push({ isStatic, returnType: m[1], name: m[2], params: m[3] });
        }
    }
    return { fields, methods };
}

export interface ClassDetailHandle {
    show(fullName: string): Promise<void>;
}

export function renderClassDetail(host: HTMLElement): ClassDetailHandle {
    host.className = "class-pane";
    host.innerHTML = `<div style="padding:24px;color:var(--text-faint)">Click a class in the explorer to view its detail.</div>`;

    async function show(fullName: string): Promise<void> {
        host.innerHTML = `<div style="padding:24px;color:var(--text-faint)">Loading ${escape(fullName)}…</div>`;
        let dump: string;
        try {
            const { result } = await api.rpc<string>("dumpClassAsString", [fullName]);
            dump = result;
        } catch (e) {
            host.innerHTML = `<div style="padding:24px;color:var(--danger)">Failed: ${escape(String(e))}</div>`;
            return;
        }
        const { fields, methods } = parseDump(dump);
        const lastDot = fullName.lastIndexOf(".");
        const ns = lastDot > 0 ? fullName.slice(0, lastDot) : "";
        const shortName = lastDot > 0 ? fullName.slice(lastDot + 1) : fullName;

        // Get hooks for this class so we can mark hooked methods.
        let hooked = new Set<string>();
        try {
            const { hooks } = await api.getHooks();
            for (const h of hooks) {
                if (h.installedHookId && h.spec.className === fullName) {
                    hooked.add(h.spec.methodName);
                }
            }
        } catch { /* ignore */ }

        const fieldsHtml = fields.map((f) => `
            <div class="member-row">
                <span class="kind-tag field">field</span>
                ${f.isStatic ? '<span class="static-badge">static</span>' : ""}
                <span class="type">${escape(f.type)}</span>
                <span class="name">${escape(f.name)}</span>
                <div class="actions">
                    <button class="icon-btn-mini" data-copy="${escape(fullName)}.${escape(f.name)}">📋</button>
                </div>
            </div>
        `).join("");

        const methodsHtml = methods.map((m) => `
            <div class="member-row${hooked.has(m.name) ? " hooked" : ""}" data-method="${escape(m.name)}">
                <span class="kind-tag method">method</span>
                ${m.isStatic ? '<span class="static-badge">static</span>' : ""}
                <span class="ret">${escape(m.returnType)}</span>
                <span class="name">${escape(m.name)}</span>
                <span class="params">(${escape(m.params)})</span>
                <div class="actions">
                    <button class="icon-btn-mini hook-btn" data-method="${escape(m.name)}">🪝 Hook</button>
                    <button class="icon-btn-mini trace-btn" data-method="${escape(m.name)}">🎯 Trace</button>
                    <button class="icon-btn-mini" data-copy="${escape(fullName)}.${escape(m.name)}(${escape(m.params)})">📋</button>
                </div>
            </div>
        `).join("");

        host.innerHTML = `
            <div class="breadcrumb">
                ${ns.split(".").map((p, i, arr) => `<span class="crumb ${i === arr.length - 1 ? "last" : ""}">${escape(p)}</span>`).join('<span class="sep">›</span>')}
                ${ns ? '<span class="sep">›</span>' : ""}
                <span class="crumb last">${escape(shortName)}</span>
            </div>
            <div class="class-header">
                <h1>${escape(shortName)}</h1>
                <span class="badge-tag">${escape(fullName)}</span>
                <div class="actions">
                    <button class="pill" id="cd-bookmark">⭐</button>
                    <button class="pill" id="cd-note">📝 Note</button>
                    <button class="pill" id="cd-copy-obf">📋 Copy</button>
                    <button class="pill primary" id="cd-rename">✏ Rename</button>
                </div>
            </div>
            <div class="member-filter-pill filter-pill">
                <span style="color:var(--text-faint)">🔍</span>
                <input id="cd-filter" placeholder="Filter members…">
            </div>
            <div class="class-content">
                <div class="section-h">Fields <span class="count-badge">${fields.length}</span></div>
                ${fieldsHtml || '<div style="color:var(--text-faint);padding:8px 12px">No fields.</div>'}
                <div class="section-h" style="margin-top:20px">Methods <span class="count-badge">${methods.length}</span></div>
                ${methodsHtml || '<div style="color:var(--text-faint);padding:8px 12px">No methods.</div>'}
            </div>
        `;

        // Wire actions
        host.querySelectorAll<HTMLButtonElement>(".hook-btn").forEach((b) => {
            b.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const methodName = b.dataset.method!;
                const template = await pickTemplate();
                if (!template) return;
                try {
                    const { stored } = await api.addHook({ template, className: fullName, methodName });
                    await api.installHook(stored.id);
                } catch (e) {
                    alert(`Hook install failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            });
        });
        host.querySelectorAll<HTMLButtonElement>(".trace-btn").forEach((b) => {
            b.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const methodName = b.dataset.method!;
                try {
                    const { stored } = await api.addHook({
                        template: "log-stack",
                        className: fullName,
                        methodName,
                        stackCaptureCount: 5,
                    });
                    await api.installHook(stored.id);
                } catch (e) {
                    alert(`Trace install failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            });
        });
        host.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => {
            b.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                await navigator.clipboard.writeText(b.dataset.copy!);
            });
        });
        host.querySelector<HTMLInputElement>("#cd-filter")?.addEventListener("input", (ev) => {
            const q = (ev.target as HTMLInputElement).value.toLowerCase();
            host.querySelectorAll<HTMLElement>(".member-row").forEach((row) => {
                const name = row.querySelector<HTMLElement>(".name")?.textContent?.toLowerCase() ?? "";
                row.style.display = (q === "" || name.includes(q)) ? "" : "none";
            });
        });
        host.querySelector("#cd-bookmark")?.addEventListener("click", async () => {
            await api.toggleBookmark({ kind: "class", className: fullName });
        });
        host.querySelector("#cd-rename")?.addEventListener("click", async () => {
            const labels = await api.getLabels();
            const current = labels.classes[fullName]?.label ?? "";
            const next = prompt(`Rename ${fullName} →`, current);
            if (next === null) return;
            if (next === "") await api.removeLabel("class", { className: fullName });
            else await api.setLabel("class", { className: fullName }, next);
        });
        host.querySelector("#cd-note")?.addEventListener("click", async () => {
            const annotations = await api.getAnnotations();
            const current = annotations.notes.find((n: any) => n.key.className === fullName)?.markdown ?? "";
            const next = prompt(`Note for ${shortName} (markdown)`, current);
            if (next === null) return;
            if (next === "") await api.removeNote({ kind: "class", className: fullName });
            else await api.setNote({ kind: "class", className: fullName }, next);
        });
        host.querySelector("#cd-copy-obf")?.addEventListener("click", () => {
            void navigator.clipboard.writeText(fullName);
        });
    }

    return { show };
}

async function pickTemplate(): Promise<"log" | "log-stack" | "noop" | null> {
    const choice = prompt("Hook template (log / log-stack / noop):", "log");
    if (!choice) return null;
    if (choice === "log" || choice === "log-stack" || choice === "noop") return choice;
    alert("Invalid template");
    return null;
}
```

- [ ] **Step 3: Build to verify**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd ..
git add app/frontend/components/class-detail.ts app/frontend/styles/app.css
git commit -m "feat(app): Class Detail component with parsed dump + Hook/Trace/Copy"
```

---

## Task 17: Hook Log component (frontend)

**Files:**
- Create: `app/frontend/components/hook-log.ts`
- Modify: `app/frontend/styles/app.css`

- [ ] **Step 1: Append CSS**

```css
/* app/frontend/styles/app.css — append */

.hook-log-panel {
    width: 340px; background: var(--bg-panel);
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    flex-shrink: 0;
}
.right-tabs {
    display: flex; padding: 4px; gap: 2px; flex-shrink: 0;
    border-bottom: 1px solid var(--border);
}
.right-tab {
    flex: 1; padding: 6px 10px; text-align: center; font-size: 11px;
    color: var(--text-faint); cursor: pointer; border-radius: var(--radius);
    transition: all var(--transition);
    display: flex; align-items: center; justify-content: center; gap: 5px;
    background: transparent; border: 1px solid transparent;
}
.right-tab:hover { color: var(--text-secondary); background: var(--bg-tile); }
.right-tab.active {
    color: var(--text-primary); background: var(--bg-tile);
    border-color: var(--indigo-border);
}
.right-tab .count-pill {
    background: var(--indigo-bg); color: var(--indigo-hover);
    padding: 0 5px; border-radius: 4px; font-size: 9px;
    font-family: var(--font-code);
}
.right-tab .live-dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--success);
    box-shadow: 0 0 6px var(--success);
}

.log-toolbar {
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 6px;
}
.log-toolbar .filter-mini {
    flex: 1; background: var(--bg-tile); border: 1px solid var(--border-strong);
    padding: 4px 8px; border-radius: var(--radius);
    font-size: 10px; color: var(--text-secondary); outline: none;
}
.log-toolbar .filter-mini:focus { border-color: var(--indigo); }

.events { flex: 1; overflow-y: auto; padding: 4px 0;
    font-family: var(--font-code); font-size: 10px; }
.event {
    padding: 6px 12px; display: flex; flex-direction: column; gap: 2px;
    border-bottom: 1px solid var(--border);
    transition: background var(--transition-fast);
}
.event:hover { background: var(--bg-tile); }
.event.error { background: rgba(239, 68, 68, 0.04); }
.event-head { display: flex; align-items: center; gap: 6px; }
.event-time { color: var(--text-faint); font-size: 9px; }
.event-name { color: var(--indigo-hover); font-weight: 500; }
.event.error .event-name { color: var(--danger); }
.event-args { color: var(--text-muted); font-size: 10px; padding-left: 8px; }
.event-ret { color: var(--success); }
.event.error .event-ret { color: var(--danger); }
```

- [ ] **Step 2: hook-log.ts**

```ts
// app/frontend/components/hook-log.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { HookEvent, StoredHook } from "../core/types.js";

const RING_LIMIT = 10_000;

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHookLog(host: HTMLElement): void {
    host.className = "hook-log-panel";
    host.innerHTML = `
        <div class="right-tabs">
            <div class="right-tab active" data-tab="stream"><span class="live-dot"></span>Stream</div>
            <div class="right-tab" data-tab="summary">Summary <span class="count-pill" id="hl-count-summary">0</span></div>
            <div class="right-tab" data-tab="hooks">Hooks <span class="count-pill" id="hl-count-hooks">0</span></div>
        </div>
        <div class="log-toolbar">
            <input class="filter-mini" id="hl-filter" placeholder="Filter events…">
            <button class="icon-btn-mini" id="hl-pause">⏸</button>
            <button class="icon-btn-mini" id="hl-clear">🗑</button>
            <button class="icon-btn-mini" id="hl-export">⬇</button>
        </div>
        <div id="hl-content" class="events"><div style="padding:1em;color:var(--text-faint)">No hits yet.</div></div>
    `;

    const ring: HookEvent[] = [];
    const hooksMap = new Map<string, StoredHook>(); // installedHookId -> stored
    let activeTab: "stream" | "summary" | "hooks" = "stream";
    let paused = false;
    let filter = "";

    const content = host.querySelector<HTMLDivElement>("#hl-content")!;

    function refreshHooks(): void {
        void api.getHooks().then(({ hooks }) => {
            hooksMap.clear();
            for (const h of hooks) {
                if (h.installedHookId) hooksMap.set(h.installedHookId, h);
            }
            host.querySelector("#hl-count-hooks")!.textContent = String(hooks.length);
            if (activeTab === "hooks") renderHooksTab();
        });
    }

    function passesFilter(e: HookEvent): boolean {
        if (!filter) return true;
        const spec = hooksMap.get(e.hookId)?.spec;
        const hay = `${spec?.className ?? ""} ${spec?.methodName ?? ""} ${e.args.join(" ")} ${e.retval ?? ""} ${e.error ?? ""}`.toLowerCase();
        return hay.includes(filter);
    }

    function fmtRow(e: HookEvent): string {
        const spec = hooksMap.get(e.hookId)?.spec;
        const cls = spec ? spec.className : e.hookId;
        const m = spec ? spec.methodName : "?";
        const ts = new Date(e.ts).toISOString().slice(11, 23);
        const ret = e.error
            ? `<span class="event-ret">throw ${escape(e.error)}</span>`
            : `<span class="event-ret">${escape(e.retval ?? "void")}</span>`;
        const stack = e.stackFrames?.length
            ? `<div class="event-args" style="opacity:0.7">${e.stackFrames.map(escape).join("<br>")}</div>`
            : "";
        return `
            <div class="event${e.error ? " error" : ""}">
                <div class="event-head">
                    <span class="event-time">${ts}</span>
                    <span class="event-name">${escape(cls)}.${escape(m)}</span>
                </div>
                <div class="event-args">(${escape(e.args.join(", "))}) → ${ret}</div>
                ${stack}
            </div>
        `;
    }

    function renderStream(): void {
        const visible = ring.filter(passesFilter);
        if (visible.length === 0) {
            content.innerHTML = `<div style="padding:1em;color:var(--text-faint)">No hits${filter ? " matching filter" : ""}.</div>`;
            return;
        }
        content.innerHTML = visible.slice(-200).map(fmtRow).join("");
        content.scrollTop = content.scrollHeight;
    }

    function renderSummary(): void {
        const counts = new Map<string, { hookId: string; hits: number; lastTs: number; lastRet: string | null; lastErr: string | null }>();
        for (const e of ring) {
            const key = e.hookId;
            let s = counts.get(key);
            if (!s) { s = { hookId: key, hits: 0, lastTs: 0, lastRet: null, lastErr: null }; counts.set(key, s); }
            s.hits++; s.lastTs = e.ts; s.lastRet = e.retval; s.lastErr = e.error ?? null;
        }
        const rows = [...counts.values()].sort((a, b) => b.hits - a.hits);
        host.querySelector("#hl-count-summary")!.textContent = String(rows.length);
        content.innerHTML = rows.length === 0
            ? `<div style="padding:1em;color:var(--text-faint)">No data.</div>`
            : rows.map((s) => {
                const spec = hooksMap.get(s.hookId)?.spec;
                const name = spec ? `${spec.className}.${spec.methodName}` : s.hookId;
                return `
                    <div class="event">
                        <div class="event-head">
                            <span class="event-name">${escape(name)}</span>
                            <span style="margin-left:auto;color:var(--indigo-hover);font-weight:600">${s.hits} hits</span>
                        </div>
                        <div class="event-args">last: ${s.lastErr ? `<span class="event-ret">throw ${escape(s.lastErr)}</span>` : `<span class="event-ret">${escape(s.lastRet ?? "void")}</span>`}</div>
                    </div>
                `;
            }).join("");
    }

    function renderHooksTab(): void {
        const hooks = [...hooksMap.values()];
        if (hooks.length === 0) {
            content.innerHTML = `<div style="padding:1em;color:var(--text-faint)">No installed hooks.</div>`;
            return;
        }
        content.innerHTML = hooks.map((h) => `
            <div class="event">
                <div class="event-head">
                    <span class="event-name">${escape(h.spec.className)}.${escape(h.spec.methodName)}</span>
                    <span style="margin-left:auto;color:var(--text-faint);font-size:9px">[${h.spec.template}]</span>
                </div>
                <div class="event-args">
                    <button class="icon-btn-mini" data-hook-uninstall="${h.id}">⏸ Uninstall</button>
                    <button class="icon-btn-mini" data-hook-remove="${h.id}">🗑 Delete</button>
                </div>
            </div>
        `).join("");
        content.querySelectorAll<HTMLButtonElement>("[data-hook-uninstall]").forEach((b) => {
            b.addEventListener("click", () => api.uninstallHook(b.dataset.hookUninstall!));
        });
        content.querySelectorAll<HTMLButtonElement>("[data-hook-remove]").forEach((b) => {
            b.addEventListener("click", () => api.removeHook(b.dataset.hookRemove!));
        });
    }

    function rerender(): void {
        if (activeTab === "stream") renderStream();
        else if (activeTab === "summary") renderSummary();
        else renderHooksTab();
    }

    host.querySelectorAll<HTMLElement>(".right-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            activeTab = tab.dataset.tab as typeof activeTab;
            host.querySelectorAll<HTMLElement>(".right-tab").forEach((t) => t.classList.toggle("active", t === tab));
            rerender();
        });
    });

    host.querySelector<HTMLInputElement>("#hl-filter")!.addEventListener("input", (ev) => {
        filter = (ev.target as HTMLInputElement).value.toLowerCase();
        rerender();
    });
    host.querySelector<HTMLButtonElement>("#hl-pause")!.addEventListener("click", (ev) => {
        paused = !paused;
        (ev.target as HTMLButtonElement).textContent = paused ? "▶" : "⏸";
    });
    host.querySelector<HTMLButtonElement>("#hl-clear")!.addEventListener("click", () => {
        ring.length = 0; rerender();
    });
    host.querySelector<HTMLButtonElement>("#hl-export")!.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(ring, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `hook-log-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    subscribe("hook-event", (e: HookEvent) => {
        ring.push(e);
        if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
        if (!paused) rerender();
    });
    subscribe("hook-store-change", () => refreshHooks());
    subscribe("profile-attached", () => { ring.length = 0; refreshHooks(); rerender(); });
    subscribe("profile-detached", () => { ring.length = 0; hooksMap.clear(); rerender(); });

    refreshHooks();
}
```

- [ ] **Step 3: Build to verify**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
cd ..
git add app/frontend/components/hook-log.ts app/frontend/styles/app.css
git commit -m "feat(app): Hook Log component (Stream/Summary/Hooks tabs + filter + export)"
```

---

## Task 18: Explorer page wiring

**Files:**
- Create: `app/frontend/pages/explorer.ts`
- Modify: `app/frontend/main.ts`

- [ ] **Step 1: explorer.ts**

```ts
// app/frontend/pages/explorer.ts
import { renderProcessExplorer } from "../components/process-explorer.js";
import { renderClassDetail } from "../components/class-detail.js";
import { renderHookLog } from "../components/hook-log.js";

export function mountExplorerPage(host: HTMLElement): void {
    host.innerHTML = `
        <div id="exp-host"></div>
        <div id="cd-host"></div>
        <div id="hl-host"></div>
    `;
    host.style.display = "flex";
    host.style.flex = "1";
    host.style.minHeight = "0";

    const exp = renderProcessExplorer(host.querySelector<HTMLElement>("#exp-host")!);
    const cd = renderClassDetail(host.querySelector<HTMLElement>("#cd-host")!);
    renderHookLog(host.querySelector<HTMLElement>("#hl-host")!);

    exp.onClassSelect((fullName) => { void cd.show(fullName); });
}
```

- [ ] **Step 2: Update main.ts to route**

Replace the `#page-host` content insert with a router-based mount:

```ts
// app/frontend/main.ts (final)
import { connectWs, subscribe } from "./core/ws.js";
import { api } from "./core/api.js";
import { renderNavIcons, type NavTab } from "./components/nav-icons.js";
import { renderStatusBar } from "./components/status-bar.js";
import { mountExplorerPage } from "./pages/explorer.js";

const root = document.getElementById("app")!;
root.innerHTML = `
    <div class="titlebar">
        <span class="title">Frida IL2CPP Toolkit</span>
        <span class="kbd">⌘K</span>
        <span class="badge disconnected" id="conn-badge">disconnected</span>
    </div>
    <div class="main-row" id="main-row">
        <div id="nav-icons-host"></div>
        <div id="page-host"></div>
    </div>
    <div id="statusbar-host"></div>
`;

const sb = renderStatusBar(document.getElementById("statusbar-host")!);
const connBadge = document.getElementById("conn-badge")!;
const pageHost = document.getElementById("page-host")!;
pageHost.style.flex = "1";
pageHost.style.display = "flex";
pageHost.style.minHeight = "0";

function mountPage(tab: NavTab): void {
    pageHost.innerHTML = "";
    if (tab === "explorer") {
        mountExplorerPage(pageHost);
    } else {
        pageHost.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-faint)">${tab} (coming next task)</div>`;
    }
}

const navHandle = renderNavIcons(document.getElementById("nav-icons-host")!, {
    onSelect: (tab: NavTab) => {
        location.hash = `#/${tab}`;
        mountPage(tab);
    },
});

window.addEventListener("hashchange", () => {
    const tab = (location.hash.replace(/^#\//, "") || "explorer") as NavTab;
    navHandle.setActive(tab);
    mountPage(tab);
});

async function refreshProfile(): Promise<void> {
    try {
        const { profile } = await api.getProfile();
        if (profile) {
            sb.setConnection(`${profile.manifest.gameName} / ${profile.manifest.buildId.slice(0, 8)}`, true);
            connBadge.textContent = "connected";
            connBadge.classList.remove("disconnected");
        } else {
            sb.setConnection("no connection", false);
            connBadge.textContent = "disconnected";
            connBadge.classList.add("disconnected");
        }
    } catch (e) { console.warn("getProfile failed:", e); }
}

connectWs();
subscribe("profile-attached", refreshProfile);
subscribe("profile-detached", refreshProfile);
void refreshProfile();

const initialTab = (location.hash.replace(/^#\//, "") || "explorer") as NavTab;
navHandle.setActive(initialTab);
mountPage(initialTab);
```

- [ ] **Step 3: Smoke test**

```bash
cd app
npm run dev &
sleep 3
echo "Open http://localhost:5173 — should show layout with empty Process Explorer (no agent)"
kill %1 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
cd ..
git add app/frontend/pages/explorer.ts app/frontend/main.ts
git commit -m "feat(app): Explorer page composes Process Explorer + Class Detail + Hook Log"
```

---

## Task 19: Bookmarks + Migrations + Hooks pages

**Files:**
- Create: `app/frontend/pages/bookmarks.ts`
- Create: `app/frontend/pages/migrations.ts`
- Create: `app/frontend/pages/hooks.ts`
- Modify: `app/frontend/main.ts` (route to all four)

- [ ] **Step 1: bookmarks.ts**

```ts
// app/frontend/pages/bookmarks.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";

export function mountBookmarksPage(host: HTMLElement): void {
    host.innerHTML = `
        <div style="flex:1;padding:24px;overflow-y:auto">
            <h2 style="margin-top:0">Bookmarks</h2>
            <div id="bm-list"></div>
        </div>
    `;
    host.style.flex = "1";
    const list = host.querySelector<HTMLElement>("#bm-list")!;

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    async function refresh(): Promise<void> {
        try {
            const { bookmarks } = await api.getAnnotations();
            const labels = await api.getLabels();
            if (bookmarks.length === 0) {
                list.innerHTML = `<div style="color:var(--text-faint)">No bookmarks yet.</div>`;
                return;
            }
            list.innerHTML = bookmarks.map((k: any) => {
                const friendly = k.kind === "class" ? labels.classes[k.className]?.label : null;
                const display = friendly
                    ? `<span style="font-weight:500">${escape(friendly)}</span> <span style="color:var(--text-faint);font-family:var(--font-code);font-size:11px">[${escape(k.className)}]</span>`
                    : escape(k.className);
                return `
                    <div style="padding:8px 12px;border-radius:8px;background:var(--bg-tile);margin-bottom:6px;display:flex;align-items:center;gap:8px">
                        <span>⭐</span>
                        <span style="flex:1">${display}</span>
                        <button class="icon-btn-mini" data-open="${escape(k.className)}">Open</button>
                        <button class="icon-btn-mini" data-toggle='${JSON.stringify(k).replace(/'/g, "&#039;")}'>✗</button>
                    </div>
                `;
            }).join("");
            list.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => {
                b.addEventListener("click", () => { location.hash = `#/explorer`; setTimeout(() => {
                    window.dispatchEvent(new CustomEvent("frida:open-class", { detail: b.dataset.open }));
                }, 100); });
            });
            list.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((b) => {
                b.addEventListener("click", async () => {
                    const k = JSON.parse(b.dataset.toggle!);
                    await api.toggleBookmark(k);
                });
            });
        } catch (e) {
            list.innerHTML = `<div style="color:var(--danger)">${escape(String(e))}</div>`;
        }
    }

    subscribe("annotation-change", refresh);
    subscribe("profile-attached", refresh);
    void refresh();
}
```

- [ ] **Step 2: migrations.ts**

```ts
// app/frontend/pages/migrations.ts
import { api } from "../core/api.js";

export function mountMigrationsPage(host: HTMLElement): void {
    host.innerHTML = `
        <div style="flex:1;padding:24px;overflow-y:auto">
            <h2 style="margin-top:0">Migrations</h2>
            <div id="mig-content">Loading…</div>
        </div>
    `;
    host.style.flex = "1";
    const content = host.querySelector<HTMLElement>("#mig-content")!;

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    async function refresh(): Promise<void> {
        try {
            const { result } = await api.getMigrations();
            content.innerHTML = `
                <h3>Auto (${result.auto.length})</h3>
                ${result.auto.map((m: any) => `<div style="padding:6px 10px;background:var(--bg-tile);border-radius:6px;margin-bottom:4px">✓ ${escape(m.label)}: ${escape(m.oldObf)} → ${escape(m.newObf)}</div>`).join("") || '<div style="color:var(--text-faint)">none</div>'}
                <h3>Review (${result.review.length})</h3>
                ${result.review.map((m: any) => `
                    <div style="padding:8px 12px;background:var(--bg-tile);border-radius:6px;margin-bottom:4px">
                        <div>${escape(m.label)}: <code>${escape(m.oldObf)}</code></div>
                        ${m.candidates.map((c: any) => `
                            <button class="icon-btn-mini" data-accept="${escape(m.oldObf)}" data-new="${escape(c.newObf)}" style="margin-top:4px">→ ${escape(c.newObf)} (${c.score.toFixed(2)})</button>
                        `).join("")}
                        <button class="icon-btn-mini" style="margin-left:8px;color:var(--danger)" data-reject="${escape(m.oldObf)}">Reject all</button>
                    </div>
                `).join("") || '<div style="color:var(--text-faint)">none</div>'}
                <h3>Lost (${result.lost.length})</h3>
                ${result.lost.map((m: any) => `<div style="padding:6px 10px;color:var(--danger)">✗ ${escape(m.label)}: ${escape(m.oldObf)}</div>`).join("") || '<div style="color:var(--text-faint)">none</div>'}
            `;
            content.querySelectorAll<HTMLButtonElement>("[data-accept]").forEach((b) => {
                b.addEventListener("click", async () => {
                    await api.acceptMigration(b.dataset.accept!, b.dataset.new!);
                    refresh();
                });
            });
            content.querySelectorAll<HTMLButtonElement>("[data-reject]").forEach((b) => {
                b.addEventListener("click", async () => {
                    await api.rejectMigration(b.dataset.reject!);
                    refresh();
                });
            });
        } catch (e) {
            content.innerHTML = `<div style="color:var(--danger)">${escape(String(e))}</div>`;
        }
    }

    void refresh();
}
```

- [ ] **Step 3: hooks.ts**

```ts
// app/frontend/pages/hooks.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { StoredHook } from "../core/types.js";

export function mountHooksPage(host: HTMLElement): void {
    host.innerHTML = `
        <div style="flex:1;padding:24px;overflow-y:auto">
            <h2 style="margin-top:0;display:flex;align-items:center;gap:12px">Hooks
                <button class="pill" id="h-add">+ Add hook</button>
                <button class="pill" id="h-clear" style="margin-left:auto">Uninstall all</button>
            </h2>
            <div id="h-list">Loading…</div>
        </div>
    `;
    host.style.flex = "1";
    const list = host.querySelector<HTMLElement>("#h-list")!;
    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    async function refresh(): Promise<void> {
        const { hooks } = await api.getHooks();
        if (hooks.length === 0) {
            list.innerHTML = `<div style="color:var(--text-faint)">No hooks defined.</div>`;
            return;
        }
        list.innerHTML = hooks.map((h: StoredHook) => `
            <div style="padding:10px 14px;background:var(--bg-tile);border:1px solid var(--border-strong);border-radius:8px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
                <span style="font-family:var(--font-code);font-size:11px">${escape(h.spec.className)}.${escape(h.spec.methodName)}</span>
                <span class="kind-tag method" style="padding:2px 7px;border-radius:4px;font-size:9px;background:rgba(167,139,250,0.15);color:var(--method)">[${h.spec.template}]</span>
                <span style="color:${h.installedHookId ? "var(--success)" : "var(--text-faint)"};font-size:10px">${h.installedHookId ? "● installed" : "○ disarmed"}</span>
                <span style="margin-left:auto;display:flex;gap:4px">
                    ${h.installedHookId
                        ? `<button class="icon-btn-mini" data-uninstall="${h.id}">Uninstall</button>`
                        : `<button class="icon-btn-mini" data-install="${h.id}">Install</button>`
                    }
                    <button class="icon-btn-mini" data-remove="${h.id}" style="color:var(--danger)">Delete</button>
                </span>
            </div>
        `).join("");
        list.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((b) => b.addEventListener("click", () => api.installHook(b.dataset.install!)));
        list.querySelectorAll<HTMLButtonElement>("[data-uninstall]").forEach((b) => b.addEventListener("click", () => api.uninstallHook(b.dataset.uninstall!)));
        list.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => b.addEventListener("click", () => api.removeHook(b.dataset.remove!)));
    }

    host.querySelector("#h-add")!.addEventListener("click", async () => {
        const cls = prompt("Class fullName (e.g. Core.UILogic.Inventory):");
        if (!cls) return;
        const m = prompt(`Method name on ${cls}:`);
        if (!m) return;
        const t = prompt("Template (log/log-stack/noop/force-return):", "log");
        if (!t) return;
        try {
            const { stored } = await api.addHook({ template: t as any, className: cls, methodName: m });
            await api.installHook(stored.id);
        } catch (e) {
            alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
    host.querySelector("#h-clear")!.addEventListener("click", async () => {
        if (!confirm("Uninstall all hooks?")) return;
        await api.clearAllHooks();
    });

    subscribe("hook-store-change", refresh);
    void refresh();
}
```

- [ ] **Step 4: Update main.ts mountPage**

In `app/frontend/main.ts`, replace `mountPage` with:

```ts
import { mountBookmarksPage } from "./pages/bookmarks.js";
import { mountMigrationsPage } from "./pages/migrations.js";
import { mountHooksPage } from "./pages/hooks.js";

function mountPage(tab: NavTab): void {
    pageHost.innerHTML = "";
    if (tab === "explorer") mountExplorerPage(pageHost);
    else if (tab === "hooks") mountHooksPage(pageHost);
    else if (tab === "bookmarks") mountBookmarksPage(pageHost);
    else if (tab === "migrations") mountMigrationsPage(pageHost);
}
```

- [ ] **Step 5: Build + smoke**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit
```

- [ ] **Step 6: Commit**

```bash
cd ..
git add app/frontend/pages/ app/frontend/main.ts
git commit -m "feat(app): Bookmarks + Migrations + Hooks pages"
```

---

## Task 20: Process picker / attach UI

**Files:**
- Create: `app/frontend/components/process-picker.ts`
- Modify: `app/frontend/main.ts`

When no profile is attached, show a process picker overlay before any page renders.

- [ ] **Step 1: Append CSS**

```css
.modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
}
.modal {
    background: var(--bg-elevated); border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl); padding: 24px;
    width: 480px; max-height: 80vh; display: flex; flex-direction: column;
}
.modal h2 { margin: 0 0 12px; font-size: 16px; }
.modal .proc-list { flex: 1; overflow-y: auto; max-height: 50vh; }
.modal .proc-row {
    padding: 8px 12px; border-radius: 6px; cursor: pointer;
    display: flex; gap: 12px; align-items: center;
    font-family: var(--font-code); font-size: 11px;
}
.modal .proc-row:hover { background: var(--bg-tile); }
.modal .proc-pid { color: var(--text-faint); width: 60px; }
```

- [ ] **Step 2: process-picker.ts**

```ts
// app/frontend/components/process-picker.ts
import { api } from "../core/api.js";

export async function showProcessPicker(): Promise<void> {
    return new Promise(async (resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal">
                <h2>Pick a process to attach</h2>
                <input class="filter-mini" id="pp-filter" placeholder="Filter…" style="margin-bottom:8px;padding:6px 10px">
                <div class="proc-list" id="pp-list">Loading…</div>
                <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
                    <button class="pill" id="pp-cancel">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const list = overlay.querySelector<HTMLElement>("#pp-list")!;
        const filter = overlay.querySelector<HTMLInputElement>("#pp-filter")!;
        let processes: { pid: number; name: string }[] = [];

        function render(): void {
            const q = filter.value.toLowerCase();
            const filtered = processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q));
            list.innerHTML = filtered.map((p) => `
                <div class="proc-row" data-pid="${p.pid}">
                    <span class="proc-pid">${p.pid}</span>
                    <span>${p.name}</span>
                </div>
            `).join("");
            list.querySelectorAll<HTMLElement>(".proc-row").forEach((r) => {
                r.addEventListener("click", async () => {
                    const pid = parseInt(r.dataset.pid!, 10);
                    list.innerHTML = `Attaching to pid=${pid}…`;
                    try {
                        await api.attach(pid);
                        document.body.removeChild(overlay);
                        resolve();
                    } catch (e) {
                        list.innerHTML = `<div style="color:var(--danger);padding:1em">${e instanceof Error ? e.message : String(e)}</div>`;
                    }
                });
            });
        }

        filter.addEventListener("input", render);
        overlay.querySelector("#pp-cancel")!.addEventListener("click", () => {
            document.body.removeChild(overlay);
            resolve();
        });

        try {
            const { processes: result } = await api.listProcesses();
            processes = result;
            render();
        } catch (e) {
            list.innerHTML = `<div style="color:var(--danger);padding:1em">${e instanceof Error ? e.message : String(e)}</div>`;
        }
    });
}
```

- [ ] **Step 3: Wire in main.ts**

After `refreshProfile`, add:

```ts
import { showProcessPicker } from "./components/process-picker.js";

// Show the picker if no profile attached.
async function ensureAttached(): Promise<void> {
    const { profile } = await api.getProfile();
    if (!profile) await showProcessPicker();
}
void ensureAttached();
```

Also add a "Attach…" button in the titlebar by appending to the titlebar HTML:

```html
<button class="pill" id="attach-btn" style="margin-left:auto">Attach…</button>
```

(Move `#conn-badge` after the attach button.)

Wire:

```ts
document.getElementById("attach-btn")!.addEventListener("click", () => {
    void showProcessPicker();
});
```

- [ ] **Step 4: Build + smoke**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
cd ..
git add app/frontend/components/process-picker.ts app/frontend/main.ts app/frontend/styles/app.css
git commit -m "feat(app): process picker overlay + attach button"
```

---

## Task 21: Command palette ⌘K

**Files:**
- Create: `app/frontend/components/command-palette.ts`
- Modify: `app/frontend/main.ts`

- [ ] **Step 1: Append CSS**

```css
.cmdk-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2000;
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: 15vh;
}
.cmdk {
    background: var(--bg-elevated); border: 1px solid var(--indigo-border);
    border-radius: var(--radius-xl);
    width: 600px; max-height: 60vh;
    display: flex; flex-direction: column;
    box-shadow: var(--indigo-glow), 0 16px 40px rgba(0,0,0,0.5);
}
.cmdk-input {
    background: transparent; border: none; outline: none;
    padding: 16px 20px; font-size: 14px; color: var(--text-primary);
    border-bottom: 1px solid var(--border);
}
.cmdk-results { overflow-y: auto; padding: 4px; }
.cmdk-row {
    padding: 8px 12px; border-radius: var(--radius);
    display: flex; gap: 10px; align-items: center; cursor: pointer;
    font-size: 12px;
}
.cmdk-row:hover, .cmdk-row.active {
    background: linear-gradient(90deg, var(--indigo-bg), transparent);
}
.cmdk-row .icon { color: var(--text-faint); }
.cmdk-row .label { flex: 1; }
.cmdk-row .meta { color: var(--text-faint); font-size: 10px; font-family: var(--font-code); }
```

- [ ] **Step 2: command-palette.ts**

```ts
// app/frontend/components/command-palette.ts
import { api } from "../core/api.js";

interface PaletteItem {
    label: string;
    meta?: string;
    icon?: string;
    action: () => void;
}

let _open = false;

export function bindPaletteShortcut(): void {
    document.addEventListener("keydown", (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
            ev.preventDefault();
            if (!_open) void open();
        } else if (ev.key === "Escape" && _open) {
            close();
        }
    });
}

let _overlay: HTMLDivElement | null = null;

async function open(): Promise<void> {
    _open = true;
    _overlay = document.createElement("div");
    _overlay.className = "cmdk-overlay";
    _overlay.innerHTML = `
        <div class="cmdk">
            <input class="cmdk-input" id="cmdk-input" placeholder="Search classes / methods / fields, or type a command (:hooks, :bookmarks)…" autofocus>
            <div class="cmdk-results" id="cmdk-results">Type to search…</div>
        </div>
    `;
    _overlay.addEventListener("click", (ev) => { if (ev.target === _overlay) close(); });
    document.body.appendChild(_overlay);
    const input = _overlay.querySelector<HTMLInputElement>("#cmdk-input")!;
    const results = _overlay.querySelector<HTMLElement>("#cmdk-results")!;
    let activeIdx = 0;
    let items: PaletteItem[] = [];

    const commands: PaletteItem[] = [
        { label: "Open Hooks", icon: "🪝", action: () => { location.hash = "#/hooks"; } },
        { label: "Open Bookmarks", icon: "⭐", action: () => { location.hash = "#/bookmarks"; } },
        { label: "Open Migrations", icon: "🔄", action: () => { location.hash = "#/migrations"; } },
        { label: "Detach", icon: "⏏", action: async () => { await api.detach(); } },
    ];

    let labelsCache: any = null;

    async function rebuild(query: string): Promise<void> {
        const q = query.trim().toLowerCase();
        if (!q) {
            items = commands;
            renderItems();
            return;
        }
        // Commands matching
        const cmdMatches = commands.filter((c) => c.label.toLowerCase().includes(q));
        // Class search via labels (cheap)
        if (!labelsCache) {
            try { labelsCache = await api.getLabels(); }
            catch { labelsCache = { classes: {}, methods: {}, fields: {} }; }
        }
        const classMatches: PaletteItem[] = [];
        for (const [obf, entry] of Object.entries<any>(labelsCache.classes ?? {})) {
            if (classMatches.length >= 50) break;
            if (entry.label.toLowerCase().includes(q) || obf.toLowerCase().includes(q)) {
                classMatches.push({
                    label: entry.label,
                    meta: obf,
                    icon: "🔷",
                    action: () => {
                        location.hash = "#/explorer";
                        setTimeout(() => window.dispatchEvent(new CustomEvent("frida:open-class", { detail: obf })), 100);
                    },
                });
            }
        }
        items = [...cmdMatches, ...classMatches];
        renderItems();
    }

    function renderItems(): void {
        if (items.length === 0) { results.innerHTML = `<div style="padding:1em;color:var(--text-faint)">No matches.</div>`; return; }
        results.innerHTML = items.map((it, i) => `
            <div class="cmdk-row${i === activeIdx ? " active" : ""}" data-idx="${i}">
                <span class="icon">${it.icon ?? "·"}</span>
                <span class="label">${escape(it.label)}</span>
                ${it.meta ? `<span class="meta">${escape(it.meta)}</span>` : ""}
            </div>
        `).join("");
        results.querySelectorAll<HTMLElement>(".cmdk-row").forEach((r) => {
            r.addEventListener("click", () => { runItem(parseInt(r.dataset.idx!, 10)); });
        });
    }

    function runItem(i: number): void {
        const it = items[i];
        if (!it) return;
        close();
        it.action();
    }

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    input.addEventListener("input", () => { void rebuild(input.value); });
    input.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowDown") { activeIdx = Math.min(items.length - 1, activeIdx + 1); renderItems(); ev.preventDefault(); }
        else if (ev.key === "ArrowUp") { activeIdx = Math.max(0, activeIdx - 1); renderItems(); ev.preventDefault(); }
        else if (ev.key === "Enter") { runItem(activeIdx); ev.preventDefault(); }
    });

    void rebuild("");
}

function close(): void {
    if (_overlay) { document.body.removeChild(_overlay); _overlay = null; }
    _open = false;
}
```

- [ ] **Step 3: Wire in main.ts**

```ts
import { bindPaletteShortcut } from "./components/command-palette.js";
bindPaletteShortcut();
```

- [ ] **Step 4: Build + smoke**

```bash
cd app && npx tsc -p tsconfig.frontend.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
cd ..
git add app/frontend/components/command-palette.ts app/frontend/main.ts app/frontend/styles/app.css
git commit -m "feat(app): ⌘K command palette (commands + class search)"
```

---

## Task 22: Smoke test the full app end-to-end

This task is procedural — run the app against a real Frida target and verify the flow.

- [ ] **Step 1: Build agent**

```bash
cd /f/FridaIL2CPPToolkit
npm run build:rpc
```

- [ ] **Step 2: Start the app in dev mode**

```bash
cd app
npm run dev
```

Expected: backend logs `[frida-toolkit] backend listening on http://127.0.0.1:3001` AND Vite logs the frontend dev URL `http://localhost:5173`.

- [ ] **Step 3: Open the frontend**

Open http://localhost:5173 in a browser. Confirm:
- Titlebar shows "disconnected" badge.
- Process picker overlay opens automatically.

- [ ] **Step 4: Attach to a Frida-eligible process**

Pick any local process (Notepad, Chrome, or your Dofus client). Click → confirm:
- The picker closes.
- Titlebar shows "connected" badge.
- Status bar shows `<game-name> / <buildId-prefix>`.
- Process Explorer panel populates with assemblies.

- [ ] **Step 5: Browse + filter**

- Expand an assembly → namespaces appear.
- Expand a namespace → classes appear.
- Type in the explorer filter input → tree filters live.
- Click a class → Class Detail page renders with Fields and Methods sections.

- [ ] **Step 6: Hook flow**

- Click 🪝 Hook on a method → prompt for template → pick `log`.
- Trigger the method in the target app → events appear in the right-panel Stream.
- Switch to Summary tab → counts visible.
- Switch to Hooks tab → see the active hook with Uninstall/Delete buttons.

- [ ] **Step 7: Persistence**

- Detach (`⌘K` → "Detach" or via attach button).
- Re-attach to the SAME process → hooks should reappear (disarmed) in the Hooks tab.
- Verify storage:

```bash
cat ~/.frida-toolkit/profiles/<game>/<buildId>/plugins/hooks/storage.json
```

Should contain the hooks added.

- [ ] **Step 8: ⌘K palette**

- Press `Ctrl+K` (Windows) or `⌘K` (mac).
- Type "Open Hooks" → press Enter → page switches to Hooks.
- Type a class name (e.g. "Inventory") → labeled classes appear → Enter to navigate.

- [ ] **Step 9: Bookmarks + Migrations**

- Bookmark a class via the Class Detail page → click ⭐ button.
- Switch to Bookmarks page (nav-icons) → bookmark visible.
- Switch to Migrations page → empty if no derived profile, otherwise shows migration result.

- [ ] **Step 10: Document any bugs**

If any step fails, note the bug. Fix in subsequent tasks. If all 10 steps pass, the smoke is green.

- [ ] **Step 11: Commit a SMOKE-TEST.md**

```bash
cat > app/SMOKE-TEST.md <<'EOF'
# Smoke test

Run `npm run dev` from `app/`, open http://localhost:5173, and walk through:

1. Process picker overlay appears at boot when no profile attached.
2. Pick a process → titlebar shows "connected", Process Explorer populates.
3. Filter the explorer → live filtering of visible nodes.
4. Click a class → Class Detail renders Fields + Methods.
5. Hook a method (🪝 button) → events appear in right-panel Stream tab.
6. Switch to Summary tab → counts per hook.
7. Switch to Hooks tab → list of installed hooks with Uninstall/Delete.
8. Detach + re-attach → hooks reappear (disarmed) on the SAME profile.
9. Press ⌘K → command palette opens, type a class name, Enter to navigate.
10. Bookmarks page lists ⭐ classes; Migrations page shows pending review entries.
EOF
git add app/SMOKE-TEST.md
git commit -m "docs(app): SMOKE-TEST checklist for v2.0"
```

---

## Task 23: Drop the VSCode extension

This is the final cleanup task. Only run after Task 22 smoke is fully green.

- [ ] **Step 1: Confirm the new app runs end-to-end**

Re-run the smoke test from Task 22. If anything still fails, fix first; do not proceed.

- [ ] **Step 2: Remove the extension**

```bash
cd /f/FridaIL2CPPToolkit
git rm -r dofus-app/vscode-extension/
```

- [ ] **Step 3: Update top-level README to point at app/**

Open `README.md` (or whatever exists at the root) and replace any "VSCode extension" instructions with a pointer to `app/README.md`.

If no top-level README is meaningful, skip.

- [ ] **Step 4: Update top-level package.json scripts**

Add convenience scripts at the repo root for the common workflow:

In `f:/FridaIL2CPPToolkit/package.json`, append to `scripts`:

```json
"app:dev": "cd app && npm run dev",
"app:build": "cd app && npm run build",
"app:start": "cd app && npm start"
```

- [ ] **Step 5: Verify the agent still builds**

```bash
cd /f/FridaIL2CPPToolkit
npm run build:rpc
```

Expected: clean.

- [ ] **Step 6: Verify the app still builds and tests pass**

```bash
cd app
npm test
npm run build
```

Expected: tests pass, dist/backend + dist/frontend created.

- [ ] **Step 7: Commit**

```bash
cd /f/FridaIL2CPPToolkit
git add -A
git commit -m "$(cat <<'EOF'
chore: remove vscode-extension — replaced by app/ (v2.0)

The localhost web app under app/ has full feature parity with the
former extension and is now the canonical UI. Existing user data
(profiles in ~/.frida-toolkit/) continues to work unchanged.

Top-level package.json gains app:dev / app:build / app:start
convenience scripts.

Smoke test passed (see app/SMOKE-TEST.md).
EOF
)"
```

- [ ] **Step 8: Push the branch**

```bash
git push -u origin localhost-v2
```

---

## Self-Review

After completing all tasks, verify against the spec:

**Spec coverage:**
- ✅ Backend Express + WS bootstrap on localhost:3001 — Tasks 1, 5, 11
- ✅ Single Node process, frida-node embedded — Tasks 3, 4
- ✅ HTTP routes (api-call, profile, labels, annotations, hooks, migrations) — Tasks 5–10
- ✅ WebSocket bridge for `send()` events + change events — Task 11
- ✅ Frontend Vanilla TS + Vite, theme tokens — Task 12
- ✅ Frontend api/ws/store core — Task 13
- ✅ Layout shell (nav-icons + statusbar) — Task 14
- ✅ Process Explorer (lazy expand + filter) — Task 15
- ✅ Class Detail (parsed dump + Hook/Trace/Copy + filter) — Task 16
- ✅ Hook Log (Stream/Summary/Hooks tabs + filter + export) — Task 17
- ✅ Pages: Explorer, Bookmarks, Migrations, Hooks — Tasks 18, 19
- ✅ Process picker — Task 20
- ✅ ⌘K command palette — Task 21
- ✅ Smoke test checklist — Task 22
- ✅ Drop VSCode extension — Task 23

**Reuse claim** (≥80% of v1 modules): Task 2 copies 13 vscode-free files across labels/annotations/profile/paths/storage/types/detect/migrations/search-filters + 4 hook files. Tests run unchanged.

**Style/visual**: theme.css (Task 12) implements the validated indigo + dark OLED palette from the hybrid mockup. Components reference `var(--indigo)`, `var(--indigo-bg)`, etc. consistently.

**Persistence**: unchanged — backend reads/writes the same JSON files at `~/.frida-toolkit/profiles/...` (the copied `ProfileManager` and `DiskPluginStorage` are byte-identical to v1).

**Open questions from spec deferred to impl**:
- Multi-tab persistance: NOT implemented (single class detail at a time for v2.0); deferred — `app/frontend/core/tabs.ts` not created.
- Command palette scope: implemented as commands + class search (no method/field search); could extend if needed.
- Hot-reload during dev: handled by Vite HMR + WS auto-reconnect.

---

## Notes for the implementer

- All files use ESM (`"type": "module"` in `app/package.json`). Imports include `.js` extensions even for `.ts` source — TypeScript with `moduleResolution: Node16/Bundler` requires this.
- `tsx` is used in dev for hot-reloading the backend without a build step.
- Frontend hot-reload is automatic via Vite. Backend hot-reload via `tsx watch`.
- The `concurrently` package runs both dev servers in one terminal with prefixed logs.
- All routes use `express.json()` body parsing — request bodies are JSON.
- Errors propagate with HTTP 500 + `{ error: string }` body. The frontend `api.ts` throws.
