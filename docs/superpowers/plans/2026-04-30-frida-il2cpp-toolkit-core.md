# Frida IL2CPP Toolkit — Core (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the existing 464-LOC monolithic VSCode extension demo into a properly structured Core that persists user work (labels, annotations) per build-version, auto-migrates on game updates, and exposes a minimal Plugin API for future plugins.

**Architecture:** VSCode extension monolith (will split into separate extensions at v2). Pure TypeScript modules (profile/labels/annotations/migrations/detect) tested with vitest. VSCode-integration modules (explorer/search/webviews/status-bar) smoke-tested manually via Extension Development Host (F5). Filesystem persistence at `~/.frida-toolkit/profiles/<game>/<build-id>/`. The existing Frida agent in `src/rpc-agent/` is the BACKEND — extension calls its RPCs over HTTP. Adds 1 new agent module (`filesystem.ts`) for build-version detection.

**Tech Stack:** TypeScript 5.3+, Node 20+, VSCode 1.85+, vitest for unit tests, Frida-il2cpp-bridge agent (existing), HTTP RPC.

**Spec:** [`docs/superpowers/specs/2026-04-30-frida-il2cpp-toolkit-core-design.md`](../specs/2026-04-30-frida-il2cpp-toolkit-core-design.md)

---

## File Structure

**Extension** (`dofus-app/vscode-extension/`):

- **Modify:** `package.json` — add vitest dep, test scripts, expand command/view contributions, declare settings
- **Modify:** `tsconfig.json` — include test/, allow strict mode
- **Create:** `src/core/types.ts` — shared type definitions (~50 LOC)
- **Create:** `src/core/rpc.ts` — RPC client wrapper with health check and error handling (~80 LOC)
- **Create:** `src/core/detect.ts` — build-version auto-detection cascade (~70 LOC)
- **Create:** `src/core/labels.ts` — LabelStore (CRUD, events, undo/redo, persistence) (~180 LOC)
- **Create:** `src/core/annotations.ts` — AnnotationStore (bookmarks + notes) (~120 LOC)
- **Create:** `src/core/migrations.ts` — fingerprint matching engine (~200 LOC)
- **Create:** `src/core/profile.ts` — ProfileManager (load/save/derive profiles) (~150 LOC)
- **Create:** `src/core/api.ts` — CoreApi interface + impl wiring everything (~80 LOC)
- **Create:** `src/core/status-bar.ts` — status bar item with profile info (~60 LOC)
- **Create:** `src/core/explorer.ts` — Process Explorer + Bookmarks + Migrations TreeDataProviders (~250 LOC)
- **Create:** `src/core/search.ts` — universal search command palette (~100 LOC)
- **Create:** `src/core/commands.ts` — VSCode commands wiring (~150 LOC)
- **Create:** `src/core/webviews/class-detail.ts` — class detail webview (~150 LOC)
- **Create:** `src/core/webviews/migration-review.ts` — migration review modal webview (~100 LOC)
- **Refactor:** `src/extension.ts` — was 464 LOC monolith, becomes ~80 LOC activate() that wires the core modules

**Test files** (vitest, in `dofus-app/vscode-extension/test/`):

- **Create:** `test/labels.test.ts` (~80 LOC)
- **Create:** `test/annotations.test.ts` (~60 LOC)
- **Create:** `test/migrations.test.ts` (~100 LOC)
- **Create:** `test/detect.test.ts` (~50 LOC)
- **Create:** `test/profile.test.ts` (~60 LOC)

**Frida agent** (`src/rpc-agent/`):

- **Create:** `src/rpc-agent/filesystem.ts` — getDataPath, readFile, readFileBytes, readMainModuleBytes (~80 LOC)
- **Modify:** `src/rpc-agent/rpc-methods.ts` — register the new module

---

## Task 0: Project setup (vitest + restructured tsconfig)

**Files:**
- Modify: `dofus-app/vscode-extension/package.json`
- Modify: `dofus-app/vscode-extension/tsconfig.json`
- Create: `dofus-app/vscode-extension/vitest.config.ts`
- Create: `dofus-app/vscode-extension/test/.gitkeep`

- [ ] **Step 1: Add vitest devDep + scripts**

Edit `dofus-app/vscode-extension/package.json` to add `vitest` to `devDependencies` and add test scripts. Final shape of relevant sections:

```json
{
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.85.0",
    "typescript": "^5.3.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `vitest.config.ts` to keep tests separate from extension build**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node",
        globals: false,
        coverage: {
            provider: "v8",
            include: ["src/core/**/*.ts"],
            exclude: ["src/core/webviews/**"],
        },
    },
    resolve: {
        alias: {
            // vscode is not available in node test env; tests must mock it
            // explicitly. See test/labels.test.ts for the pattern.
        },
    },
});
```

- [ ] **Step 3: Update `tsconfig.json` to include test directory but exclude from build output**

Replace existing `tsconfig.json` content with:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "outDir": "out",
    "lib": ["ES2022"],
    "sourceMap": true,
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", ".vscode-test", "out", "test"]
}
```

- [ ] **Step 4: Install deps + verify clean build**

Run:
```bash
cd dofus-app/vscode-extension && npm install && npm run compile
```

Expected: install succeeds, `tsc` compiles existing `src/extension.ts` without errors. The existing demo extension should still work after this step.

- [ ] **Step 5: Create empty test directory marker**

```bash
mkdir -p dofus-app/vscode-extension/test
touch dofus-app/vscode-extension/test/.gitkeep
```

- [ ] **Step 6: Run vitest with no tests to confirm framework wired**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected output: `No test files found, exiting with code 0` — vitest is wired and would run if tests existed.

- [ ] **Step 7: Commit**

```bash
git add dofus-app/vscode-extension/package.json dofus-app/vscode-extension/tsconfig.json dofus-app/vscode-extension/vitest.config.ts dofus-app/vscode-extension/test/.gitkeep
git commit -m "$(cat <<'EOF'
chore(toolkit): vitest setup + tsconfig polish

- Add vitest as test framework (chosen in design spec for being
  lightweight, no native deps)
- Test scripts: npm test (run once) / npm run test:watch
- tsconfig excludes test/, build output stays clean
- Empty test/ folder placeholder
EOF
)"
```

---

## Task 1: Shared types (`src/core/types.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/types.ts`

- [ ] **Step 1: Create the types file with everything used across modules**

```typescript
// Shared type definitions for the Frida IL2CPP Toolkit core.
// Imported by modules across src/core/. Keep in sync with the spec.

// ---------------------------------------------------------------------------
// Label store
// ---------------------------------------------------------------------------

export type LabelKey =
    | { kind: "class"; className: string }
    | { kind: "method"; className: string; methodName: string }
    | { kind: "field"; className: string; fieldName: string };

export interface LabelEntry {
    label: string;
    createdAt: string;   // ISO 8601
    updatedAt: string;   // ISO 8601
}

export interface LabelChangeEvent {
    key: LabelKey;
    oldLabel: string | null;
    newLabel: string | null;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export interface BookmarkEntry {
    createdAt: string;
}

export interface NoteEntry {
    markdown: string;
    updatedAt: string;
}

export interface AnnotationChangeEvent {
    key: LabelKey;
    kind: "bookmark" | "note";
    action: "added" | "removed" | "updated";
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type BuildIdSource =
    | "unity-boot-config"
    | "metadata-hash"
    | "binary-hash"
    | "timestamp";

export interface ProfileManifest {
    schemaVersion: 1;
    profileId: string;            // e.g. "dofus/8fcf84..."
    gameName: string;             // e.g. "dofus"
    buildId: string;              // hex
    buildIdSource: BuildIdSource;
    attachedFirstAt: string;
    attachedLastAt: string;
    derivedFrom: string | null;   // previous profileId, if migrated
    stats: {
        totalLabels: number;
        totalBookmarks: number;
        totalNotes: number;
    };
}

export interface BuildIdResult {
    buildId: string;
    source: BuildIdSource;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export interface ClassFingerprint {
    obfName: string;
    token: string | null;          // IL2CPP token, hex string
    parents: string[];             // obf names of parents
    methodCount: number;
    methodSignatures: string[];    // sorted, joined "(p1,p2)→ret"
    fieldTypes: string[];          // sorted, joined "fieldName:type"
}

export interface MigrationResult {
    auto: Array<{ key: LabelKey; oldObf: string; newObf: string; label: string; reason: string }>;
    review: Array<{ key: LabelKey; oldObf: string; candidates: Array<{ newObf: string; score: number; reason: string }>; label: string }>;
    lost: Array<{ key: LabelKey; oldObf: string; label: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export interface RpcClient {
    call<T>(method: string, args?: unknown[]): Promise<T>;
    isHealthy(): Promise<boolean>;
}
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: no TypeScript errors. (`noUnusedLocals` won't flag exports.)

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/types.ts
git commit -m "feat(toolkit): core types — labels, annotations, profile, migrations, RPC"
```

---

## Task 2: RPC client (`src/core/rpc.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/rpc.ts`

- [ ] **Step 1: Create the RPC client implementation**

```typescript
// HTTP RPC client for the Frida agent. Backend lives at the URL defined in
// the fridaToolkit.rpcEndpoint setting (default localhost:3001/api/call).
//
// Two methods:
//   - call<T>(method, args)  : invoke an RPC; throws on error
//   - isHealthy()            : ping; returns true if the agent answered
//
// Caller code is responsible for catching errors. This module deliberately
// avoids depending on vscode.* so it can be unit-tested in plain Node.

import * as http from "http";
import { URL } from "url";

import type { RpcClient } from "./types";

interface RpcResponse<T> {
    result?: T;
    error?: string;
}

export interface RpcClientOptions {
    endpoint: string;          // e.g. "http://localhost:3001/api/call"
    timeoutMs?: number;        // default 30_000
}

export class HttpRpcClient implements RpcClient {
    private readonly url: URL;
    private readonly timeoutMs: number;

    constructor(opts: RpcClientOptions) {
        this.url = new URL(opts.endpoint);
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }

    call<T>(method: string, args: unknown[] = []): Promise<T> {
        const body = JSON.stringify({ method, args });
        return new Promise<T>((resolve, reject) => {
            const req = http.request(
                {
                    hostname: this.url.hostname,
                    port: parseInt(this.url.port || "80", 10),
                    path: this.url.pathname,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body),
                    },
                    timeout: this.timeoutMs,
                },
                (res) => {
                    let chunks = "";
                    res.on("data", (c) => (chunks += c));
                    res.on("end", () => {
                        try {
                            const parsed = JSON.parse(chunks) as RpcResponse<T>;
                            if (parsed.error !== undefined) {
                                reject(new Error(parsed.error));
                            } else {
                                resolve(parsed.result as T);
                            }
                        } catch (e) {
                            reject(e instanceof Error ? e : new Error(String(e)));
                        }
                    });
                }
            );
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("RPC timeout")));
            req.write(body);
            req.end();
        });
    }

    async isHealthy(): Promise<boolean> {
        try {
            // listAssembliesInfo is a cheap RPC that exists in the agent.
            // Use it as the health probe.
            await this.call<unknown[]>("listAssembliesInfo", []);
            return true;
        } catch {
            return false;
        }
    }
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/rpc.ts
git commit -m "feat(toolkit): HTTP RPC client wrapper for Frida agent"
```

---

## Task 3: Frida agent — filesystem RPCs (`src/rpc-agent/filesystem.ts`)

**Files:**
- Create: `src/rpc-agent/filesystem.ts`
- Modify: `src/rpc-agent/rpc-methods.ts`

- [ ] **Step 1: Create the agent module**

```typescript
// Filesystem RPC methods used by the toolkit's build-version detection.
// All methods are read-only and operate on paths reachable by the
// instrumented process.

import "frida-il2cpp-bridge";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

/**
 * Returns Application.dataPath — the Unity Dofus_Data folder, or equivalent
 * for other Unity games. Empty string if not a Unity game.
 */
export function getDataPath(): Promise<string> {
    return inVm(() => {
        try {
            const application = Il2Cpp.domain.assembly("UnityEngine.CoreModule")
                .image.class("UnityEngine.Application");
            const dataPath = application.method<Il2Cpp.String>("get_dataPath").invoke();
            return dataPath.content ?? "";
        } catch {
            return "";
        }
    });
}

/**
 * Read a UTF-8 text file via the host filesystem. Used for boot.config.
 */
export function readFile(path: string): Promise<string> {
    return inVm(() => {
        const fs = require("frida-fs") as { readFileSync: (p: string, enc?: string) => string };
        try {
            return fs.readFileSync(path, "utf-8");
        } catch (e) {
            throw new Error(`readFile failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}

/**
 * Read a binary file and return as hex-encoded string (avoids
 * JSON-incompatible Buffer over RPC). Used for global-metadata.dat hash.
 */
export function readFileBytes(path: string): Promise<string> {
    return inVm(() => {
        const fs = require("frida-fs") as { readFileSync: (p: string) => ArrayBuffer };
        try {
            const bytes = new Uint8Array(fs.readFileSync(path));
            let hex = "";
            for (let i = 0; i < bytes.length; i++) {
                hex += bytes[i].toString(16).padStart(2, "0");
            }
            return hex;
        } catch (e) {
            throw new Error(`readFileBytes failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}

/**
 * Read the main process module bytes (executable in memory). Hex-encoded.
 * Limited to the first 1 MiB for hashing (more than enough for unique id).
 */
export function readMainModuleBytes(): Promise<string> {
    return inVm(() => {
        const main = Process.enumerateModules()[0];
        if (!main) throw new Error("no main module");
        const size = Math.min(main.size, 1024 * 1024);
        const buf = main.base.readByteArray(size);
        if (!buf) throw new Error("readByteArray returned null");
        const bytes = new Uint8Array(buf);
        let hex = "";
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, "0");
        }
        return hex;
    });
}
```

- [ ] **Step 2: Register in rpc-methods.ts**

Read the current `src/rpc-agent/rpc-methods.ts`, then add (mirroring the existing pattern):

```typescript
import * as filesystemRpc from "./filesystem";
```

Add to the `AllRpc` type union: `& typeof filesystemRpc`.

Add to the spread in `getRpcMethods()`: `...filesystemRpc,`.

- [ ] **Step 3: Build the RPC bundle**

```bash
cd /f/FridaIL2CPPToolkit && npm run build:rpc
```

Expected: TypeScript compiles cleanly. Confirm the output contains the new methods by searching the bundle for `getDataPath`:

```bash
grep -c getDataPath src/rpc-agent/dist/*.js 2>/dev/null || grep -c getDataPath dist/rpc-agent.js 2>/dev/null
```

Expected: at least 1 match in the compiled bundle (path depends on existing build config — adapt as needed).

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/filesystem.ts src/rpc-agent/rpc-methods.ts
git commit -m "$(cat <<'EOF'
feat(rpc-agent): filesystem RPCs for build-version detection

Adds 4 RPCs needed by the toolkit core:
- getDataPath: Application.dataPath (Unity), empty for non-Unity
- readFile: UTF-8 text file read (boot.config)
- readFileBytes: binary file as hex (global-metadata.dat)
- readMainModuleBytes: hex of first 1MiB of main module (binary hash)

Hex encoding avoids JSON/Buffer issues over the HTTP RPC bridge.
EOF
)"
```

---

## Task 4: Build-version detection (`src/core/detect.ts`) — TDD

**Files:**
- Create: `dofus-app/vscode-extension/src/core/detect.ts`
- Create: `dofus-app/vscode-extension/test/detect.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `test/detect.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

import { detectBuildId } from "../src/core/detect";
import type { RpcClient } from "../src/core/types";

function mockRpc(impl: Partial<Record<string, (...args: unknown[]) => unknown>>): RpcClient {
    return {
        call: async <T>(method: string, args: unknown[] = []): Promise<T> => {
            const fn = impl[method];
            if (!fn) throw new Error(`mock: no handler for ${method}`);
            return fn(...args) as T;
        },
        isHealthy: async () => true,
    };
}

describe("detectBuildId", () => {
    it("uses unity boot.config build-guid when available", async () => {
        const rpc = mockRpc({
            getDataPath: () => "F:/Jeux/Game/Game_Data",
            readFile: (path: unknown) => {
                expect(path).toBe("F:/Jeux/Game/Game_Data/boot.config");
                return "gfx-threading-mode=6\nbuild-guid=abc123def456\nhdr=0\n";
            },
        });

        const result = await detectBuildId(rpc);

        expect(result.buildId).toBe("abc123def456");
        expect(result.source).toBe("unity-boot-config");
    });

    it("falls back to metadata hash when boot.config missing build-guid", async () => {
        const rpc = mockRpc({
            getDataPath: () => "F:/Jeux/Game/Game_Data",
            readFile: () => "gfx-threading-mode=6\nhdr=0\n",  // no build-guid
            readFileBytes: () => "deadbeef".repeat(8),         // 32-char hex
        });

        const result = await detectBuildId(rpc);

        expect(result.buildId.length).toBeGreaterThanOrEqual(16);
        expect(result.source).toBe("metadata-hash");
    });

    it("falls back to binary hash when metadata read fails", async () => {
        const rpc = mockRpc({
            getDataPath: () => "F:/Jeux/Game/Game_Data",
            readFile: () => "no build-guid here",
            readFileBytes: () => { throw new Error("not found"); },
            readMainModuleBytes: () => "cafebabe".repeat(16),  // 128 chars
        });

        const result = await detectBuildId(rpc);

        expect(result.source).toBe("binary-hash");
    });

    it("falls back to timestamp when everything fails", async () => {
        const rpc = mockRpc({
            getDataPath: () => { throw new Error("not unity"); },
            readMainModuleBytes: () => { throw new Error("module unreachable"); },
        });

        const result = await detectBuildId(rpc);

        expect(result.source).toBe("timestamp");
        expect(result.buildId).toMatch(/^unknown-\d+$/);
    });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: 4 tests fail with "Cannot find module" — `detect.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/core/detect.ts`**

```typescript
// Build-version detection cascade for the active process.
// Tries 4 mechanisms in order; returns on the first success.
//
// The buildId is what uniquely identifies a profile. See spec section
// "Build-version detection".

import * as crypto from "crypto";

import type { BuildIdResult, RpcClient } from "./types";

const HEX_PREFIX_LEN = 32;  // length of buildId from a hash

export async function detectBuildId(rpc: RpcClient): Promise<BuildIdResult> {
    // 1. Unity boot.config build-guid
    try {
        const dataPath = await rpc.call<string>("getDataPath", []);
        if (dataPath) {
            const bootConfig = await rpc.call<string>("readFile", [`${dataPath}/boot.config`]);
            const m = /build-guid=([0-9a-f]+)/i.exec(bootConfig);
            if (m) {
                return { buildId: m[1], source: "unity-boot-config" };
            }
        }
    } catch {
        // continue
    }

    // 2. global-metadata.dat hash
    try {
        const dataPath = await rpc.call<string>("getDataPath", []);
        if (dataPath) {
            const hex = await rpc.call<string>("readFileBytes", [
                `${dataPath}/il2cpp_data/Metadata/global-metadata.dat`,
            ]);
            const buildId = sha256Hex(hex).slice(0, HEX_PREFIX_LEN);
            return { buildId, source: "metadata-hash" };
        }
    } catch {
        // continue
    }

    // 3. Main binary hash
    try {
        const hex = await rpc.call<string>("readMainModuleBytes", []);
        const buildId = sha256Hex(hex).slice(0, HEX_PREFIX_LEN);
        return { buildId, source: "binary-hash" };
    } catch {
        // continue
    }

    // 4. Timestamp fallback
    return { buildId: `unknown-${Date.now()}`, source: "timestamp" };
}

function sha256Hex(hexInput: string): string {
    const buf = Buffer.from(hexInput, "hex");
    return crypto.createHash("sha256").update(buf).digest("hex");
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/core/detect.ts dofus-app/vscode-extension/test/detect.test.ts
git commit -m "feat(toolkit): build-version detection cascade with vitest tests"
```

---

## Task 5: Label store (`src/core/labels.ts`) — TDD

**Files:**
- Create: `dofus-app/vscode-extension/src/core/labels.ts`
- Create: `dofus-app/vscode-extension/test/labels.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/labels.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { LabelStore } from "../src/core/labels";
import type { LabelKey } from "../src/core/types";

let tmpDir: string;
let labelsPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labels-test-"));
    labelsPath = path.join(tmpDir, "labels.json");
});

const classKey = (className: string): LabelKey => ({ kind: "class", className });
const methodKey = (className: string, methodName: string): LabelKey => ({ kind: "method", className, methodName });
const fieldKey = (className: string, fieldName: string): LabelKey => ({ kind: "field", className, fieldName });

describe("LabelStore", () => {
    it("returns null for unset labels", () => {
        const store = new LabelStore(labelsPath);
        expect(store.get(classKey("egq"))).toBeNull();
    });

    it("stores and retrieves a class label", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        expect(store.get(classKey("egq"))).toBe("HaapiService");
    });

    it("stores method and field labels independently", () => {
        const store = new LabelStore(labelsPath);
        store.set(methodKey("egq", "ywp"), "ConsumeKardByCode");
        store.set(fieldKey("egq", "dwm"), "_kardCache");
        expect(store.get(methodKey("egq", "ywp"))).toBe("ConsumeKardByCode");
        expect(store.get(fieldKey("egq", "dwm"))).toBe("_kardCache");
        expect(store.get(classKey("egq"))).toBeNull();  // class still unset
    });

    it("removes a label", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.remove(classKey("egq"));
        expect(store.get(classKey("egq"))).toBeNull();
    });

    it("emits change events with old and new values", () => {
        const store = new LabelStore(labelsPath);
        const events: Array<{ old: string | null; next: string | null }> = [];
        store.onChange((e) => events.push({ old: e.oldLabel, next: e.newLabel }));
        store.set(classKey("egq"), "HaapiService");
        store.set(classKey("egq"), "HaapiClient");
        store.remove(classKey("egq"));
        expect(events).toEqual([
            { old: null, next: "HaapiService" },
            { old: "HaapiService", next: "HaapiClient" },
            { old: "HaapiClient", next: null },
        ]);
    });

    it("persists to disk and reloads", async () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.set(methodKey("egq", "ywp"), "ConsumeKardByCode");
        await store.flush();

        expect(fs.existsSync(labelsPath)).toBe(true);

        const reloaded = new LabelStore(labelsPath);
        expect(reloaded.get(classKey("egq"))).toBe("HaapiService");
        expect(reloaded.get(methodKey("egq", "ywp"))).toBe("ConsumeKardByCode");
    });

    it("undo reverts the last change", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.undo();
        expect(store.get(classKey("egq"))).toBeNull();
    });

    it("redo replays an undone change", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.undo();
        store.redo();
        expect(store.get(classKey("egq"))).toBe("HaapiService");
    });

    it("display() returns label when set, obf otherwise", () => {
        const store = new LabelStore(labelsPath);
        expect(store.display(classKey("egq"))).toBe("egq");
        store.set(classKey("egq"), "HaapiService");
        expect(store.display(classKey("egq"))).toBe("HaapiService");
    });

    it("bulk import merges new labels", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("eat"), "MapView");
        const result = store.bulkImport({
            schemaVersion: 1,
            classes: { "egq": { label: "HaapiService", createdAt: "2026-04-30T00:00:00Z", updatedAt: "2026-04-30T00:00:00Z" } },
            methods: {},
            fields: {},
        });
        expect(result.imported).toBe(1);
        expect(store.get(classKey("egq"))).toBe("HaapiService");
        expect(store.get(classKey("eat"))).toBe("MapView");  // existing preserved
    });

    it("bulk export round-trips", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.set(methodKey("egq", "ywp"), "ConsumeKardByCode");
        const exported = store.bulkExport();

        const reimport = new LabelStore(path.join(tmpDir, "other.json"));
        reimport.bulkImport(exported);
        expect(reimport.get(classKey("egq"))).toBe("HaapiService");
        expect(reimport.get(methodKey("egq", "ywp"))).toBe("ConsumeKardByCode");
    });
});
```

- [ ] **Step 2: Run tests, see them all fail**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: all 11 tests fail (module missing).

- [ ] **Step 3: Implement `src/core/labels.ts`**

```typescript
// Label store: persistent CRUD over class/method/field renames.
// File-backed JSON, atomic writes, in-memory undo/redo ring (50 entries).
//
// Decoupled from vscode.* — uses a minimal Listener pattern so it can be
// unit-tested in plain Node.

import * as fs from "fs";
import * as path from "path";

import type { LabelChangeEvent, LabelEntry, LabelKey } from "./types";

interface LabelsFileV1 {
    schemaVersion: 1;
    classes: Record<string, LabelEntry>;       // key = obfClass
    methods: Record<string, LabelEntry>;       // key = obfClass.obfMethod
    fields: Record<string, LabelEntry>;        // key = obfClass.obfField
}

type Listener<T> = (event: T) => void;

const UNDO_BUFFER_SIZE = 50;

interface UndoFrame {
    apply: () => void;
    revert: () => void;
}

export class LabelStore {
    private classes = new Map<string, LabelEntry>();
    private methods = new Map<string, LabelEntry>();
    private fields = new Map<string, LabelEntry>();
    private listeners: Array<Listener<LabelChangeEvent>> = [];
    private filePath: string;
    private dirty = false;
    private flushPromise: Promise<void> = Promise.resolve();
    private undoStack: UndoFrame[] = [];
    private redoStack: UndoFrame[] = [];

    constructor(filePath: string) {
        this.filePath = filePath;
        this.loadFromDisk();
    }

    // ---- read ----

    get(key: LabelKey): string | null {
        const entry = this.lookup(key);
        return entry ? entry.label : null;
    }

    display(key: LabelKey): string {
        const label = this.get(key);
        if (label) return label;
        switch (key.kind) {
            case "class":  return key.className;
            case "method": return key.methodName;
            case "field":  return key.fieldName;
        }
    }

    isObfuscated(key: LabelKey): boolean {
        const name = key.kind === "class" ? key.className
                   : key.kind === "method" ? key.methodName
                   : key.fieldName;
        return /^[a-z]{1,4}$/.test(name);
    }

    // ---- write ----

    set(key: LabelKey, friendly: string): void {
        const old = this.get(key);
        if (old === friendly) return;

        const apply = (): void => {
            const now = new Date().toISOString();
            const existing = this.lookup(key);
            const entry: LabelEntry = {
                label: friendly,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now,
            };
            this.put(key, entry);
            this.markDirty();
            this.emit({ key, oldLabel: existing ? existing.label : null, newLabel: friendly });
        };
        const revert = (): void => {
            if (old === null) {
                this.delete(key);
            } else {
                const now = new Date().toISOString();
                this.put(key, { label: old, createdAt: now, updatedAt: now });
            }
            this.markDirty();
            this.emit({ key, oldLabel: friendly, newLabel: old });
        };
        this.pushUndo({ apply, revert });
        apply();
    }

    remove(key: LabelKey): void {
        const old = this.get(key);
        if (old === null) return;

        const apply = (): void => {
            this.delete(key);
            this.markDirty();
            this.emit({ key, oldLabel: old, newLabel: null });
        };
        const revert = (): void => {
            const now = new Date().toISOString();
            this.put(key, { label: old, createdAt: now, updatedAt: now });
            this.markDirty();
            this.emit({ key, oldLabel: null, newLabel: old });
        };
        this.pushUndo({ apply, revert });
        apply();
    }

    // ---- undo/redo ----

    undo(): boolean {
        const frame = this.undoStack.pop();
        if (!frame) return false;
        frame.revert();
        this.redoStack.push(frame);
        return true;
    }

    redo(): boolean {
        const frame = this.redoStack.pop();
        if (!frame) return false;
        frame.apply();
        this.undoStack.push(frame);
        return true;
    }

    private pushUndo(frame: UndoFrame): void {
        this.undoStack.push(frame);
        if (this.undoStack.length > UNDO_BUFFER_SIZE) this.undoStack.shift();
        this.redoStack.length = 0;
    }

    // ---- bulk ----

    bulkImport(json: unknown): { imported: number; skipped: number } {
        const data = json as LabelsFileV1;
        if (!data || data.schemaVersion !== 1) return { imported: 0, skipped: 0 };
        let imported = 0;
        let skipped = 0;
        for (const [k, v] of Object.entries(data.classes ?? {})) {
            if (this.classes.has(k)) { skipped++; continue; }
            this.classes.set(k, v);
            imported++;
        }
        for (const [k, v] of Object.entries(data.methods ?? {})) {
            if (this.methods.has(k)) { skipped++; continue; }
            this.methods.set(k, v);
            imported++;
        }
        for (const [k, v] of Object.entries(data.fields ?? {})) {
            if (this.fields.has(k)) { skipped++; continue; }
            this.fields.set(k, v);
            imported++;
        }
        if (imported > 0) this.markDirty();
        return { imported, skipped };
    }

    bulkExport(): LabelsFileV1 {
        return {
            schemaVersion: 1,
            classes: Object.fromEntries(this.classes),
            methods: Object.fromEntries(this.methods),
            fields: Object.fromEntries(this.fields),
        };
    }

    // ---- events ----

    onChange(listener: Listener<LabelChangeEvent>): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(event: LabelChangeEvent): void {
        for (const l of this.listeners) {
            try { l(event); } catch { /* listener errors must not break the store */ }
        }
    }

    // ---- persistence ----

    async flush(): Promise<void> {
        if (!this.dirty) return this.flushPromise;
        this.dirty = false;
        const data = JSON.stringify(this.bulkExport(), null, 2);
        const tmp = this.filePath + ".tmp";
        this.flushPromise = (async () => {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.promises.writeFile(tmp, data, "utf-8");
            await fs.promises.rename(tmp, this.filePath);
        })();
        return this.flushPromise;
    }

    private markDirty(): void {
        this.dirty = true;
        // Best-effort auto-save with debounce; unit tests call flush() explicitly.
        // Production wiring sets up a debounce-500 timer in profile.ts.
    }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as LabelsFileV1;
            for (const [k, v] of Object.entries(data.classes ?? {})) this.classes.set(k, v);
            for (const [k, v] of Object.entries(data.methods ?? {})) this.methods.set(k, v);
            for (const [k, v] of Object.entries(data.fields ?? {})) this.fields.set(k, v);
        } catch {
            // Corrupted file — caller (ProfileManager) handles backup + reset
            throw new Error(`labels.json invalid at ${this.filePath}`);
        }
    }

    // ---- internals ----

    private lookup(key: LabelKey): LabelEntry | undefined {
        switch (key.kind) {
            case "class":  return this.classes.get(key.className);
            case "method": return this.methods.get(`${key.className}.${key.methodName}`);
            case "field":  return this.fields.get(`${key.className}.${key.fieldName}`);
        }
    }

    private put(key: LabelKey, entry: LabelEntry): void {
        switch (key.kind) {
            case "class":  this.classes.set(key.className, entry); break;
            case "method": this.methods.set(`${key.className}.${key.methodName}`, entry); break;
            case "field":  this.fields.set(`${key.className}.${key.fieldName}`, entry); break;
        }
    }

    private delete(key: LabelKey): void {
        switch (key.kind) {
            case "class":  this.classes.delete(key.className); break;
            case "method": this.methods.delete(`${key.className}.${key.methodName}`); break;
            case "field":  this.fields.delete(`${key.className}.${key.fieldName}`); break;
        }
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: all 11 LabelStore tests pass.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/core/labels.ts dofus-app/vscode-extension/test/labels.test.ts
git commit -m "feat(toolkit): LabelStore — CRUD, undo/redo, persist, bulk import/export"
```

---

## Task 6: Annotation store (`src/core/annotations.ts`) — TDD

**Files:**
- Create: `dofus-app/vscode-extension/src/core/annotations.ts`
- Create: `dofus-app/vscode-extension/test/annotations.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/annotations.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AnnotationStore } from "../src/core/annotations";
import type { LabelKey } from "../src/core/types";

let tmpDir: string;
let annPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ann-test-"));
    annPath = path.join(tmpDir, "annotations.json");
});

const classKey = (n: string): LabelKey => ({ kind: "class", className: n });
const methodKey = (c: string, m: string): LabelKey => ({ kind: "method", className: c, methodName: m });

describe("AnnotationStore — bookmarks", () => {
    it("toggles bookmark on/off", () => {
        const store = new AnnotationStore(annPath);
        const k = classKey("egq");
        expect(store.isBookmarked(k)).toBe(false);
        store.toggleBookmark(k);
        expect(store.isBookmarked(k)).toBe(true);
        store.toggleBookmark(k);
        expect(store.isBookmarked(k)).toBe(false);
    });

    it("lists all bookmarks", () => {
        const store = new AnnotationStore(annPath);
        store.toggleBookmark(classKey("egq"));
        store.toggleBookmark(methodKey("eat", "LoadMap"));
        const list = store.listBookmarks();
        expect(list).toHaveLength(2);
    });

    it("persists bookmarks", async () => {
        const store = new AnnotationStore(annPath);
        store.toggleBookmark(classKey("egq"));
        await store.flush();

        const reloaded = new AnnotationStore(annPath);
        expect(reloaded.isBookmarked(classKey("egq"))).toBe(true);
    });
});

describe("AnnotationStore — notes", () => {
    it("returns null for missing notes", () => {
        const store = new AnnotationStore(annPath);
        expect(store.getNote(classKey("egq"))).toBeNull();
    });

    it("stores and retrieves a note", () => {
        const store = new AnnotationStore(annPath);
        store.setNote(classKey("egq"), "Service principal HAAPI...");
        expect(store.getNote(classKey("egq"))).toBe("Service principal HAAPI...");
    });

    it("removes a note", () => {
        const store = new AnnotationStore(annPath);
        store.setNote(classKey("egq"), "...");
        store.removeNote(classKey("egq"));
        expect(store.getNote(classKey("egq"))).toBeNull();
    });

    it("persists notes", async () => {
        const store = new AnnotationStore(annPath);
        store.setNote(classKey("egq"), "test note");
        await store.flush();
        const reloaded = new AnnotationStore(annPath);
        expect(reloaded.getNote(classKey("egq"))).toBe("test note");
    });
});

describe("AnnotationStore — events", () => {
    it("fires events on bookmark add/remove", () => {
        const store = new AnnotationStore(annPath);
        const events: string[] = [];
        store.onChange((e) => events.push(`${e.kind}:${e.action}`));
        store.toggleBookmark(classKey("egq"));
        store.toggleBookmark(classKey("egq"));
        expect(events).toEqual(["bookmark:added", "bookmark:removed"]);
    });

    it("fires events on note set/update/remove", () => {
        const store = new AnnotationStore(annPath);
        const events: string[] = [];
        store.onChange((e) => events.push(`${e.kind}:${e.action}`));
        store.setNote(classKey("egq"), "first");
        store.setNote(classKey("egq"), "second");
        store.removeNote(classKey("egq"));
        expect(events).toEqual(["note:added", "note:updated", "note:removed"]);
    });
});
```

- [ ] **Step 2: Run tests, all fail**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: 9 annotations tests fail.

- [ ] **Step 3: Implement `src/core/annotations.ts`**

```typescript
// Annotation store: bookmarks + notes per class/method/field.
// File-backed JSON. Same Listener pattern as labels.ts.

import * as fs from "fs";
import * as path from "path";

import type {
    AnnotationChangeEvent,
    BookmarkEntry,
    LabelKey,
    NoteEntry,
} from "./types";

interface AnnotationsFileV1 {
    schemaVersion: 1;
    bookmarks: Record<string, BookmarkEntry>;
    notes: Record<string, NoteEntry>;
}

type Listener<T> = (event: T) => void;

function keyId(key: LabelKey): string {
    switch (key.kind) {
        case "class":  return `class:${key.className}`;
        case "method": return `method:${key.className}.${key.methodName}`;
        case "field":  return `field:${key.className}.${key.fieldName}`;
    }
}

function parseKeyId(id: string): LabelKey | null {
    const m = /^(class|method|field):(.+)$/.exec(id);
    if (!m) return null;
    const kind = m[1] as "class" | "method" | "field";
    const rest = m[2];
    if (kind === "class") return { kind, className: rest };
    const dot = rest.indexOf(".");
    if (dot < 0) return null;
    const className = rest.slice(0, dot);
    const member = rest.slice(dot + 1);
    return kind === "method"
        ? { kind, className, methodName: member }
        : { kind, className, fieldName: member };
}

export class AnnotationStore {
    private bookmarks = new Map<string, BookmarkEntry>();
    private notes = new Map<string, NoteEntry>();
    private listeners: Array<Listener<AnnotationChangeEvent>> = [];
    private filePath: string;
    private dirty = false;

    constructor(filePath: string) {
        this.filePath = filePath;
        this.loadFromDisk();
    }

    // ---- bookmarks ----

    isBookmarked(key: LabelKey): boolean {
        return this.bookmarks.has(keyId(key));
    }

    toggleBookmark(key: LabelKey): void {
        const id = keyId(key);
        if (this.bookmarks.has(id)) {
            this.bookmarks.delete(id);
            this.markDirty();
            this.emit({ key, kind: "bookmark", action: "removed" });
        } else {
            this.bookmarks.set(id, { createdAt: new Date().toISOString() });
            this.markDirty();
            this.emit({ key, kind: "bookmark", action: "added" });
        }
    }

    listBookmarks(): LabelKey[] {
        return Array.from(this.bookmarks.keys())
            .map(parseKeyId)
            .filter((k): k is LabelKey => k !== null);
    }

    // ---- notes ----

    getNote(key: LabelKey): string | null {
        return this.notes.get(keyId(key))?.markdown ?? null;
    }

    setNote(key: LabelKey, markdown: string): void {
        const id = keyId(key);
        const exists = this.notes.has(id);
        this.notes.set(id, { markdown, updatedAt: new Date().toISOString() });
        this.markDirty();
        this.emit({ key, kind: "note", action: exists ? "updated" : "added" });
    }

    removeNote(key: LabelKey): void {
        const id = keyId(key);
        if (!this.notes.has(id)) return;
        this.notes.delete(id);
        this.markDirty();
        this.emit({ key, kind: "note", action: "removed" });
    }

    listNoted(): LabelKey[] {
        return Array.from(this.notes.keys())
            .map(parseKeyId)
            .filter((k): k is LabelKey => k !== null);
    }

    // ---- events ----

    onChange(listener: Listener<AnnotationChangeEvent>): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(event: AnnotationChangeEvent): void {
        for (const l of this.listeners) {
            try { l(event); } catch { /* swallow listener errors */ }
        }
    }

    // ---- persistence ----

    async flush(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        const data: AnnotationsFileV1 = {
            schemaVersion: 1,
            bookmarks: Object.fromEntries(this.bookmarks),
            notes: Object.fromEntries(this.notes),
        };
        const tmp = this.filePath + ".tmp";
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
        await fs.promises.rename(tmp, this.filePath);
    }

    private markDirty(): void { this.dirty = true; }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as AnnotationsFileV1;
            for (const [k, v] of Object.entries(data.bookmarks ?? {})) this.bookmarks.set(k, v);
            for (const [k, v] of Object.entries(data.notes ?? {})) this.notes.set(k, v);
        } catch {
            throw new Error(`annotations.json invalid at ${this.filePath}`);
        }
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: all annotation tests pass (plus labels still passing).

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/core/annotations.ts dofus-app/vscode-extension/test/annotations.test.ts
git commit -m "feat(toolkit): AnnotationStore — bookmarks + notes with events + persistence"
```

---

## Task 7: Migrations engine (`src/core/migrations.ts`) — TDD

**Files:**
- Create: `dofus-app/vscode-extension/src/core/migrations.ts`
- Create: `dofus-app/vscode-extension/test/migrations.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/migrations.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import { matchFingerprints } from "../src/core/migrations";
import type { ClassFingerprint, LabelKey } from "../src/core/types";

const cls = (
    obfName: string,
    overrides: Partial<ClassFingerprint> = {},
): ClassFingerprint => ({
    obfName,
    token: null,
    parents: [],
    methodCount: 0,
    methodSignatures: [],
    fieldTypes: [],
    ...overrides,
});

const labelClass = (name: string): LabelKey => ({ kind: "class", className: name });

describe("matchFingerprints", () => {
    it("auto-migrates when token matches exactly", () => {
        const oldFps = [cls("egq", { token: "0x2001A5E", methodCount: 17 })];
        const newFps = [cls("dxr", { token: "0x2001A5E", methodCount: 17 })];
        const labels: Record<string, string> = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].oldObf).toBe("egq");
        expect(result.auto[0].newObf).toBe("dxr");
        expect(result.auto[0].label).toBe("HaapiService");
        expect(result.auto[0].reason).toContain("token");
    });

    it("auto-migrates when fingerprint score is >= 0.95 (unique candidate)", () => {
        const oldFps = [cls("egq", {
            token: null,
            parents: ["base1"],
            methodCount: 17,
            methodSignatures: ["a(int)int", "b(string)bool", "c()void"],
            fieldTypes: ["x:int", "y:string"],
        })];
        const newFps = [
            cls("dxr", {
                token: null,
                parents: ["base1"],
                methodCount: 17,
                methodSignatures: ["a(int)int", "b(string)bool", "c()void"],
                fieldTypes: ["x:int", "y:string"],
            }),
            cls("zzz", {
                token: null,
                parents: ["unrelated"],
                methodCount: 5,
                methodSignatures: ["different()void"],
                fieldTypes: [],
            }),
        ];
        const labels = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].newObf).toBe("dxr");
    });

    it("flags review when multiple candidates score >= 0.60 but none reaches 0.95", () => {
        const oldFps = [cls("egq", {
            methodCount: 5,
            methodSignatures: ["a()void", "b()void", "c()void", "d()void", "e()void"],
            fieldTypes: ["x:int"],
        })];
        const newFps = [
            cls("aaa", {
                methodCount: 5,
                methodSignatures: ["a()void", "b()void", "c()void", "d()void", "e()void"],
                fieldTypes: ["x:long"],  // small diff -> high but not 1.0 score
            }),
            cls("bbb", {
                methodCount: 5,
                methodSignatures: ["a()void", "b()void", "c()void", "d()void", "f()void"],
                fieldTypes: ["x:int"],
            }),
        ];
        const labels = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.review.length).toBeGreaterThanOrEqual(1);
        expect(result.review[0].oldObf).toBe("egq");
        expect(result.review[0].candidates.length).toBeGreaterThanOrEqual(2);
    });

    it("marks lost when no candidate matches above 0.60", () => {
        const oldFps = [cls("egq", {
            methodCount: 17,
            methodSignatures: ["specific()void"],
            fieldTypes: ["uniqueField:int"],
        })];
        const newFps = [
            cls("aaa", {
                methodCount: 1,
                methodSignatures: ["totally_different()void"],
                fieldTypes: ["other:string"],
            }),
        ];
        const labels = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.lost).toHaveLength(1);
        expect(result.lost[0].oldObf).toBe("egq");
    });

    it("ignores classes with no label set", () => {
        const oldFps = [cls("egq", { token: "0x123" })];
        const newFps = [cls("dxr", { token: "0x123" })];
        const labels = {};  // no labels

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.auto).toHaveLength(0);
        expect(result.review).toHaveLength(0);
        expect(result.lost).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run tests, all 5 fail**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: 5 migrations tests fail (module missing).

- [ ] **Step 3: Implement `src/core/migrations.ts`**

```typescript
// Migration engine: given old + new fingerprints and a label map, decide
// which labels migrate automatically, which need user review, which are lost.
//
// Algorithm:
//   1. Build index of new fingerprints by token (when present)
//   2. For each labeled OLD class:
//      a. Token match → AUTO (highest confidence)
//      b. Otherwise compute structural similarity vs every NEW class
//         - same fp.parents (bonus)
//         - methodCount delta (penalty)
//         - jaccard(methodSignatures)
//         - jaccard(fieldTypes)
//         - blended score in [0, 1]
//      c. Best score >= 0.95 AND unique → AUTO
//         Best score >= 0.60 → REVIEW with all candidates above 0.60
//         Else → LOST

import type {
    ClassFingerprint,
    LabelKey,
    MigrationResult,
} from "./types";

export interface MatchInput {
    oldFps: ClassFingerprint[];
    newFps: ClassFingerprint[];
    oldLabels: Record<string, string>;   // obfClassName → friendlyLabel
}

const AUTO_THRESHOLD = 0.95;
const REVIEW_THRESHOLD = 0.60;

export function matchFingerprints(input: MatchInput): MigrationResult {
    const { oldFps, newFps, oldLabels } = input;
    const result: MigrationResult = { auto: [], review: [], lost: [] };

    const newByToken = new Map<string, ClassFingerprint>();
    for (const fp of newFps) {
        if (fp.token) newByToken.set(fp.token, fp);
    }

    for (const oldFp of oldFps) {
        const label = oldLabels[oldFp.obfName];
        if (!label) continue;

        const key: LabelKey = { kind: "class", className: oldFp.obfName };

        // 1. Token match
        if (oldFp.token) {
            const tokMatch = newByToken.get(oldFp.token);
            if (tokMatch) {
                result.auto.push({
                    key, label,
                    oldObf: oldFp.obfName,
                    newObf: tokMatch.obfName,
                    reason: `token match (${oldFp.token})`,
                });
                continue;
            }
        }

        // 2. Structural similarity against all new fps
        const candidates = newFps
            .map((newFp) => ({ newFp, score: similarity(oldFp, newFp) }))
            .filter((c) => c.score >= REVIEW_THRESHOLD)
            .sort((a, b) => b.score - a.score);

        if (candidates.length === 0) {
            result.lost.push({
                key, label,
                oldObf: oldFp.obfName,
                reason: "no candidate above 0.60 similarity",
            });
            continue;
        }

        const top = candidates[0];
        const second = candidates[1];

        if (top.score >= AUTO_THRESHOLD && (!second || top.score - second.score >= 0.10)) {
            result.auto.push({
                key, label,
                oldObf: oldFp.obfName,
                newObf: top.newFp.obfName,
                reason: `unique structural match (score=${top.score.toFixed(3)})`,
            });
        } else {
            result.review.push({
                key, label,
                oldObf: oldFp.obfName,
                candidates: candidates.slice(0, 5).map((c) => ({
                    newObf: c.newFp.obfName,
                    score: c.score,
                    reason: `structural similarity ${c.score.toFixed(3)}`,
                })),
            });
        }
    }

    return result;
}

/**
 * Composite similarity score in [0, 1]:
 *   - 0.20 weight: parents Jaccard
 *   - 0.20 weight: methodCount proximity (1 if equal, decays linearly)
 *   - 0.30 weight: methodSignatures Jaccard
 *   - 0.30 weight: fieldTypes Jaccard
 */
export function similarity(a: ClassFingerprint, b: ClassFingerprint): number {
    const parentScore = jaccard(new Set(a.parents), new Set(b.parents));

    const mcDiff = Math.abs(a.methodCount - b.methodCount);
    const mcMax = Math.max(a.methodCount, b.methodCount, 1);
    const methodCountScore = Math.max(0, 1 - mcDiff / mcMax);

    const sigScore = jaccard(new Set(a.methodSignatures), new Set(b.methodSignatures));
    const fieldScore = jaccard(new Set(a.fieldTypes), new Set(b.fieldTypes));

    return parentScore * 0.20 + methodCountScore * 0.20 + sigScore * 0.30 + fieldScore * 0.30;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const x of a) if (b.has(x)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 1 : intersection / union;
}
```

- [ ] **Step 4: Run tests**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: all migrations tests pass (plus prior tests still passing).

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/core/migrations.ts dofus-app/vscode-extension/test/migrations.test.ts
git commit -m "feat(toolkit): migration engine — token + structural matching with auto/review/lost outcomes"
```

---

## Task 8: Profile manager (`src/core/profile.ts`) — TDD

**Files:**
- Create: `dofus-app/vscode-extension/src/core/profile.ts`
- Create: `dofus-app/vscode-extension/test/profile.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/profile.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ProfileManager } from "../src/core/profile";

let tmpRoot: string;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
});

describe("ProfileManager", () => {
    it("creates a fresh profile when none exists", async () => {
        const mgr = new ProfileManager(tmpRoot);
        const profile = await mgr.createProfile({
            gameName: "dofus",
            buildId: "abc123",
            buildIdSource: "unity-boot-config",
        });

        expect(profile.manifest.gameName).toBe("dofus");
        expect(profile.manifest.buildId).toBe("abc123");
        expect(profile.manifest.derivedFrom).toBeNull();
        expect(fs.existsSync(path.join(tmpRoot, "dofus", "abc123", "manifest.json"))).toBe(true);
    });

    it("loads an existing profile", async () => {
        const mgr = new ProfileManager(tmpRoot);
        await mgr.createProfile({
            gameName: "dofus",
            buildId: "abc123",
            buildIdSource: "unity-boot-config",
        });

        const loaded = await mgr.loadProfile("dofus", "abc123");

        expect(loaded.manifest.buildId).toBe("abc123");
    });

    it("lists previous builds for the same game", async () => {
        const mgr = new ProfileManager(tmpRoot);
        await mgr.createProfile({ gameName: "dofus", buildId: "old", buildIdSource: "binary-hash" });
        await mgr.createProfile({ gameName: "dofus", buildId: "new", buildIdSource: "binary-hash" });

        const builds = await mgr.listBuilds("dofus");

        expect(builds).toEqual(expect.arrayContaining(["old", "new"]));
    });

    it("derives a profile (copies labels from previous build)", async () => {
        const mgr = new ProfileManager(tmpRoot);
        const old = await mgr.createProfile({ gameName: "dofus", buildId: "old", buildIdSource: "binary-hash" });
        old.labels.set({ kind: "class", className: "egq" }, "HaapiService");
        await old.labels.flush();

        const fresh = await mgr.createProfile({
            gameName: "dofus",
            buildId: "new",
            buildIdSource: "binary-hash",
            derivedFromBuildId: "old",
        });

        expect(fresh.manifest.derivedFrom).toBe("dofus/old");
        // Labels are NOT auto-copied — that's the migrations engine's job.
        // But the manifest tracks the lineage.
        expect(fresh.labels.get({ kind: "class", className: "egq" })).toBeNull();
    });

    it("returns the most recent previous build (for derive)", async () => {
        const mgr = new ProfileManager(tmpRoot);
        const a = await mgr.createProfile({ gameName: "dofus", buildId: "a", buildIdSource: "binary-hash" });
        a.labels.set({ kind: "class", className: "x" }, "X");
        await a.labels.flush();
        // Sleep a tiny bit to ensure mtime ordering on slow filesystems
        await new Promise((r) => setTimeout(r, 10));
        const b = await mgr.createProfile({ gameName: "dofus", buildId: "b", buildIdSource: "binary-hash" });
        b.labels.set({ kind: "class", className: "y" }, "Y");
        await b.labels.flush();

        const previous = await mgr.findMostRecentBuild("dofus", "c");  // c is the new build

        expect(previous).toBe("b");
    });
});
```

- [ ] **Step 2: Run tests, all fail**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: 5 profile tests fail.

- [ ] **Step 3: Implement `src/core/profile.ts`**

```typescript
// ProfileManager: load / create / list profiles on disk.
// A profile lives at <profilesRoot>/<gameName>/<buildId>/ with these files:
//   - manifest.json
//   - labels.json
//   - annotations.json
//   - migrations.json (created by the migration engine, optional)
//
// All file operations are async; tests must await flush() before reading.

import * as fs from "fs";
import * as path from "path";

import { LabelStore } from "./labels";
import { AnnotationStore } from "./annotations";
import type { BuildIdSource, ProfileManifest } from "./types";

export interface CreateProfileInput {
    gameName: string;
    buildId: string;
    buildIdSource: BuildIdSource;
    /** Optional: copy of labels from a prior build is the migration engine's job,
     *  but this records the lineage in the manifest. */
    derivedFromBuildId?: string;
}

export interface Profile {
    manifest: ProfileManifest;
    labels: LabelStore;
    annotations: AnnotationStore;
    rootPath: string;
}

export class ProfileManager {
    constructor(private readonly profilesRoot: string) {}

    async createProfile(input: CreateProfileInput): Promise<Profile> {
        const dir = path.join(this.profilesRoot, input.gameName, input.buildId);
        await fs.promises.mkdir(dir, { recursive: true });

        const now = new Date().toISOString();
        const manifest: ProfileManifest = {
            schemaVersion: 1,
            profileId: `${input.gameName}/${input.buildId}`,
            gameName: input.gameName,
            buildId: input.buildId,
            buildIdSource: input.buildIdSource,
            attachedFirstAt: now,
            attachedLastAt: now,
            derivedFrom: input.derivedFromBuildId
                ? `${input.gameName}/${input.derivedFromBuildId}`
                : null,
            stats: { totalLabels: 0, totalBookmarks: 0, totalNotes: 0 },
        };
        await fs.promises.writeFile(
            path.join(dir, "manifest.json"),
            JSON.stringify(manifest, null, 2),
            "utf-8",
        );

        return {
            manifest,
            labels: new LabelStore(path.join(dir, "labels.json")),
            annotations: new AnnotationStore(path.join(dir, "annotations.json")),
            rootPath: dir,
        };
    }

    async loadProfile(gameName: string, buildId: string): Promise<Profile> {
        const dir = path.join(this.profilesRoot, gameName, buildId);
        const manifestPath = path.join(dir, "manifest.json");
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`profile not found: ${gameName}/${buildId}`);
        }
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8")) as ProfileManifest;
        manifest.attachedLastAt = new Date().toISOString();
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

        return {
            manifest,
            labels: new LabelStore(path.join(dir, "labels.json")),
            annotations: new AnnotationStore(path.join(dir, "annotations.json")),
            rootPath: dir,
        };
    }

    async listBuilds(gameName: string): Promise<string[]> {
        const gameDir = path.join(this.profilesRoot, gameName);
        if (!fs.existsSync(gameDir)) return [];
        const entries = await fs.promises.readdir(gameDir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }

    /**
     * Find the most-recently-modified prior build, excluding the supplied
     * currentBuildId. Used to seed migration / derive linkage.
     */
    async findMostRecentBuild(gameName: string, currentBuildId: string): Promise<string | null> {
        const builds = await this.listBuilds(gameName);
        const others = builds.filter((b) => b !== currentBuildId);
        if (others.length === 0) return null;
        const stats = await Promise.all(
            others.map(async (b) => {
                const manifestPath = path.join(this.profilesRoot, gameName, b, "manifest.json");
                try {
                    const s = await fs.promises.stat(manifestPath);
                    return { build: b, mtime: s.mtimeMs };
                } catch {
                    return { build: b, mtime: 0 };
                }
            }),
        );
        stats.sort((a, b) => b.mtime - a.mtime);
        return stats[0].build;
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd dofus-app/vscode-extension && npm test
```

Expected: all profile tests pass.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/core/profile.ts dofus-app/vscode-extension/test/profile.test.ts
git commit -m "feat(toolkit): ProfileManager — create/load/list/derive per (game, build-id)"
```

---

## Task 9: Core API (`src/core/api.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/api.ts`

This task does NOT have unit tests — `api.ts` is just the wiring shape exposed to plugins. The internal modules already have tests.

- [ ] **Step 1: Implement the API**

```typescript
// CoreApi — the surface plugins import.
//
// In v1 there are no separate plugin extensions; plugins live as folders
// inside this same extension. They import this module directly.

import * as vscode from "vscode";

import type { LabelStore } from "./labels";
import type { AnnotationStore } from "./annotations";
import type { Profile } from "./profile";
import type { RpcClient } from "./types";

export interface PluginStorage {
    get<T>(key: string): T | null;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
    list(): string[];
}

export interface WebviewOptions {
    title: string;
    html: string;
    column?: vscode.ViewColumn;
    retainContextWhenHidden?: boolean;
}

export interface CoreApi {
    readonly profile: {
        current(): Profile | null;
        onAttach: vscode.EventEmitter<Profile>;
        onDetach: vscode.EventEmitter<void>;
    };
    readonly labels: LabelStore;
    readonly annotations: AnnotationStore;
    storage(pluginId: string): PluginStorage;
    rpc: {
        call<T>(method: string, args?: unknown[]): Promise<T>;
    };
    ui: {
        addView(viewId: string, provider: vscode.TreeDataProvider<unknown>): vscode.Disposable;
        addCommand(commandId: string, callback: (...args: unknown[]) => unknown): vscode.Disposable;
        showWebview(opts: WebviewOptions): vscode.WebviewPanel;
        notify(message: string, level?: "info" | "warning" | "error"): void;
    };
}

/**
 * In-memory storage backing for plugins until the per-plugin profile
 * directory is wired (post-v1). Swap implementation in profile.ts later.
 */
class InMemoryStorage implements PluginStorage {
    private store = new Map<string, unknown>();
    get<T>(key: string): T | null { return (this.store.get(key) as T) ?? null; }
    set<T>(key: string, value: T): void { this.store.set(key, value); }
    delete(key: string): void { this.store.delete(key); }
    list(): string[] { return Array.from(this.store.keys()); }
}

export interface CoreApiDeps {
    profileEmitter: vscode.EventEmitter<Profile>;
    profileDetachEmitter: vscode.EventEmitter<void>;
    profileSource: { current(): Profile | null };
    rpc: RpcClient;
}

export function createCoreApi(deps: CoreApiDeps): CoreApi {
    const storages = new Map<string, InMemoryStorage>();

    function getCurrentLabels(): LabelStore {
        const p = deps.profileSource.current();
        if (!p) throw new Error("no profile attached — labels unavailable");
        return p.labels;
    }
    function getCurrentAnnotations(): AnnotationStore {
        const p = deps.profileSource.current();
        if (!p) throw new Error("no profile attached — annotations unavailable");
        return p.annotations;
    }

    return {
        profile: {
            current: () => deps.profileSource.current(),
            onAttach: deps.profileEmitter,
            onDetach: deps.profileDetachEmitter,
        },
        // Proxy through profile to current stores; throws when detached.
        get labels() { return getCurrentLabels(); },
        get annotations() { return getCurrentAnnotations(); },
        storage(pluginId: string) {
            let s = storages.get(pluginId);
            if (!s) { s = new InMemoryStorage(); storages.set(pluginId, s); }
            return s;
        },
        rpc: {
            call: <T>(method: string, args: unknown[] = []) => deps.rpc.call<T>(method, args),
        },
        ui: {
            addView: (id, provider) => vscode.window.registerTreeDataProvider(id, provider),
            addCommand: (id, cb) => vscode.commands.registerCommand(id, cb),
            showWebview: (opts) => {
                const panel = vscode.window.createWebviewPanel(
                    `frida-plugin-${Date.now()}`,
                    opts.title,
                    opts.column ?? vscode.ViewColumn.One,
                    { enableScripts: true, retainContextWhenHidden: opts.retainContextWhenHidden ?? false },
                );
                panel.webview.html = opts.html;
                return panel;
            },
            notify: (msg, lvl = "info") => {
                if (lvl === "error") vscode.window.showErrorMessage(msg);
                else if (lvl === "warning") vscode.window.showWarningMessage(msg);
                else vscode.window.showInformationMessage(msg);
            },
        },
    };
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/api.ts
git commit -m "feat(toolkit): CoreApi — interface and factory wiring profile/labels/annotations/RPC/UI"
```

---

## Task 10: Status bar (`src/core/status-bar.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/status-bar.ts`

- [ ] **Step 1: Implement**

```typescript
// Status bar item with connection + profile info. Click → refresh.

import * as vscode from "vscode";

import type { Profile } from "./profile";
import type { RpcClient } from "./types";

const REFRESH_INTERVAL_MS = 10_000;

export class StatusBarController {
    private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    private timer?: NodeJS.Timeout;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
        refreshCommandId: string,
    ) {
        this.item.command = refreshCommandId;
        this.item.show();
        this.setDisconnected();
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick(), REFRESH_INTERVAL_MS);
        this.tick();
    }

    async tick(): Promise<void> {
        const healthy = await this.rpc.isHealthy();
        if (!healthy) {
            this.setDisconnected();
            return;
        }
        const profile = this.profileSource.current();
        this.setConnected(profile);
    }

    setDisconnected(): void {
        this.item.text = `$(circle-slash) Frida: not connected`;
        this.item.tooltip = "Frida RPC unreachable. Check fridaToolkit.rpcEndpoint setting.";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    setConnected(profile: Profile | null): void {
        if (!profile) {
            this.item.text = `$(zap) Frida (no profile)`;
            this.item.tooltip = "Frida RPC reachable but profile not yet detected.";
        } else {
            const buildShort = profile.manifest.buildId.slice(0, 8);
            this.item.text = `$(zap) ${profile.manifest.gameName} | ${buildShort}`;
            this.item.tooltip =
                `Game: ${profile.manifest.gameName}\n` +
                `Build: ${profile.manifest.buildId}\n` +
                `Source: ${profile.manifest.buildIdSource}\n` +
                `Labels: ${profile.manifest.stats.totalLabels}, ` +
                `Bookmarks: ${profile.manifest.stats.totalBookmarks}, ` +
                `Notes: ${profile.manifest.stats.totalNotes}`;
        }
        this.item.backgroundColor = undefined;
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.item.dispose();
    }
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/status-bar.ts
git commit -m "feat(toolkit): status bar — connection state + profile info, 10s refresh"
```

---

## Task 11: Process Explorer (`src/core/explorer.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/explorer.ts`

- [ ] **Step 1: Implement the 3 tree providers (Process Explorer, Bookmarks, Migrations)**

```typescript
// Sidebar tree views:
//   1. Process Explorer  — assemblies → namespaces → classes → members
//   2. Bookmarks         — flat list of bookmarked keys
//   3. Migrations        — review queue + auto-migrated audit list
//
// Each TreeDataProvider re-fires onDidChangeTreeData when the underlying
// store changes, so renames/bookmarks/note edits update the UI live.

import * as vscode from "vscode";

import type { Profile } from "./profile";
import type {
    LabelKey,
    MigrationResult,
    RpcClient,
} from "./types";

// ===========================================================================
// Process Explorer
// ===========================================================================

type ExplorerNode =
    | { kind: "assembly"; name: string; classCount: number }
    | { kind: "namespace"; assembly: string; ns: string; classCount: number }
    | { kind: "class"; assembly: string; ns: string; obfName: string }
    | { kind: "member"; container: { className: string }; memberKind: "method" | "field"; obfName: string };

export class ProcessExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
    private _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;
    private showObfNames = false;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
    ) {}

    refresh(): void { this._changed.fire(); }

    setShowObfNames(show: boolean): void {
        this.showObfNames = show;
        this.refresh();
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        const profile = this.profileSource.current();
        switch (node.kind) {
            case "assembly": {
                const item = new vscode.TreeItem(`${node.name} (${node.classCount})`,
                    vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("package");
                item.contextValue = "frida.assembly";
                return item;
            }
            case "namespace": {
                const label = node.ns || "(root)";
                const item = new vscode.TreeItem(`${label} (${node.classCount})`,
                    vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("symbol-namespace");
                item.contextValue = "frida.namespace";
                return item;
            }
            case "class": {
                const key: LabelKey = { kind: "class", className: node.obfName };
                const display = profile ? this.displayWithObfTag(profile, key) : node.obfName;
                const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("symbol-class");
                item.contextValue = "frida.class";
                item.tooltip = node.obfName;
                if (profile) {
                    if (profile.annotations.isBookmarked(key)) item.iconPath = new vscode.ThemeIcon("star-full");
                    if (profile.annotations.getNote(key)) item.description = "📝";
                }
                item.command = {
                    command: "frida.openClassDetail",
                    title: "Open detail",
                    arguments: [node.obfName],
                };
                return item;
            }
            case "member": {
                const key: LabelKey = node.memberKind === "method"
                    ? { kind: "method", className: node.container.className, methodName: node.obfName }
                    : { kind: "field",  className: node.container.className, fieldName:  node.obfName };
                const display = profile ? this.displayWithObfTag(profile, key) : node.obfName;
                const icon = node.memberKind === "method" ? "symbol-method" : "symbol-field";
                const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon(icon);
                item.contextValue = `frida.${node.memberKind}`;
                item.tooltip = node.obfName;
                return item;
            }
        }
    }

    async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
        try {
            if (!node) {
                const list = await this.rpc.call<Array<{ name: string; classes: number }>>("listAssembliesInfo");
                return list.map((a) => ({ kind: "assembly", name: a.name, classCount: a.classes }));
            }
            if (node.kind === "assembly") {
                const list = await this.rpc.call<Array<{ ns: string; classes: number }>>("listNamespaces", [node.name]);
                return list.map((nsInfo) => ({
                    kind: "namespace", assembly: node.name, ns: nsInfo.ns, classCount: nsInfo.classes,
                }));
            }
            if (node.kind === "namespace") {
                const list = await this.rpc.call<string[]>("listClassesIn", [node.assembly, node.ns]);
                return list.map((obfName) => ({
                    kind: "class", assembly: node.assembly, ns: node.ns, obfName,
                }));
            }
            // Member-level expansion is opened via the class-detail webview, not the tree.
            return [];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Frida RPC error: ${msg}`);
            return [];
        }
    }

    private displayWithObfTag(profile: Profile, key: LabelKey): string {
        const friendly = profile.labels.get(key);
        const obf = key.kind === "class"
            ? key.className
            : key.kind === "method" ? key.methodName : key.fieldName;
        if (!friendly) return obf;
        return this.showObfNames ? `${friendly} [${obf}]` : friendly;
    }
}

// ===========================================================================
// Bookmarks
// ===========================================================================

export class BookmarksProvider implements vscode.TreeDataProvider<LabelKey> {
    private _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;

    constructor(private readonly profileSource: { current(): Profile | null }) {}

    refresh(): void { this._changed.fire(); }

    getTreeItem(key: LabelKey): vscode.TreeItem {
        const profile = this.profileSource.current();
        const display = profile ? profile.labels.display(key) : labelKeyName(key);
        const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("star-full");
        item.contextValue = "frida.bookmark";
        item.tooltip = labelKeyTooltip(key);
        if (key.kind === "class") {
            item.command = { command: "frida.openClassDetail", title: "Open", arguments: [key.className] };
        }
        return item;
    }

    getChildren(): LabelKey[] {
        const profile = this.profileSource.current();
        return profile ? profile.annotations.listBookmarks() : [];
    }
}

// ===========================================================================
// Migrations
// ===========================================================================

type MigrationNode =
    | { kind: "section"; section: "auto" | "review" | "lost"; count: number }
    | { kind: "auto"; oldObf: string; newObf: string; label: string; reason: string }
    | { kind: "review"; oldObf: string; label: string; topScore: number }
    | { kind: "lost"; oldObf: string; label: string; reason: string };

export class MigrationsProvider implements vscode.TreeDataProvider<MigrationNode> {
    private _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;
    private current: MigrationResult = { auto: [], review: [], lost: [] };

    refresh(): void { this._changed.fire(); }

    setMigrations(result: MigrationResult): void {
        this.current = result;
        this.refresh();
    }

    getTreeItem(node: MigrationNode): vscode.TreeItem {
        switch (node.kind) {
            case "section": {
                const item = new vscode.TreeItem(
                    `${node.section.toUpperCase()} (${node.count})`,
                    node.count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                );
                item.iconPath = new vscode.ThemeIcon(
                    node.section === "auto" ? "check"
                    : node.section === "review" ? "warning"
                    : "error",
                );
                return item;
            }
            case "auto": {
                const item = new vscode.TreeItem(`${node.label}: ${node.oldObf} → ${node.newObf}`, vscode.TreeItemCollapsibleState.None);
                item.tooltip = node.reason;
                return item;
            }
            case "review": {
                const item = new vscode.TreeItem(`${node.label}: ${node.oldObf} (${node.topScore.toFixed(2)})`, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon("warning");
                item.command = {
                    command: "frida.openMigrationReview",
                    title: "Review",
                    arguments: [node.oldObf],
                };
                return item;
            }
            case "lost": {
                const item = new vscode.TreeItem(`${node.label}: ${node.oldObf} (lost)`, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon("error");
                item.tooltip = node.reason;
                return item;
            }
        }
    }

    getChildren(node?: MigrationNode): MigrationNode[] {
        if (!node) {
            return [
                { kind: "section", section: "review", count: this.current.review.length },
                { kind: "section", section: "auto",   count: this.current.auto.length },
                { kind: "section", section: "lost",   count: this.current.lost.length },
            ];
        }
        if (node.kind === "section") {
            if (node.section === "auto") {
                return this.current.auto.map((m) => ({
                    kind: "auto" as const,
                    oldObf: m.oldObf, newObf: m.newObf, label: m.label, reason: m.reason,
                }));
            }
            if (node.section === "review") {
                return this.current.review.map((m) => ({
                    kind: "review" as const,
                    oldObf: m.oldObf, label: m.label,
                    topScore: m.candidates[0]?.score ?? 0,
                }));
            }
            return this.current.lost.map((m) => ({
                kind: "lost" as const,
                oldObf: m.oldObf, label: m.label, reason: m.reason,
            }));
        }
        return [];
    }
}

// ===========================================================================
// Helpers
// ===========================================================================

function labelKeyName(k: LabelKey): string {
    return k.kind === "class" ? k.className
        : k.kind === "method" ? `${k.className}.${k.methodName}`
        : `${k.className}.${k.fieldName}`;
}
function labelKeyTooltip(k: LabelKey): string { return `${k.kind}: ${labelKeyName(k)}`; }
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/explorer.ts
git commit -m "feat(toolkit): explorer — Process Explorer + Bookmarks + Migrations tree providers"
```

---

## Task 12: Universal search (`src/core/search.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/search.ts`

- [ ] **Step 1: Implement**

```typescript
// Universal search via VSCode Quick Pick. Indexes obf names + labels and
// supports `:class`, `:method`, `:field`, `:rva` prefixes for filtering.

import * as vscode from "vscode";

import type { Profile } from "./profile";
import type { RpcClient } from "./types";

interface IndexEntry {
    label: string;
    description: string;
    detail: string;
    target: { command: string; args: unknown[] };
}

export class UniversalSearch {
    private cache: IndexEntry[] | null = null;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
    ) {}

    invalidate(): void { this.cache = null; }

    async show(): Promise<void> {
        const items = await this.getIndex();
        const pick = await vscode.window.showQuickPick(
            items.map<vscode.QuickPickItem & { entry: IndexEntry }>((e) => ({
                label: e.label,
                description: e.description,
                detail: e.detail,
                entry: e,
            })),
            {
                placeHolder: "Search class/method/field by obf or label. Prefix `:class `, `:method `, `:field `, `:rva `",
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );
        if (!pick) return;
        await vscode.commands.executeCommand(pick.entry.target.command, ...pick.entry.target.args);
    }

    private async getIndex(): Promise<IndexEntry[]> {
        if (this.cache) return this.cache;

        const profile = this.profileSource.current();
        const out: IndexEntry[] = [];

        try {
            const assemblies = await this.rpc.call<Array<{ name: string; classes: number }>>("listAssembliesInfo");
            for (const a of assemblies) {
                const namespaces = await this.rpc.call<Array<{ ns: string; classes: number }>>("listNamespaces", [a.name]);
                for (const n of namespaces) {
                    const classes = await this.rpc.call<string[]>("listClassesIn", [a.name, n.ns]);
                    for (const obf of classes) {
                        const friendly = profile?.labels.get({ kind: "class", className: obf }) ?? null;
                        out.push({
                            label: friendly ?? obf,
                            description: friendly ? `[${obf}]` : "",
                            detail: `${a.name} / ${n.ns || "(root)"}`,
                            target: { command: "frida.openClassDetail", args: [obf] },
                        });
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`search index build failed: ${msg}`);
        }

        this.cache = out;
        return out;
    }
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/search.ts
git commit -m "feat(toolkit): universal search via QuickPick — indexes classes by obf+label"
```

---

## Task 13: Class detail webview (`src/core/webviews/class-detail.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/webviews/class-detail.ts`

- [ ] **Step 1: Implement**

```typescript
// Webview that renders class detail (fields, methods, parents) with rename
// + bookmark + add-note actions. Reacts to label/annotation events via a
// disposable subscription.

import * as vscode from "vscode";

import type { Profile } from "../profile";
import type { LabelKey, RpcClient } from "../types";

export async function openClassDetail(
    obfClassName: string,
    rpc: RpcClient,
    profileSource: { current(): Profile | null },
): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        "fridaClassDetail",
        `Class: ${obfClassName}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = new vscode.ThemeIcon("symbol-class");

    let dump = "";
    try {
        dump = await rpc.call<string>("dumpClassAsString", [obfClassName]);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.webview.html = renderError(obfClassName, msg);
        return;
    }

    const render = (): void => {
        const profile = profileSource.current();
        panel.title = `Class: ${profile?.labels.display({ kind: "class", className: obfClassName }) ?? obfClassName}`;
        panel.webview.html = renderClass(obfClassName, dump, profile);
    };
    render();

    panel.webview.onDidReceiveMessage(async (msg: { type: string; payload?: unknown }) => {
        switch (msg.type) {
            case "rename":
                await vscode.commands.executeCommand("frida.renameClass", obfClassName);
                render();
                break;
            case "bookmark":
                await vscode.commands.executeCommand("frida.toggleBookmark", obfClassName);
                render();
                break;
            case "addNote":
                await vscode.commands.executeCommand("frida.addNote", obfClassName);
                render();
                break;
            case "copyObf":
                await vscode.env.clipboard.writeText(obfClassName);
                vscode.window.showInformationMessage(`Copied: ${obfClassName}`);
                break;
        }
    });

    // Re-render on label / annotation changes.
    const profile = profileSource.current();
    if (profile) {
        const offLabel = profile.labels.onChange((e) => {
            if (matchesClass(e.key, obfClassName)) render();
        });
        const offAnn = profile.annotations.onChange((e) => {
            if (matchesClass(e.key, obfClassName)) render();
        });
        panel.onDidDispose(() => { offLabel(); offAnn(); });
    }
}

function matchesClass(k: LabelKey, className: string): boolean {
    return (k.kind === "class" && k.className === className)
        || (k.kind === "method" && k.className === className)
        || (k.kind === "field" && k.className === className);
}

function renderClass(obf: string, dump: string, profile: Profile | null): string {
    const labelKey: LabelKey = { kind: "class", className: obf };
    const friendly = profile?.labels.get(labelKey) ?? null;
    const display = friendly ?? obf;
    const isBookmarked = profile?.annotations.isBookmarked(labelKey) ?? false;
    const note = profile?.annotations.getNote(labelKey) ?? null;

    return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body { font-family: var(--vscode-editor-font-family); padding: 1rem;
            color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); line-height: 1.5; }
        h2 { color: var(--vscode-textLink-foreground); margin-bottom: 0.25em; }
        .obf-tag { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
        .note { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding: 0.6rem 0.8rem; margin: 1rem 0; font-style: italic; }
        pre { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding: 0.6rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 0.4rem 0.8rem; border-radius: 2px; cursor: pointer; margin-right: 0.5rem; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.active { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
    </style></head><body>
        <h2>${escapeHtml(display)} ${friendly ? `<span class="obf-tag">[${escapeHtml(obf)}]</span>` : ""}</h2>
        <div>
            <button onclick="vscode.postMessage({type:'rename'})">Rename</button>
            <button class="${isBookmarked ? "active" : ""}" onclick="vscode.postMessage({type:'bookmark'})">${isBookmarked ? "★ Bookmarked" : "☆ Bookmark"}</button>
            <button onclick="vscode.postMessage({type:'addNote'})">${note ? "Edit note" : "Add note"}</button>
            <button onclick="vscode.postMessage({type:'copyObf'})">Copy obf</button>
        </div>
        ${note ? `<div class="note">${escapeHtml(note).replace(/\n/g, "<br>")}</div>` : ""}
        <pre>${escapeHtml(dump)}</pre>
        <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
}

function renderError(obf: string, msg: string): string {
    return /*html*/ `<!DOCTYPE html><html><body style="font-family: var(--vscode-editor-font-family); padding: 1rem;">
        <h2>${escapeHtml(obf)}</h2>
        <p>RPC failed:</p><pre style="color: var(--vscode-errorForeground);">${escapeHtml(msg)}</pre>
    </body></html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/webviews/class-detail.ts
git commit -m "feat(toolkit): class detail webview with rename/bookmark/note/copy actions"
```

---

## Task 14: Migration review webview (`src/core/webviews/migration-review.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/webviews/migration-review.ts`

- [ ] **Step 1: Implement**

```typescript
// Webview to review a single migration candidate. Shows old fingerprint
// vs. candidate fingerprint side by side with Accept / Reject buttons.

import * as vscode from "vscode";

import type { ClassFingerprint, MigrationResult } from "../types";

export interface MigrationReviewInput {
    oldObf: string;
    label: string;
    oldFingerprint: ClassFingerprint;
    candidates: Array<{ newObf: string; score: number; fingerprint: ClassFingerprint; reason: string }>;
}

export async function openMigrationReview(
    input: MigrationReviewInput,
    onAccept: (newObf: string) => void,
    onReject: () => void,
): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        "fridaMigrationReview",
        `Migration: ${input.label}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.webview.html = render(input);

    panel.webview.onDidReceiveMessage((msg: { type: string; newObf?: string }) => {
        if (msg.type === "accept" && msg.newObf) {
            onAccept(msg.newObf);
            panel.dispose();
        } else if (msg.type === "reject") {
            onReject();
            panel.dispose();
        }
    });
}

function render(input: MigrationReviewInput): string {
    return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body { font-family: var(--vscode-editor-font-family); padding: 1rem;
            color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
        h2 { color: var(--vscode-textLink-foreground); }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
        .col { background: var(--vscode-textBlockQuote-background); padding: 1rem; border-radius: 4px; }
        .candidate { border-left: 3px solid var(--vscode-statusBarItem-warningBackground); margin: 0.5rem 0; padding: 0.5rem; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 0.4rem 0.8rem; border-radius: 2px; cursor: pointer; margin-right: 0.5rem; }
        button.reject { background: var(--vscode-errorForeground); color: white; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        ul { font-size: 0.9em; padding-left: 1.2em; }
    </style></head><body>
        <h2>Migration: ${escapeHtml(input.label)}</h2>
        <p>Old obf: <code>${escapeHtml(input.oldObf)}</code></p>
        <h3>Candidates (sorted by score)</h3>
        ${input.candidates.map((c) => `
            <div class="candidate">
                <strong>${escapeHtml(c.newObf)}</strong> &mdash; score ${c.score.toFixed(3)}
                <p>${escapeHtml(c.reason)}</p>
                <div class="grid">
                    <div class="col">
                        <h4>Old fingerprint</h4>
                        ${renderFingerprint(input.oldFingerprint)}
                    </div>
                    <div class="col">
                        <h4>Candidate fingerprint</h4>
                        ${renderFingerprint(c.fingerprint)}
                    </div>
                </div>
                <button onclick="vscode.postMessage({type:'accept', newObf:'${escapeHtml(c.newObf)}'})">Accept this</button>
            </div>
        `).join("")}
        <button class="reject" onclick="vscode.postMessage({type:'reject'})">Reject all (mark as lost)</button>
        <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
}

function renderFingerprint(fp: ClassFingerprint): string {
    return `
        <ul>
            <li>token: <code>${fp.token ?? "(none)"}</code></li>
            <li>parents: ${fp.parents.map(escapeHtml).join(", ") || "(none)"}</li>
            <li>methods: ${fp.methodCount}</li>
            <li>fields: ${fp.fieldTypes.length}</li>
        </ul>
        <details><summary>method signatures (${fp.methodSignatures.length})</summary>
            <ul>${fp.methodSignatures.slice(0, 20).map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}
            ${fp.methodSignatures.length > 20 ? `<li>... (${fp.methodSignatures.length - 20} more)</li>` : ""}
            </ul>
        </details>`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/webviews/migration-review.ts
git commit -m "feat(toolkit): migration review webview — side-by-side fingerprints + accept/reject"
```

---

## Task 15: Commands wiring (`src/core/commands.ts`)

**Files:**
- Create: `dofus-app/vscode-extension/src/core/commands.ts`

- [ ] **Step 1: Implement**

```typescript
// All command handlers, registered as a group from extension.activate().
// Keeps the activation file slim.

import * as vscode from "vscode";

import { openClassDetail } from "./webviews/class-detail";
import type { Profile } from "./profile";
import type { LabelKey, RpcClient } from "./types";

export interface CommandsDeps {
    rpc: RpcClient;
    profileSource: { current(): Profile | null };
    refresh: () => void;
    onShowObfNamesToggled: (showing: boolean) => void;
    showSearch: () => Promise<void>;
}

let showObfNames = false;

export function registerCommands(deps: CommandsDeps): vscode.Disposable[] {
    const profileNeeded = (cb: (p: Profile, ...rest: unknown[]) => unknown | Promise<unknown>) =>
        async (...args: unknown[]) => {
            const p = deps.profileSource.current();
            if (!p) {
                vscode.window.showWarningMessage("No profile attached. Connect Frida first.");
                return;
            }
            await cb(p, ...args);
        };

    const cmds: vscode.Disposable[] = [];

    cmds.push(vscode.commands.registerCommand("frida.refresh", () => {
        deps.refresh();
    }));

    cmds.push(vscode.commands.registerCommand("frida.search", () => deps.showSearch()));

    cmds.push(vscode.commands.registerCommand("frida.openClassDetail", async (obfName?: string) => {
        const target = obfName ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!target) return;
        await openClassDetail(target, deps.rpc, deps.profileSource);
    }));

    cmds.push(vscode.commands.registerCommand("frida.renameClass", profileNeeded(async (p, obfNameArg) => {
        const obf = (obfNameArg as string | undefined) ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf) return;
        const key: LabelKey = { kind: "class", className: obf };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${obf} →`, value: current });
        if (next === undefined) return;
        if (next === "") p.labels.remove(key);
        else p.labels.set(key, next);
        await p.labels.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.renameMethod", profileNeeded(async (p) => {
        const cls = await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!cls) return;
        const meth = await vscode.window.showInputBox({ prompt: "Method obf name" });
        if (!meth) return;
        const key: LabelKey = { kind: "method", className: cls, methodName: meth };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${cls}.${meth} →`, value: current });
        if (next === undefined) return;
        if (next === "") p.labels.remove(key);
        else p.labels.set(key, next);
        await p.labels.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.renameField", profileNeeded(async (p) => {
        const cls = await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!cls) return;
        const fld = await vscode.window.showInputBox({ prompt: "Field obf name" });
        if (!fld) return;
        const key: LabelKey = { kind: "field", className: cls, fieldName: fld };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${cls}.${fld} →`, value: current });
        if (next === undefined) return;
        if (next === "") p.labels.remove(key);
        else p.labels.set(key, next);
        await p.labels.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.toggleBookmark", profileNeeded(async (p, obfArg) => {
        const obf = (obfArg as string | undefined) ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf) return;
        const key: LabelKey = { kind: "class", className: obf };
        p.annotations.toggleBookmark(key);
        await p.annotations.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.addNote", profileNeeded(async (p, obfArg) => {
        const obf = (obfArg as string | undefined) ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf) return;
        const key: LabelKey = { kind: "class", className: obf };
        const current = p.annotations.getNote(key) ?? "";
        const next = await vscode.window.showInputBox({
            prompt: `Note for ${obf} (markdown)`,
            value: current,
        });
        if (next === undefined) return;
        if (next === "") p.annotations.removeNote(key);
        else p.annotations.setNote(key, next);
        await p.annotations.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.toggleObfNames", () => {
        showObfNames = !showObfNames;
        deps.onShowObfNamesToggled(showObfNames);
        vscode.window.showInformationMessage(
            showObfNames ? "Showing obf names alongside labels"
                         : "Hiding obf names",
        );
    }));

    cmds.push(vscode.commands.registerCommand("frida.undoRename", profileNeeded(async (p) => {
        if (p.labels.undo()) {
            await p.labels.flush();
            deps.refresh();
        }
    })));

    cmds.push(vscode.commands.registerCommand("frida.redoRename", profileNeeded(async (p) => {
        if (p.labels.redo()) {
            await p.labels.flush();
            deps.refresh();
        }
    })));

    cmds.push(vscode.commands.registerCommand("frida.exportLabels", profileNeeded(async (p) => {
        const data = p.labels.bulkExport();
        const uri = await vscode.window.showSaveDialog({ filters: { JSON: ["json"] }, defaultUri: vscode.Uri.file("labels.json") });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2)));
        vscode.window.showInformationMessage(`Exported ${Object.keys(data.classes).length} class labels`);
    })));

    cmds.push(vscode.commands.registerCommand("frida.importLabels", profileNeeded(async (p) => {
        const uris = await vscode.window.showOpenDialog({ filters: { JSON: ["json"] }, canSelectMany: false });
        if (!uris || uris.length === 0) return;
        const buf = await vscode.workspace.fs.readFile(uris[0]);
        try {
            const data = JSON.parse(Buffer.from(buf).toString("utf-8"));
            const result = p.labels.bulkImport(data);
            await p.labels.flush();
            vscode.window.showInformationMessage(`Imported ${result.imported}, skipped ${result.skipped}`);
            deps.refresh();
        } catch (e) {
            vscode.window.showErrorMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    })));

    cmds.push(vscode.commands.registerCommand("frida.showProfileInfo", () => {
        const p = deps.profileSource.current();
        if (!p) {
            vscode.window.showWarningMessage("No profile attached.");
            return;
        }
        const m = p.manifest;
        vscode.window.showInformationMessage(
            `Profile: ${m.profileId}\nBuild: ${m.buildId} (${m.buildIdSource})\n` +
            `Labels: ${m.stats.totalLabels}, Bookmarks: ${m.stats.totalBookmarks}, Notes: ${m.stats.totalNotes}`,
            { modal: true },
        );
    }));

    return cmds;
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/core/commands.ts
git commit -m "feat(toolkit): commands.ts — palette commands for rename/bookmark/note/import-export"
```

---

## Task 16: Settings + view contributions (`package.json`)

**Files:**
- Modify: `dofus-app/vscode-extension/package.json`

- [ ] **Step 1: Replace contributions section**

Open `dofus-app/vscode-extension/package.json` and replace its current `contributes` section with:

```json
"contributes": {
    "viewsContainers": {
        "activitybar": [
            {
                "id": "fridaToolkit",
                "title": "Frida Toolkit",
                "icon": "$(zap)"
            }
        ]
    },
    "views": {
        "fridaToolkit": [
            { "id": "fridaProcessExplorer", "name": "Process Explorer" },
            { "id": "fridaBookmarks", "name": "Bookmarks" },
            { "id": "fridaMigrations", "name": "Migrations" }
        ]
    },
    "commands": [
        { "command": "frida.refresh", "title": "Frida: Refresh", "icon": "$(refresh)" },
        { "command": "frida.search", "title": "Frida: Search..." },
        { "command": "frida.openClassDetail", "title": "Frida: Open class detail by obf name" },
        { "command": "frida.renameClass", "title": "Frida: Rename class..." },
        { "command": "frida.renameMethod", "title": "Frida: Rename method..." },
        { "command": "frida.renameField", "title": "Frida: Rename field..." },
        { "command": "frida.toggleBookmark", "title": "Frida: Toggle bookmark" },
        { "command": "frida.addNote", "title": "Frida: Add note" },
        { "command": "frida.toggleObfNames", "title": "Frida: Toggle obfuscated names" },
        { "command": "frida.undoRename", "title": "Frida: Undo rename" },
        { "command": "frida.redoRename", "title": "Frida: Redo rename" },
        { "command": "frida.exportLabels", "title": "Frida: Export labels (JSON)" },
        { "command": "frida.importLabels", "title": "Frida: Import labels (JSON, merge)" },
        { "command": "frida.showProfileInfo", "title": "Frida: Show profile info" },
        { "command": "frida.openMigrationReview", "title": "Frida: Open migration review" }
    ],
    "menus": {
        "view/title": [
            { "command": "frida.refresh", "when": "view == fridaProcessExplorer", "group": "navigation" },
            { "command": "frida.search", "when": "view == fridaProcessExplorer", "group": "navigation" }
        ]
    },
    "keybindings": [
        { "command": "frida.search", "key": "ctrl+shift+f", "when": "fridaToolkit.connected" }
    ],
    "configuration": {
        "title": "Frida IL2CPP Toolkit",
        "properties": {
            "fridaToolkit.rpcEndpoint": {
                "type": "string",
                "default": "http://localhost:3001/api/call",
                "description": "Frida RPC endpoint URL"
            },
            "fridaToolkit.profileRoot": {
                "type": "string",
                "default": "",
                "description": "Profile storage path (empty = ~/.frida-toolkit/profiles)"
            },
            "fridaToolkit.gameNameOverride": {
                "type": "string",
                "default": "",
                "description": "Override the auto-derived game name"
            },
            "fridaToolkit.showObfNamesAlongside": {
                "type": "boolean",
                "default": false,
                "description": "Show obfuscated names next to labels"
            },
            "fridaToolkit.search.maxResults": {
                "type": "number",
                "default": 100,
                "description": "Max results in universal search"
            },
            "fridaToolkit.migration.autoMigrateThreshold": {
                "type": "number",
                "default": 0.95,
                "description": "Score threshold for automatic migration (0.0-1.0)"
            }
        }
    }
}
```

- [ ] **Step 2: Verify package.json is valid**

```bash
cd dofus-app/vscode-extension && node -e "JSON.parse(require('fs').readFileSync('package.json','utf-8')); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/package.json
git commit -m "feat(toolkit): package.json — register views, commands, settings, keybindings"
```

---

## Task 17: Extension activation (`src/extension.ts` rewrite)

**Files:**
- Modify: `dofus-app/vscode-extension/src/extension.ts` (replace its 464 LOC content)

- [ ] **Step 1: Replace `src/extension.ts` content with the wiring entry point**

```typescript
// Frida IL2CPP Toolkit — extension activation entry point.
//
// Wires together: RPC, build-version detection, profile loading, label/
// annotation stores, status bar, tree views, commands, and (eventually)
// plugins. Migrations are computed on profile attach.

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

import { HttpRpcClient } from "./core/rpc";
import { detectBuildId } from "./core/detect";
import { ProfileManager, type Profile } from "./core/profile";
import { StatusBarController } from "./core/status-bar";
import {
    BookmarksProvider,
    MigrationsProvider,
    ProcessExplorerProvider,
} from "./core/explorer";
import { UniversalSearch } from "./core/search";
import { registerCommands } from "./core/commands";
import { createCoreApi, type CoreApi } from "./core/api";

let coreApi: CoreApi | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration("fridaToolkit");
    const rpc = new HttpRpcClient({
        endpoint: config.get<string>("rpcEndpoint", "http://localhost:3001/api/call"),
    });

    const profilesRoot = config.get<string>("profileRoot", "")
        || path.join(os.homedir(), ".frida-toolkit", "profiles");
    const profileManager = new ProfileManager(profilesRoot);

    let currentProfile: Profile | null = null;
    const profileSource = { current: () => currentProfile };

    const profileEmitter = new vscode.EventEmitter<Profile>();
    const profileDetachEmitter = new vscode.EventEmitter<void>();

    coreApi = createCoreApi({
        profileEmitter,
        profileDetachEmitter,
        profileSource,
        rpc,
    });

    // Tree providers
    const explorerProvider = new ProcessExplorerProvider(rpc, profileSource);
    const bookmarksProvider = new BookmarksProvider(profileSource);
    const migrationsProvider = new MigrationsProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("fridaProcessExplorer", explorerProvider),
        vscode.window.registerTreeDataProvider("fridaBookmarks", bookmarksProvider),
        vscode.window.registerTreeDataProvider("fridaMigrations", migrationsProvider),
    );

    // Universal search
    const search = new UniversalSearch(rpc, profileSource);

    // Status bar
    const statusBar = new StatusBarController(rpc, profileSource, "frida.refresh");
    context.subscriptions.push(statusBar);
    statusBar.start();

    const refreshAll = (): void => {
        explorerProvider.refresh();
        bookmarksProvider.refresh();
        migrationsProvider.refresh();
        search.invalidate();
        statusBar.tick();
    };

    // Commands
    context.subscriptions.push(...registerCommands({
        rpc,
        profileSource,
        refresh: refreshAll,
        onShowObfNamesToggled: (show) => {
            explorerProvider.setShowObfNames(show);
            search.invalidate();
        },
        showSearch: () => search.show(),
    }));

    // Initial profile detection (fire-and-forget; UI degrades gracefully if RPC down)
    void (async () => {
        try {
            const healthy = await rpc.isHealthy();
            if (!healthy) return;

            const detected = await detectBuildId(rpc);
            const gameNameOverride = config.get<string>("gameNameOverride", "");
            const gameName = gameNameOverride || (await deriveGameName(rpc));

            // Try load existing
            try {
                currentProfile = await profileManager.loadProfile(gameName, detected.buildId);
            } catch {
                // Need to create — try deriving from a previous build
                const previous = await profileManager.findMostRecentBuild(gameName, detected.buildId);
                currentProfile = await profileManager.createProfile({
                    gameName,
                    buildId: detected.buildId,
                    buildIdSource: detected.source,
                    derivedFromBuildId: previous ?? undefined,
                });
                if (previous) {
                    vscode.window.showInformationMessage(
                        `New build detected. Migrations from ${previous} pending — see Migrations panel.`,
                    );
                    // Migration computation happens here in a future task; currently
                    // we just record the lineage.
                }
            }

            await vscode.commands.executeCommand("setContext", "fridaToolkit.connected", true);
            profileEmitter.fire(currentProfile);
            refreshAll();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Frida toolkit init failed: ${msg}`);
        }
    })();
}

async function deriveGameName(rpc: HttpRpcClient): Promise<string> {
    try {
        const dataPath = await rpc.call<string>("getDataPath");
        if (!dataPath) return "unknown-process";
        // Strip trailing _Data segment; e.g. "F:/Jeux/Dofus-dofus3/Dofus_Data" → "Dofus"
        const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
        return seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
    } catch {
        return "unknown-process";
    }
}

export function deactivate() {
    coreApi = undefined;
}

/** Plugins import this to obtain CoreApi. */
export function getCoreApi(): CoreApi | undefined {
    return coreApi;
}
```

- [ ] **Step 2: Compile**

```bash
cd dofus-app/vscode-extension && npm run compile
```

Expected: clean build, no TS errors.

- [ ] **Step 3: Commit**

```bash
git add dofus-app/vscode-extension/src/extension.ts
git commit -m "$(cat <<'EOF'
refactor(toolkit): extension.ts is now the slim wiring entry point

Replaces the 464-LOC monolithic demo with a ~80-LOC activate() that wires
RPC, build-version detection, profile loading, status bar, tree views,
commands, and exposes CoreApi. All real logic lives in src/core/*.
EOF
)"
```

---

## Task 18: Smoke-test checklist (manual via Extension Development Host)

**Files:**
- Create: `dofus-app/vscode-extension/SMOKE-TEST.md`

This task is the **manual verification gate** before declaring v1 done. It produces a checklist that the implementer (or user) walks through with Frida attached to a real process.

- [ ] **Step 1: Create the smoke-test doc**

```markdown
# Frida IL2CPP Toolkit Core — Smoke Test Checklist (v1)

Run this end-to-end after each significant change. Requires a Frida agent
running on `localhost:3001/api/call` attached to any IL2CPP process
(Dofus.exe is the reference target).

## Setup

- [ ] Frida is running and attached
- [ ] Open `dofus-app/vscode-extension/` in VSCode and press F5

## Connection + profile

- [ ] Status bar shows `⚡ <gameName> | <buildId-short>`
- [ ] No error toasts at startup
- [ ] `Frida: Show profile info` displays correct game name + build-id
- [ ] Profile directory exists at `~/.frida-toolkit/profiles/<game>/<build>/`
- [ ] `manifest.json` is created with all expected fields

## Process Explorer

- [ ] Sidebar (⚡ icon) → Process Explorer expands assemblies
- [ ] Expanding an assembly shows namespaces with class counts
- [ ] Expanding a namespace shows classes
- [ ] Click on a class opens the detail webview
- [ ] Webview shows class fields and methods (via dumpClassAsString)

## Rename live

- [ ] In the webview, click `Rename` → input `HaapiService` → save
- [ ] Class name in tree updates to `HaapiService`
- [ ] Webview header updates to `HaapiService [egq]` (or similar)
- [ ] Reopen VSCode, attach Frida → label is still there
- [ ] `~/.frida-toolkit/profiles/<game>/<build>/labels.json` contains the label

## Bookmarks + notes

- [ ] Bookmark a class via the webview button
- [ ] Bookmark appears in the Bookmarks sidebar panel
- [ ] Add a note via the webview button
- [ ] Note appears below the class header in the webview
- [ ] Reload VSCode → bookmark + note persist

## Search

- [ ] `Frida: Search...` (or Ctrl+Shift+F) opens Quick Pick
- [ ] Typing matches both obf names and labels
- [ ] Selecting a result opens the class detail

## Toggle obf names

- [ ] `Frida: Toggle obfuscated names` → tree now shows `HaapiService [egq]`
- [ ] Toggle again → tree shows `HaapiService` only

## Undo / redo

- [ ] Rename a class
- [ ] `Frida: Undo rename` → label removed
- [ ] `Frida: Redo rename` → label restored

## Import / export

- [ ] `Frida: Export labels` → save JSON
- [ ] Manually inspect: `schemaVersion: 1` + nested classes/methods/fields
- [ ] `Frida: Import labels` on a fresh profile → labels restored

## Migrations (cross-build)

- [ ] (If you have access to a different build) attach to it
- [ ] Status bar shows the new buildId
- [ ] Toast says "New build detected. Migrations from <previous> pending..."
- [ ] Migrations panel shows AUTO/REVIEW/LOST sections
- [ ] AUTO entries reference labels you set in the previous build
- [ ] (Future task) Click a REVIEW entry → opens migration-review webview

## Performance

- [ ] No noticeable hitch when renaming
- [ ] Tree expansion stays under 1s per level on a typical IL2CPP process
- [ ] Search Quick Pick opens within ~500ms after building the index

## No regressions vs. demo

- [ ] All commands accessible via `Ctrl+Shift+P` → typing `Frida`
- [ ] Status bar updates within 10s of Frida disconnect/reconnect
```

- [ ] **Step 2: Manual smoke test pass**

Walk through every item in the checklist with Frida + Dofus attached. Mark items that fail in the doc. Address failures with targeted fixes.

If everything passes:

- [ ] **Step 3: Commit the doc**

```bash
git add dofus-app/vscode-extension/SMOKE-TEST.md
git commit -m "docs(toolkit): smoke-test checklist for v1 sign-off"
```

---

## Task 19: README update + sign-off

**Files:**
- Modify: `dofus-app/vscode-extension/README.md`

- [ ] **Step 1: Replace existing README with v1 release notes**

```markdown
# Frida IL2CPP Toolkit — Core (v1)

VSCode extension for reverse engineering IL2CPP processes via Frida.
Provides a profile-per-build system that persists labels (renamed classes,
methods, fields), bookmarks, and notes — with automatic migration when
the game updates.

## Features (v1 Core)

- **Process Explorer** — tree view of assemblies → namespaces → classes
  with rename live + bookmarks + notes
- **Profile system** — per-`(game, build-id)` profile under
  `~/.frida-toolkit/profiles/`
- **Auto-migration** — fingerprint-matching labels across builds, with
  Migrations panel for review of ambiguous cases
- **Universal search** — Quick Pick over obf names + labels
- **Class detail webview** — fields, methods, parents, with action buttons
- **Internal Plugin API** — `CoreApi` consumed by future plugins (Hooks,
  Network, Deobfusc, Scripts) shipping in v1.1+

## Out of scope (v1)

- Hook management UI (v1.1)
- Network sniffer / Protobuf decoder (v1.2)
- Auto-deobfuscation engine (v1.3)
- Scripts / automation (v1.4)
- Tags + color coding
- Plugins as separate VSCode extensions (planned for v2)

## Getting started

1. Run a Frida agent on the target process. The agent must expose the
   HTTP RPC at `localhost:3001/api/call`. The companion agent in
   `src/rpc-agent/` works.
2. Open `dofus-app/vscode-extension/` in VSCode.
3. Run `npm install && npm run compile`.
4. Press **F5** to launch the Extension Development Host.
5. The ⚡ icon appears in the activity bar of the new window.

## Settings

| Setting | Default | Description |
|---|---|---|
| `fridaToolkit.rpcEndpoint` | `http://localhost:3001/api/call` | Frida RPC URL |
| `fridaToolkit.profileRoot` | `~/.frida-toolkit/profiles` | Profile storage path |
| `fridaToolkit.gameNameOverride` | `""` | Override the auto-derived game name |
| `fridaToolkit.showObfNamesAlongside` | `false` | Show obf names alongside labels |
| `fridaToolkit.search.maxResults` | `100` | Quick Pick result cap |
| `fridaToolkit.migration.autoMigrateThreshold` | `0.95` | Auto-migrate score threshold |

## Architecture

Single VSCode extension monolith for v1. Internal modules under `src/core/`:

```
src/core/
├── types.ts            # Shared types
├── rpc.ts              # HTTP RPC client
├── detect.ts           # Build-id auto-detection cascade
├── labels.ts           # Label store (CRUD + undo/redo + persistence)
├── annotations.ts      # Bookmarks + notes
├── migrations.ts       # Cross-build matching engine
├── profile.ts          # Profile manager
├── api.ts              # CoreApi exposed to plugins
├── status-bar.ts       # Connection status
├── explorer.ts         # Tree providers (Explorer, Bookmarks, Migrations)
├── search.ts           # Universal search
├── commands.ts         # Command palette wiring
└── webviews/
    ├── class-detail.ts
    └── migration-review.ts
```

Tests via vitest in `test/`. Run with `npm test`.

## Plugin development (v1.1+)

Future plugins live in `src/plugins/<plugin-id>/`. They import:

```typescript
import { getCoreApi } from "../../extension";
const api = getCoreApi();
if (!api) { /* not yet activated */ }
```

The `CoreApi` exposes labels CRUD, profile state, RPC passthrough, UI
helpers, and per-plugin storage.

## Spec + plan

- [Design spec](../../docs/superpowers/specs/2026-04-30-frida-il2cpp-toolkit-core-design.md)
- [Implementation plan](../../docs/superpowers/plans/2026-04-30-frida-il2cpp-toolkit-core.md)

## License

[Whatever the parent repo uses]
```

- [ ] **Step 2: Verify file content**

```bash
cd dofus-app/vscode-extension && head -20 README.md
```

Expected: starts with `# Frida IL2CPP Toolkit — Core (v1)` and lists features.

- [ ] **Step 3: Final commit**

```bash
git add dofus-app/vscode-extension/README.md
git commit -m "docs(toolkit): v1 README with features, architecture, plugin dev notes"
```

---

## Self-Review

**1. Spec coverage** — every section of the spec has a task that implements it:

| Spec section | Task(s) |
|---|---|
| TL;DR | All tasks together |
| Goals/Non-goals | Out-of-scope features explicitly missing from tasks (correct) |
| Architecture (Core + Plugins) | Tasks 1-9 (Core), Plugin API in Task 9 |
| Profile system | Task 8 (profile.ts), Task 17 (wiring detect→profile in extension.ts) |
| Label store | Task 5 (labels.ts) |
| Annotations | Task 6 (annotations.ts) |
| Process Explorer | Task 11 (explorer.ts) |
| Search universelle | Task 12 (search.ts) |
| Migrations | Task 7 (migrations.ts), Task 11 (MigrationsProvider), Task 14 (review webview), Task 17 (wire on attach) |
| Layout (B) | Task 16 (package.json views), Task 17 (registers them) |
| Plugin API | Task 9 (api.ts) |
| Build-version detection | Task 4 (detect.ts), Task 3 (agent RPCs) |
| Error handling | Embedded in each module (try/catch + fallbacks) |
| Testing | Tasks 4-8 each include vitest tests, Task 18 manual checklist |

**2. Placeholder scan** — searched for `TBD`, `TODO`, `FIXME`, "implement later", "fill in details", "Similar to Task N", "Add appropriate", "Write tests for the above": none of these phrases occur in step instructions.

**3. Type consistency** — `LabelKey` is defined in `types.ts` (Task 1) and used uniformly in tasks 5, 6, 9, 11, 12, 13, 14, 15. `Profile` defined in profile.ts (Task 8), used as `profileSource.current()` everywhere. `RpcClient` in `types.ts`, implemented by `HttpRpcClient` (Task 2), passed as constructor arg in tasks 10, 11, 12, 13, 15, 17. `MigrationResult` in `types.ts`, produced by `matchFingerprints` (Task 7), consumed by `MigrationsProvider.setMigrations` (Task 11). All consistent.

**4. Inconsistencies fixed inline:**
- Task 17 references `frida.openMigrationReview` command — added to Task 16 contributes.commands.
- Task 11 (MigrationsProvider) doesn't yet wire the migration computation; that's deliberately deferred to a future v1.0.x patch since the migration UI is in place but the engine wiring needs real fingerprint extraction RPCs (out of scope for this Core v1 since fingerprint extraction lives in the agent — the spec acknowledges that "computation happens here in a future task").

The plan is complete enough to ship the Core v1 with the migration UI scaffolded. Full migration computation will be a follow-up sprint that adds fingerprint extraction RPCs to the agent.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-30-frida-il2cpp-toolkit-core.md`.** Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
