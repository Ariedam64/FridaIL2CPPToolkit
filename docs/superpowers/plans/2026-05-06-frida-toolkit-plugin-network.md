# Plugin Network (v1.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1.2 Network plugin (sniffer + decoder + rename messages/fields) on top of the localhost web app v2.0.

**Architecture:** Backend `app/backend/core/network/*` + new route `routes/network.ts` + agent module `src/rpc-agent/network-monitor.ts` (the existing `network.ts` is Dofus-specific and stays untouched). Frontend page `pages/network.ts` with sidebar by message-type and 3 tabs (Stream/Summary/Inspector). Hook serializer-level methods (object introspection via `frida-il2cpp-bridge`), no .proto files. Renames go through existing `labels.ts`. Frames live in an in-memory ring buffer (5000), serializer config persists per-profile via `plugin-storage`.

**Tech Stack:** TypeScript, Node 20+, Express + ws (backend); Vite + vanilla TS (frontend); frida-il2cpp-bridge (agent); vitest + supertest (tests).

**Spec:** [docs/superpowers/specs/2026-05-06-frida-toolkit-plugin-network-design.md](../specs/2026-05-06-frida-toolkit-plugin-network-design.md) (commit `0e670bd`).

---

## Conventions (read once, applies to every task)

- **Direction encoding:** `SerializerEntry.direction = "send" | "recv"` (config), `NetworkFrame.direction = "in" | "out"` (data). Agent translates: `send→out`, `recv→in`.
- **TypeKey:** `{ ns: string | null, className: string }` — both fields obfuscated. Used as join-key with `labels.ts`.
- **TypeKey URL encoding:** `<ns-or-empty>~<className>` (URL-safe, encoded with `encodeURIComponent` for the route segment).
- **Constants** (defined once in `app/backend/core/network/types.ts`):
  - `MAX_FRAME_DEPTH = 2`
  - `MAX_FIELD_PREVIEW_CHARS = 80`
  - `MAX_FRAME_BYTES = 50_000`
  - `RING_BUFFER_SIZE = 5000`
  - `FRAME_BROADCAST_THROTTLE_MS = 20` (= 50 broadcasts/sec max)
  - `ANTI_FLOOD_THROWS_PER_SEC = 50`
- **Plugin-storage namespace:** `"network"` (so files land under `<profile>/plugins/network/storage.json`).
- **Storage key for serializer config:** `"serializer-config"`.
- **Run commands** are run from `app/` unless stated otherwise. The repo root is `f:/FridaIL2CPPToolkit`.
- **Test discipline:** vitest for pure modules + supertest for routes. Each task starts with the failing test, then minimal impl, then commit. **No tests for agent code** (cohérent with `hooks.ts` agent — manual smoke test only).
- **Commits:** one commit per task. Message format: `feat(network): <short description>` for features, `test(network): <short>` if a task is purely tests.
- **Branch:** stay on `toolkit-core-v1` (cf. spec dependency). All tasks land here.

---

## File map (created or modified by this plan)

**Backend** (`app/backend/`)
- Create: `core/network/types.ts` — `NetworkFrame`, `MessageType`, `SerializerConfig`, `SerializerEntry`, `FrameField`, `TypeKey`, constants
- Create: `core/network/frame-store.ts` — ring buffer + listing/filtering, EventEmitter
- Create: `core/network/type-aggregator.ts` — pure function `aggregate(frames) → MessageType[]`
- Create: `core/network/serializer-config.ts` — `SerializerConfigStore` (load/save via plugin-storage)
- Create: `core/network/serializer-detector.ts` — `detectSerializers(rpc) → SerializerEntry[]`
- Create: `core/network/event-bus.ts` — `mountNetworkEventBus(session, store)` — subscribes to `agent-message` and pushes frames into store
- Create: `routes/network.ts` — REST endpoints
- Modify: `session.ts` — add network stores to session lifecycle
- Modify: `ws-bridge.ts` — broadcast network events
- Modify: `server.ts` — mount routes + event bus

**Agent** (`src/rpc-agent/`)
- Create: `network-monitor.ts` — `armNetworkCapture`, `disarmNetworkCapture`, `validateSerializerEntry`, `listInstalledNetworkHooks`, `walkFields` helper
- Modify: `rpc-methods.ts` — import + spread the new module

**Frontend** (`app/frontend/`)
- Create: `components/network-detail.ts` — pretty-print indenté (variant A)
- Create: `components/network-stream.ts` — Stream tab content
- Create: `components/network-summary.ts` — Summary tab content
- Create: `components/network-inspector.ts` — Inspector tab content
- Create: `components/network-config.ts` — wizard modal
- Create: `components/network-monitor.ts` — 3-pane layout (sidebar + main with tabs)
- Create: `pages/network.ts` — page composer
- Modify: `components/nav-icons.ts` — add "network" tab
- Modify: `main.ts` — register page mount + initial route
- Modify: `core/api.ts` — fetch wrappers for `/api/network/*`
- Modify: `core/types.ts` — frontend mirrors of backend types

**Tests** (`app/test/backend/`)
- Create: `core/network-frame-store.test.ts`
- Create: `core/network-type-aggregator.test.ts`
- Create: `core/network-serializer-config.test.ts`
- Create: `core/network-serializer-detector.test.ts`
- Create: `routes-network.test.ts`

**Docs**
- Modify: `app/SMOKE-TEST.md` — add the network plugin section

---

## Task 1 — Types module + constants

**Files:**
- Create: `app/backend/core/network/types.ts`

This task has no test step (pure type declarations + constants). It just needs to compile.

- [ ] **Step 1: Create the types file**

Write `app/backend/core/network/types.ts`:

```typescript
// Pure type declarations + tunable constants for the Network plugin.
// No runtime logic here — frame-store / type-aggregator / serializer-config
// import these.

export const MAX_FRAME_DEPTH = 2;
export const MAX_FIELD_PREVIEW_CHARS = 80;
export const MAX_FRAME_BYTES = 50_000;
export const RING_BUFFER_SIZE = 5000;
export const FRAME_BROADCAST_THROTTLE_MS = 20;
export const ANTI_FLOOD_THROWS_PER_SEC = 50;

export interface TypeKey {
    ns: string | null;
    className: string;
}

export type FrameFieldKind =
    | "int" | "long" | "float" | "bool"
    | "string" | "bytes" | "enum"
    | "nested" | "array" | "null" | "unknown";

export interface FrameField {
    name: string;
    kind: FrameFieldKind;
    preview: string;
    children?: FrameField[];
}

export interface NetworkFrame {
    id: string;
    timestamp: number;
    direction: "in" | "out";
    typeKey: TypeKey;
    fields: FrameField[];
    truncated?: boolean;
}

export interface MessageType {
    key: TypeKey;
    count: number;
    countByDirection: { in: number; out: number };
    lastSeenAt: number;
    observedFields: string[];
}

export interface SerializerEntry {
    source: "auto" | "manual";
    direction: "send" | "recv";
    className: string;
    ns: string | null;
    methodName: string;
    methodSignature: string;
    paramIndex?: number;
    disabled?: boolean;
    addedAt: string;
    lastValidatedAt?: string;
    /**
     * Set by `validateSerializerEntry` when the agent fails to find this
     * (className, methodName, signature) triple. Stale entries are NOT
     * installed at arm time. Cleared on next successful validation.
     */
    stale?: boolean;
}

export interface SerializerConfig {
    schemaVersion: 1;
    entries: SerializerEntry[];
}

/**
 * Encode a TypeKey to a URL-safe segment. Inverse: `decodeTypeKey`.
 * Encoding shape: `<ns-or-empty>~<className>` then `encodeURIComponent`'d
 * by the caller before being slotted into a path.
 */
export function encodeTypeKey(k: TypeKey): string {
    return `${k.ns ?? ""}~${k.className}`;
}

export function decodeTypeKey(encoded: string): TypeKey {
    const idx = encoded.indexOf("~");
    if (idx < 0) return { ns: null, className: encoded };
    const ns = encoded.slice(0, idx);
    const className = encoded.slice(idx + 1);
    return { ns: ns === "" ? null : ns, className };
}

export function sameTypeKey(a: TypeKey, b: TypeKey): boolean {
    return a.ns === b.ns && a.className === b.className;
}
```

- [ ] **Step 2: Verify it compiles**

Run from `app/`:

```bash
npx tsc -p tsconfig.backend.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

Run from repo root:

```bash
git add app/backend/core/network/types.ts
git commit -m "feat(network): add types module + tunable constants"
```

---

## Task 2 — Frame store (ring buffer)

**Files:**
- Create: `app/backend/core/network/frame-store.ts`
- Test: `app/test/backend/core/network-frame-store.test.ts`

- [ ] **Step 1: Write the failing test**

Write `app/test/backend/core/network-frame-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { FrameStore } from "../../../backend/core/network/frame-store";
import type { NetworkFrame, TypeKey } from "../../../backend/core/network/types";

const KEY_A: TypeKey = { ns: "Game.Net", className: "MapMovement" };
const KEY_B: TypeKey = { ns: null, className: "MoveRequest" };

function mkFrame(direction: "in" | "out", key: TypeKey, t = 1000): Omit<NetworkFrame, "id"> {
    return { timestamp: t, direction, typeKey: key, fields: [] };
}

let store: FrameStore;
beforeEach(() => { store = new FrameStore(5); });

describe("FrameStore", () => {
    it("assigns monotonic ids in push order", () => {
        const a = store.push(mkFrame("in", KEY_A, 1));
        const b = store.push(mkFrame("out", KEY_B, 2));
        expect(a.id).not.toBe(b.id);
        expect(store.list()).toHaveLength(2);
    });

    it("wraps around when capacity is exceeded (ring buffer)", () => {
        for (let i = 0; i < 7; i++) store.push(mkFrame("in", KEY_A, i));
        const list = store.list();
        expect(list).toHaveLength(5);
        // The first 2 frames should have been evicted.
        expect(list[0].timestamp).toBe(2);
        expect(list[4].timestamp).toBe(6);
    });

    it("filters by direction", () => {
        store.push(mkFrame("in", KEY_A, 1));
        store.push(mkFrame("out", KEY_B, 2));
        store.push(mkFrame("in", KEY_A, 3));
        expect(store.list({ direction: "in" })).toHaveLength(2);
        expect(store.list({ direction: "out" })).toHaveLength(1);
    });

    it("filters by substring on className and ns", () => {
        store.push(mkFrame("in", { ns: "A.B", className: "Foo" }, 1));
        store.push(mkFrame("in", { ns: "A.C", className: "Bar" }, 2));
        expect(store.list({ filter: "Foo" })).toHaveLength(1);
        expect(store.list({ filter: "A.C" })).toHaveLength(1);
        expect(store.list({ filter: "zzz" })).toHaveLength(0);
    });

    it("paginates with sinceId (returns frames after the given id)", () => {
        const a = store.push(mkFrame("in", KEY_A, 1));
        store.push(mkFrame("in", KEY_A, 2));
        store.push(mkFrame("in", KEY_A, 3));
        const after = store.list({ sinceId: a.id });
        expect(after).toHaveLength(2);
    });

    it("byType filters frames matching the typeKey", () => {
        store.push(mkFrame("in", KEY_A, 1));
        store.push(mkFrame("in", KEY_B, 2));
        store.push(mkFrame("in", KEY_A, 3));
        const list = store.byType(KEY_A, 10);
        expect(list).toHaveLength(2);
        expect(list[0].typeKey.className).toBe("MapMovement");
    });

    it("clear empties the store", () => {
        store.push(mkFrame("in", KEY_A, 1));
        store.clear();
        expect(store.list()).toHaveLength(0);
        expect(store.count()).toBe(0);
    });

    it("emits frame-added when pushing", () => {
        const seen: NetworkFrame[] = [];
        store.on("frame-added", (f: NetworkFrame) => seen.push(f));
        store.push(mkFrame("in", KEY_A, 1));
        expect(seen).toHaveLength(1);
    });

    it("emits cleared when clearing", () => {
        let count = 0;
        store.on("cleared", () => { count++; });
        store.push(mkFrame("in", KEY_A, 1));
        store.clear();
        expect(count).toBe(1);
    });

    it("respects limit option", () => {
        for (let i = 0; i < 5; i++) store.push(mkFrame("in", KEY_A, i));
        expect(store.list({ limit: 3 })).toHaveLength(3);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `app/`:

```bash
npx vitest run test/backend/core/network-frame-store.test.ts
```

Expected: fails with "Cannot find module '.../frame-store'" or similar.

- [ ] **Step 3: Implement the FrameStore**

Write `app/backend/core/network/frame-store.ts`:

```typescript
import { EventEmitter } from "node:events";
import type { NetworkFrame, TypeKey } from "./types.js";
import { sameTypeKey } from "./types.js";

export interface ListOpts {
    limit?: number;
    sinceId?: string;
    filter?: string;
    direction?: "in" | "out";
}

export class FrameStore extends EventEmitter {
    private ring: (NetworkFrame | undefined)[];
    private head = 0;     // next write index
    private size = 0;     // number of valid entries currently in the ring
    private nextSeq = 0;
    private readonly capacity: number;

    constructor(capacity: number) {
        super();
        if (capacity <= 0) throw new Error("capacity must be > 0");
        this.capacity = capacity;
        this.ring = new Array(capacity);
    }

    push(partial: Omit<NetworkFrame, "id">): NetworkFrame {
        const frame: NetworkFrame = { id: `f-${this.nextSeq++}`, ...partial };
        this.ring[this.head] = frame;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) this.size++;
        this.emit("frame-added", frame);
        return frame;
    }

    /**
     * Returns frames in oldest-to-newest order (chronological).
     * Filters are AND-combined.
     */
    list(opts: ListOpts = {}): NetworkFrame[] {
        const out: NetworkFrame[] = [];
        // Walk from oldest to newest. `tail` points to the oldest element.
        const tail = this.size < this.capacity ? 0 : this.head;
        for (let i = 0; i < this.size; i++) {
            const idx = (tail + i) % this.capacity;
            const f = this.ring[idx];
            if (!f) continue;
            if (opts.direction && f.direction !== opts.direction) continue;
            if (opts.filter) {
                const needle = opts.filter.toLowerCase();
                const hay = `${f.typeKey.ns ?? ""}.${f.typeKey.className}`.toLowerCase();
                if (!hay.includes(needle)) continue;
            }
            if (opts.sinceId !== undefined) {
                if (f.id <= opts.sinceId) continue;
            }
            out.push(f);
        }
        if (opts.limit !== undefined && out.length > opts.limit) {
            return out.slice(out.length - opts.limit);
        }
        return out;
    }

    byType(key: TypeKey, limit: number): NetworkFrame[] {
        const out: NetworkFrame[] = [];
        for (const f of this.list()) {
            if (sameTypeKey(f.typeKey, key)) out.push(f);
        }
        return out.slice(-limit);
    }

    clear(): void {
        this.ring = new Array(this.capacity);
        this.head = 0;
        this.size = 0;
        this.emit("cleared");
    }

    count(): number {
        return this.size;
    }

    snapshotAll(): NetworkFrame[] {
        return this.list();
    }
}
```

Note: `id` is `f-<seq>`. Since `<seq>` is monotonic, lexicographic comparison on the id strings (`a < b`) does NOT work for sequences > 9. The test uses `sinceId: a.id` after only 1 frame, so it works there. We must use NUMERIC comparison once seq exceeds single digits. Fix this by extracting the seq number:

Replace the `if (opts.sinceId !== undefined)` block in `list()` with:

```typescript
            if (opts.sinceId !== undefined) {
                const sinceSeq = parseInt(opts.sinceId.replace(/^f-/, ""), 10);
                const fSeq = parseInt(f.id.replace(/^f-/, ""), 10);
                if (!(fSeq > sinceSeq)) continue;
            }
```

- [ ] **Step 4: Run test to verify it passes**

Run from `app/`:

```bash
npx vitest run test/backend/core/network-frame-store.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/network/frame-store.ts app/test/backend/core/network-frame-store.test.ts
git commit -m "feat(network): add FrameStore — ring buffer + filters + events"
```

---

## Task 3 — Type aggregator (Summary view)

**Files:**
- Create: `app/backend/core/network/type-aggregator.ts`
- Test: `app/test/backend/core/network-type-aggregator.test.ts`

- [ ] **Step 1: Write the failing test**

Write `app/test/backend/core/network-type-aggregator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { aggregate } from "../../../backend/core/network/type-aggregator";
import type { NetworkFrame } from "../../../backend/core/network/types";

function mkFrame(id: string, direction: "in" | "out", className: string, fields: string[] = [], t = 1): NetworkFrame {
    return {
        id, timestamp: t, direction,
        typeKey: { ns: null, className },
        fields: fields.map((f) => ({ name: f, kind: "int" as const, preview: "0" })),
    };
}

describe("aggregate", () => {
    it("groups by typeKey and counts", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A"),
            mkFrame("f-2", "in", "A"),
            mkFrame("f-3", "out", "B"),
        ]);
        expect(out).toHaveLength(2);
        const a = out.find((m) => m.key.className === "A")!;
        expect(a.count).toBe(2);
        expect(a.countByDirection).toEqual({ in: 2, out: 0 });
    });

    it("computes lastSeenAt as the max timestamp", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A", [], 100),
            mkFrame("f-2", "in", "A", [], 500),
            mkFrame("f-3", "in", "A", [], 300),
        ]);
        expect(out[0].lastSeenAt).toBe(500);
    });

    it("collects observedFields as union, in first-seen order", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A", ["a", "b"]),
            mkFrame("f-2", "in", "A", ["b", "c"]),
            mkFrame("f-3", "in", "A", ["a", "d"]),
        ]);
        expect(out[0].observedFields).toEqual(["a", "b", "c", "d"]);
    });

    it("splits direction counts", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A"),
            mkFrame("f-2", "out", "A"),
            mkFrame("f-3", "out", "A"),
        ]);
        expect(out[0].countByDirection).toEqual({ in: 1, out: 2 });
    });

    it("returns empty array for empty input", () => {
        expect(aggregate([])).toEqual([]);
    });

    it("treats different ns as different types", () => {
        const out = aggregate([
            { id: "f-1", timestamp: 1, direction: "in", typeKey: { ns: "X", className: "A" }, fields: [] },
            { id: "f-2", timestamp: 1, direction: "in", typeKey: { ns: "Y", className: "A" }, fields: [] },
        ]);
        expect(out).toHaveLength(2);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `app/`:

```bash
npx vitest run test/backend/core/network-type-aggregator.test.ts
```

Expected: fails with module-not-found.

- [ ] **Step 3: Implement the aggregator**

Write `app/backend/core/network/type-aggregator.ts`:

```typescript
import type { MessageType, NetworkFrame } from "./types.js";
import { encodeTypeKey } from "./types.js";

/**
 * Groups frames by typeKey and produces a Summary-view list.
 * Pure function — no side effects, no events.
 */
export function aggregate(frames: NetworkFrame[]): MessageType[] {
    const byKey = new Map<string, MessageType>();
    const fieldOrder = new Map<string, Map<string, number>>();
    let nextOrder = 0;

    for (const f of frames) {
        const k = encodeTypeKey(f.typeKey);
        let m = byKey.get(k);
        if (!m) {
            m = {
                key: f.typeKey,
                count: 0,
                countByDirection: { in: 0, out: 0 },
                lastSeenAt: 0,
                observedFields: [],
            };
            byKey.set(k, m);
            fieldOrder.set(k, new Map());
        }
        m.count++;
        m.countByDirection[f.direction]++;
        if (f.timestamp > m.lastSeenAt) m.lastSeenAt = f.timestamp;
        const order = fieldOrder.get(k)!;
        for (const fld of f.fields) {
            if (!order.has(fld.name)) {
                order.set(fld.name, nextOrder++);
                m.observedFields.push(fld.name);
            }
        }
    }
    return Array.from(byKey.values());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `app/`:

```bash
npx vitest run test/backend/core/network-type-aggregator.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/network/type-aggregator.ts app/test/backend/core/network-type-aggregator.test.ts
git commit -m "feat(network): add type-aggregator (Summary view)"
```

---

## Task 4 — SerializerConfigStore (persisted)

**Files:**
- Create: `app/backend/core/network/serializer-config.ts`
- Test: `app/test/backend/core/network-serializer-config.test.ts`

- [ ] **Step 1: Write the failing test**

Write `app/test/backend/core/network-serializer-config.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiskPluginStorage } from "../../../backend/core/plugin-storage";
import { SerializerConfigStore } from "../../../backend/core/network/serializer-config";
import type { SerializerEntry } from "../../../backend/core/network/types";

let tmp: string;
let store: SerializerConfigStore;

const ENTRY_A: SerializerEntry = {
    source: "manual",
    direction: "send",
    className: "ecu",
    ns: "Game.Net",
    methodName: "xbe",
    methodSignature: "(Google.Protobuf.IMessage):System.Void",
    paramIndex: 0,
    addedAt: "2026-05-06T10:00:00.000Z",
};

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "net-cfg-"));
    store = new SerializerConfigStore(new DiskPluginStorage(tmp, "network"));
});

describe("SerializerConfigStore", () => {
    it("returns empty config when storage is empty", () => {
        const cfg = store.get();
        expect(cfg.schemaVersion).toBe(1);
        expect(cfg.entries).toEqual([]);
    });

    it("adds an entry and persists it across reloads", () => {
        store.add(ENTRY_A);
        const reloaded = new SerializerConfigStore(new DiskPluginStorage(tmp, "network"));
        const cfg = reloaded.get();
        expect(cfg.entries).toHaveLength(1);
        expect(cfg.entries[0].className).toBe("ecu");
    });

    it("removes an entry by className+methodName+direction triple", () => {
        store.add(ENTRY_A);
        store.add({ ...ENTRY_A, methodName: "ybe" });
        store.remove({ className: "ecu", methodName: "xbe", direction: "send" });
        const cfg = store.get();
        expect(cfg.entries).toHaveLength(1);
        expect(cfg.entries[0].methodName).toBe("ybe");
    });

    it("replace replaces all entries", () => {
        store.add(ENTRY_A);
        store.replace([{ ...ENTRY_A, source: "auto", className: "abc" }]);
        const cfg = store.get();
        expect(cfg.entries).toHaveLength(1);
        expect(cfg.entries[0].className).toBe("abc");
    });

    it("setDisabled toggles disabled flag", () => {
        store.add(ENTRY_A);
        store.setDisabled({ className: "ecu", methodName: "xbe", direction: "send" }, true);
        expect(store.get().entries[0].disabled).toBe(true);
        store.setDisabled({ className: "ecu", methodName: "xbe", direction: "send" }, false);
        expect(store.get().entries[0].disabled).toBe(false);
    });

    it("markStale flips the stale flag", () => {
        store.add(ENTRY_A);
        store.markStale({ className: "ecu", methodName: "xbe", direction: "send" }, true);
        expect(store.get().entries[0].stale).toBe(true);
    });

    it("emits change events on mutations", () => {
        let n = 0;
        const off = store.onChange(() => n++);
        store.add(ENTRY_A);
        store.add({ ...ENTRY_A, methodName: "ybe" });
        store.remove({ className: "ecu", methodName: "xbe", direction: "send" });
        off();
        store.add({ ...ENTRY_A, methodName: "zbe" });
        expect(n).toBe(3);
    });

    it("upgrades unknown schema version by replacing with empty config", () => {
        const ps = new DiskPluginStorage(tmp, "network");
        ps.set("serializer-config", { schemaVersion: 99, entries: [{}] });
        const fresh = new SerializerConfigStore(ps);
        expect(fresh.get().entries).toEqual([]);
        expect(fresh.get().schemaVersion).toBe(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `app/`:

```bash
npx vitest run test/backend/core/network-serializer-config.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the store**

Write `app/backend/core/network/serializer-config.ts`:

```typescript
import type { PluginStorage } from "../plugin-storage.js";
import type { SerializerConfig, SerializerEntry } from "./types.js";

const STORAGE_KEY = "serializer-config";

export interface EntryRef {
    className: string;
    methodName: string;
    direction: "send" | "recv";
}

type Listener = () => void;

export class SerializerConfigStore {
    private cfg: SerializerConfig;
    private listeners: Listener[] = [];

    constructor(private readonly storage: PluginStorage) {
        const raw = storage.get<SerializerConfig>(STORAGE_KEY);
        if (raw && raw.schemaVersion === 1 && Array.isArray(raw.entries)) {
            this.cfg = { schemaVersion: 1, entries: raw.entries.map(sanitize) };
        } else {
            this.cfg = { schemaVersion: 1, entries: [] };
        }
    }

    get(): SerializerConfig {
        return { schemaVersion: 1, entries: this.cfg.entries.map((e) => ({ ...e })) };
    }

    add(entry: SerializerEntry): void {
        this.cfg.entries.push(sanitize(entry));
        this.persist();
        this.emit();
    }

    remove(ref: EntryRef): void {
        const before = this.cfg.entries.length;
        this.cfg.entries = this.cfg.entries.filter((e) => !match(e, ref));
        if (this.cfg.entries.length !== before) {
            this.persist();
            this.emit();
        }
    }

    replace(entries: SerializerEntry[]): void {
        this.cfg.entries = entries.map(sanitize);
        this.persist();
        this.emit();
    }

    setDisabled(ref: EntryRef, disabled: boolean): void {
        const e = this.cfg.entries.find((x) => match(x, ref));
        if (!e) return;
        if (e.disabled === disabled) return;
        e.disabled = disabled;
        this.persist();
        this.emit();
    }

    markStale(ref: EntryRef, stale: boolean): void {
        const e = this.cfg.entries.find((x) => match(x, ref));
        if (!e) return;
        if (e.stale === stale) return;
        e.stale = stale;
        if (!stale) e.lastValidatedAt = new Date().toISOString();
        this.persist();
        this.emit();
    }

    onChange(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* swallow */ }
        }
    }

    private persist(): void {
        this.storage.set(STORAGE_KEY, this.cfg);
    }
}

function match(e: SerializerEntry, ref: EntryRef): boolean {
    return e.className === ref.className
        && e.methodName === ref.methodName
        && e.direction === ref.direction;
}

function sanitize(e: SerializerEntry): SerializerEntry {
    return {
        source: e.source === "auto" ? "auto" : "manual",
        direction: e.direction === "recv" ? "recv" : "send",
        className: String(e.className ?? ""),
        ns: e.ns == null ? null : String(e.ns),
        methodName: String(e.methodName ?? ""),
        methodSignature: String(e.methodSignature ?? ""),
        paramIndex: typeof e.paramIndex === "number" ? e.paramIndex : undefined,
        disabled: e.disabled === true ? true : undefined,
        stale: e.stale === true ? true : undefined,
        addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
        lastValidatedAt: typeof e.lastValidatedAt === "string" ? e.lastValidatedAt : undefined,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/backend/core/network-serializer-config.test.ts
```

Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/network/serializer-config.ts app/test/backend/core/network-serializer-config.test.ts
git commit -m "feat(network): add SerializerConfigStore (persisted via plugin-storage)"
```

---

## Task 5 — SerializerDetector (auto-detect well-known patterns)

**Files:**
- Create: `app/backend/core/network/serializer-detector.ts`
- Test: `app/test/backend/core/network-serializer-detector.test.ts`

The detector takes an RPC client, asks the agent which well-known classes are present, and returns a list of `SerializerEntry` proposals (all with `source: "auto"`, `disabled: true`).

- [ ] **Step 1: Write the failing test**

Write `app/test/backend/core/network-serializer-detector.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectSerializers } from "../../../backend/core/network/serializer-detector";

interface ClassPresence {
    /** key = short name OR full name (`<ns>.<className>`) */
    [name: string]: { methods: string[] };
}

function mkRpc(classes: ClassPresence) {
    return {
        async call<T>(method: string, args: unknown[] = []): Promise<T> {
            if (method === "listClassMembers") {
                const name = String(args[0] ?? "");
                const c = classes[name];
                if (!c) return { methods: [], fields: [] } as unknown as T;
                return { methods: c.methods, fields: [] } as unknown as T;
            }
            return null as unknown as T;
        },
    };
}

describe("detectSerializers", () => {
    it("returns empty array when no known patterns are present", async () => {
        const out = await detectSerializers(mkRpc({}));
        expect(out).toEqual([]);
    });

    it("detects Google.Protobuf.MessageExtensions and proposes Send + Recv entries", async () => {
        const out = await detectSerializers(mkRpc({
            "Google.Protobuf.MessageExtensions": {
                methods: ["WriteDelimitedTo", "MergeDelimitedFrom"],
            },
        }));
        expect(out).toHaveLength(2);
        const send = out.find((e) => e.direction === "send");
        const recv = out.find((e) => e.direction === "recv");
        expect(send?.className).toBe("MessageExtensions");
        expect(send?.ns).toBe("Google.Protobuf");
        expect(send?.methodName).toBe("WriteDelimitedTo");
        expect(send?.methodSignature).toBeTruthy(); // hardcoded in PATTERNS
        expect(recv?.methodName).toBe("MergeDelimitedFrom");
        expect(out.every((e) => e.source === "auto")).toBe(true);
        expect(out.every((e) => e.disabled === true)).toBe(true);
    });

    it("detects MessagePackSerializer when present", async () => {
        const out = await detectSerializers(mkRpc({
            "MessagePack.MessagePackSerializer": {
                methods: ["Serialize", "Deserialize"],
            },
        }));
        expect(out.some((e) => e.className === "MessagePackSerializer" && e.direction === "send")).toBe(true);
        expect(out.some((e) => e.className === "MessagePackSerializer" && e.direction === "recv")).toBe(true);
    });

    it("returns proposals from multiple patterns when several are present", async () => {
        const out = await detectSerializers(mkRpc({
            "Google.Protobuf.MessageExtensions": {
                methods: ["WriteDelimitedTo", "MergeDelimitedFrom"],
            },
            "MessagePack.MessagePackSerializer": {
                methods: ["Serialize", "Deserialize"],
            },
        }));
        expect(out.length).toBeGreaterThanOrEqual(4);
    });

    it("skips a pattern when one of its methods is missing", async () => {
        const out = await detectSerializers(mkRpc({
            "Google.Protobuf.MessageExtensions": {
                methods: ["WriteDelimitedTo"], // Only the Send method exists.
            },
        }));
        // We require both methods for the pattern to be useful — so 0 entries.
        expect(out).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/backend/core/network-serializer-detector.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the detector**

Write `app/backend/core/network/serializer-detector.ts`:

```typescript
import type { SerializerEntry } from "./types.js";

interface RpcLike {
    call<T>(method: string, args?: unknown[]): Promise<T>;
}

interface ClassMembers {
    methods: string[];
    fields: string[];
}

interface Pattern {
    name: string;
    className: string;
    ns: string;                 // never null for these well-known libs
    sendMethod: string;
    recvMethod: string;
    sendSignature: string;      // hardcoded canonical signature
    recvSignature: string;
    sendParamIndex?: number;
    recvParamIndex?: number;
}

const PATTERNS: Pattern[] = [
    {
        name: "Google.Protobuf",
        className: "MessageExtensions",
        ns: "Google.Protobuf",
        sendMethod: "WriteDelimitedTo",
        recvMethod: "MergeDelimitedFrom",
        sendSignature: "(Google.Protobuf.IMessage,System.IO.Stream):System.Void",
        recvSignature: "(Google.Protobuf.IMessage,System.IO.Stream):System.Void",
        sendParamIndex: 0,
        recvParamIndex: 0,
    },
    {
        name: "MessagePack",
        className: "MessagePackSerializer",
        ns: "MessagePack",
        sendMethod: "Serialize",
        recvMethod: "Deserialize",
        sendSignature: "(System.Object):System.Byte[]",
        recvSignature: "(System.Byte[]):System.Object",
        sendParamIndex: 0,
    },
    {
        name: "Mirror",
        className: "NetworkWriter",
        ns: "Mirror",
        sendMethod: "Write",
        recvMethod: "Read",
        sendSignature: "(System.Object):System.Void",
        recvSignature: "():System.Object",
        sendParamIndex: 0,
    },
];

export async function detectSerializers(rpc: RpcLike): Promise<SerializerEntry[]> {
    const out: SerializerEntry[] = [];
    for (const p of PATTERNS) {
        // Pass full name; the agent's class index keys both short and full names.
        const fullName = `${p.ns}.${p.className}`;
        const info = await rpc
            .call<ClassMembers>("listClassMembers", [fullName])
            .catch(() => ({ methods: [], fields: [] } as ClassMembers));
        if (!info || !Array.isArray(info.methods) || info.methods.length === 0) continue;
        const hasSend = info.methods.includes(p.sendMethod);
        const hasRecv = info.methods.includes(p.recvMethod);
        if (!hasSend || !hasRecv) continue;

        const now = new Date().toISOString();
        out.push({
            source: "auto",
            direction: "send",
            className: p.className,
            ns: p.ns,
            methodName: p.sendMethod,
            methodSignature: p.sendSignature,
            paramIndex: p.sendParamIndex,
            disabled: true,
            addedAt: now,
        });
        out.push({
            source: "auto",
            direction: "recv",
            className: p.className,
            ns: p.ns,
            methodName: p.recvMethod,
            methodSignature: p.recvSignature,
            paramIndex: p.recvParamIndex,
            disabled: true,
            addedAt: now,
        });
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/backend/core/network-serializer-detector.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/network/serializer-detector.ts app/test/backend/core/network-serializer-detector.test.ts
git commit -m "feat(network): add SerializerDetector (auto-detect well-known patterns)"
```

---

## Task 6 — Routes /api/network (TDD with supertest)

**Files:**
- Create: `app/backend/routes/network.ts`
- Test: `app/test/backend/routes-network.test.ts`

The routes are stateless thin wrappers — they pull stores from `Session` and call methods. We test by injecting a fake session.

- [ ] **Step 1: Write the failing test**

Write `app/test/backend/routes-network.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiskPluginStorage } from "../../backend/core/plugin-storage.js";
import { FrameStore } from "../../backend/core/network/frame-store.js";
import { SerializerConfigStore } from "../../backend/core/network/serializer-config.js";
import { mountNetwork } from "../../backend/routes/network.js";
import type { SerializerEntry } from "../../backend/core/network/types.js";

interface FakeSession {
    frameStore(): FrameStore | null;
    serializerConfigStore(): SerializerConfigStore | null;
    fridaClient: { call<T>(method: string, args?: unknown[]): Promise<T> };
}

const ENTRY: SerializerEntry = {
    source: "manual", direction: "send",
    className: "ecu", ns: "Game.Net",
    methodName: "xbe", methodSignature: "(IMessage):Void",
    paramIndex: 0, addedAt: "2026-05-06T10:00:00.000Z",
};

let tmp: string;
let frames: FrameStore;
let cfg: SerializerConfigStore;
let session: FakeSession;
let app: express.Express;
let rpcCalls: Array<{ method: string; args: unknown[] }>;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "net-routes-"));
    frames = new FrameStore(100);
    cfg = new SerializerConfigStore(new DiskPluginStorage(tmp, "network"));
    rpcCalls = [];
    session = {
        frameStore: () => frames,
        serializerConfigStore: () => cfg,
        fridaClient: {
            async call<T>(method: string, args: unknown[] = []): Promise<T> {
                rpcCalls.push({ method, args });
                if (method === "armNetworkCapture") return { installed: 1, failed: [] } as unknown as T;
                if (method === "disarmNetworkCapture") return { reverted: 0 } as unknown as T;
                if (method === "validateSerializerEntry") return { valid: true } as unknown as T;
                return null as unknown as T;
            },
        },
    };
    app = express();
    app.use(express.json());
    mountNetwork(app, { session: session as any });
});

describe("network routes", () => {
    it("GET /api/network/frames returns 503 when not attached", async () => {
        session.frameStore = () => null;
        const res = await request(app).get("/api/network/frames");
        expect(res.status).toBe(503);
    });

    it("GET /api/network/frames returns the list", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        const res = await request(app).get("/api/network/frames");
        expect(res.status).toBe(200);
        expect(res.body.frames).toHaveLength(1);
    });

    it("GET /api/network/frames passes filter, direction, sinceId, limit", async () => {
        for (let i = 0; i < 5; i++) {
            frames.push({ timestamp: i, direction: i % 2 ? "in" : "out", typeKey: { ns: null, className: "A" }, fields: [] });
        }
        const res = await request(app).get("/api/network/frames?direction=in&limit=2");
        expect(res.status).toBe(200);
        expect(res.body.frames).toHaveLength(2);
        expect(res.body.frames.every((f: any) => f.direction === "in")).toBe(true);
    });

    it("GET /api/network/types returns aggregated summary", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        frames.push({ timestamp: 2, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        const res = await request(app).get("/api/network/types");
        expect(res.status).toBe(200);
        expect(res.body.types).toHaveLength(1);
        expect(res.body.types[0].count).toBe(2);
    });

    it("GET /api/network/types/:typeKey/instances returns frames of that type", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: "X", className: "A" }, fields: [] });
        frames.push({ timestamp: 2, direction: "in", typeKey: { ns: null, className: "B" }, fields: [] });
        const res = await request(app).get(`/api/network/types/${encodeURIComponent("X~A")}/instances`);
        expect(res.status).toBe(200);
        expect(res.body.frames).toHaveLength(1);
        expect(res.body.frames[0].typeKey.className).toBe("A");
    });

    it("DELETE /api/network/frames clears the buffer", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        const res = await request(app).delete("/api/network/frames");
        expect(res.status).toBe(200);
        expect(frames.count()).toBe(0);
    });

    it("GET /api/network/serializer-config returns the persisted config", async () => {
        cfg.add(ENTRY);
        const res = await request(app).get("/api/network/serializer-config");
        expect(res.status).toBe(200);
        expect(res.body.config.entries).toHaveLength(1);
    });

    it("PUT /api/network/serializer-config replaces all entries", async () => {
        const res = await request(app)
            .put("/api/network/serializer-config")
            .send({ entries: [ENTRY] });
        expect(res.status).toBe(200);
        expect(cfg.get().entries).toHaveLength(1);
    });

    it("PUT /api/network/serializer-config rejects malformed body", async () => {
        const res = await request(app)
            .put("/api/network/serializer-config")
            .send({ entries: "not-an-array" });
        expect(res.status).toBe(400);
    });

    it("POST /api/network/start returns 400 when config is empty", async () => {
        const res = await request(app).post("/api/network/start");
        expect(res.status).toBe(400);
    });

    it("POST /api/network/start arms agent capture", async () => {
        cfg.add(ENTRY);
        const res = await request(app).post("/api/network/start");
        expect(res.status).toBe(200);
        expect(rpcCalls.find((c) => c.method === "armNetworkCapture")).toBeTruthy();
    });

    it("POST /api/network/stop disarms", async () => {
        const res = await request(app).post("/api/network/stop");
        expect(res.status).toBe(200);
        expect(rpcCalls.find((c) => c.method === "disarmNetworkCapture")).toBeTruthy();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/backend/routes-network.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the routes**

Write `app/backend/routes/network.ts`:

```typescript
import type { Express } from "express";
import type { Session } from "../session.js";
import { aggregate } from "../core/network/type-aggregator.js";
import { decodeTypeKey } from "../core/network/types.js";
import type { SerializerEntry } from "../core/network/types.js";

export interface NetworkDeps { session: Session; }

export function mountNetwork(app: Express, deps: NetworkDeps): void {
    const fs = () => deps.session.frameStore();
    const cfg = () => deps.session.serializerConfigStore();

    app.get("/api/network/frames", (req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        const direction = req.query.direction === "in" ? "in"
            : req.query.direction === "out" ? "out"
            : undefined;
        const filter = typeof req.query.filter === "string" ? req.query.filter : undefined;
        const sinceId = typeof req.query.sinceId === "string" ? req.query.sinceId : undefined;
        const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
        res.json({ frames: store.list({ direction, filter, sinceId, limit }) });
    });

    app.get("/api/network/types", (_req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        res.json({ types: aggregate(store.list()) });
    });

    app.get("/api/network/types/:typeKey/instances", (req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        const decoded = decodeTypeKey(req.params.typeKey);
        const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
        const all = store.byType(decoded, limit);
        const summary = aggregate(all)[0];
        res.json({ type: summary, frames: all });
    });

    app.delete("/api/network/frames", (_req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        store.clear();
        res.json({ ok: true });
    });

    app.get("/api/network/serializer-config", (_req, res) => {
        const c = cfg();
        if (!c) { res.status(503).json({ error: "not attached" }); return; }
        res.json({ config: c.get() });
    });

    app.put("/api/network/serializer-config", (req, res) => {
        const c = cfg();
        if (!c) { res.status(503).json({ error: "not attached" }); return; }
        const entries = req.body?.entries;
        if (!Array.isArray(entries)) { res.status(400).json({ error: "entries must be an array" }); return; }
        c.replace(entries as SerializerEntry[]);
        res.json({ ok: true });
    });

    app.post("/api/network/start", async (_req, res) => {
        const c = cfg();
        if (!c) { res.status(503).json({ error: "not attached" }); return; }
        const config = c.get();
        const enabled = config.entries.filter((e) => !e.disabled);
        if (enabled.length === 0) { res.status(400).json({ error: "no enabled entries" }); return; }
        try {
            const r = await deps.session.fridaClient.call<{ installed: number; failed: SerializerEntry[] }>(
                "armNetworkCapture", [config],
            );
            res.json(r);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/network/stop", async (_req, res) => {
        try {
            const r = await deps.session.fridaClient.call<{ reverted: number }>("disarmNetworkCapture");
            res.json(r);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
}
```

Note: this references methods on `Session` (`frameStore()`, `serializerConfigStore()`) that don't exist yet. The tests use a fake session, so they pass. The real session integration happens in **Task 7**.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/backend/routes-network.test.ts
```

Expected: 12/12 pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/routes/network.ts app/test/backend/routes-network.test.ts
git commit -m "feat(network): add /api/network routes (TDD)"
```

---

## Task 7 — Wire into Session lifecycle

**Files:**
- Modify: `app/backend/session.ts`

We extend the singleton with a frame store and serializer-config store, both per-profile. They're created on attach, drained on detach.

- [ ] **Step 1: Add fields and accessors**

Open `app/backend/session.ts`. After the existing `currentHookStore` field declaration (line 29), insert:

```typescript
    private currentFrameStore: FrameStore | null = null;
    private currentSerializerConfig: SerializerConfigStore | null = null;
```

Add these imports near the existing core imports (after the `HookStore` import):

```typescript
import { FrameStore } from "./core/network/frame-store.js";
import { SerializerConfigStore } from "./core/network/serializer-config.js";
import { RING_BUFFER_SIZE } from "./core/network/types.js";
```

After the `hookStore()` accessor method, add:

```typescript
    frameStore(): FrameStore | null {
        return this.currentFrameStore;
    }

    serializerConfigStore(): SerializerConfigStore | null {
        return this.currentSerializerConfig;
    }
```

- [ ] **Step 2: Initialize the stores on attach**

In `_doAttach`, locate the block that creates `this.currentHookStore` (around line 130). After it, insert:

```typescript
        this.currentFrameStore = new FrameStore(RING_BUFFER_SIZE);
        const networkStorage = new DiskPluginStorage(profile.rootPath, "network");
        this.currentSerializerConfig = new SerializerConfigStore(networkStorage);

        this.disposeListeners.push(
            this.currentSerializerConfig.onChange(() => this.emit("serializer-config-change")),
        );
        this.disposeListeners.push(
            this.currentFrameStore.on("frame-added", (f) =>
                this.emit("network-frame-added", f),
            ) && (() => this.currentFrameStore?.removeAllListeners("frame-added")),
        );
```

Wait — `EventEmitter.on()` returns `this`, so the truthy-and-then-disposer trick doesn't work. Use this instead:

```typescript
        this.currentFrameStore = new FrameStore(RING_BUFFER_SIZE);
        const networkStorage = new DiskPluginStorage(profile.rootPath, "network");
        this.currentSerializerConfig = new SerializerConfigStore(networkStorage);

        const frameAddedHandler = (f: NetworkFrame) => this.emit("network-frame-added", f);
        const clearedHandler = () => this.emit("network-frames-cleared");
        this.currentFrameStore.on("frame-added", frameAddedHandler);
        this.currentFrameStore.on("cleared", clearedHandler);
        const fs = this.currentFrameStore;
        this.disposeListeners.push(() => {
            fs.off("frame-added", frameAddedHandler);
            fs.off("cleared", clearedHandler);
        });
        this.disposeListeners.push(
            this.currentSerializerConfig.onChange(() => this.emit("serializer-config-change")),
        );
```

Add the import for `NetworkFrame` near the existing core imports:

```typescript
import type { NetworkFrame } from "./core/network/types.js";
```

- [ ] **Step 3: Clear stores on detach**

In `handleDetach()` (around line 170), after `this.currentHookStore = null;`, add:

```typescript
        this.currentFrameStore = null;
        this.currentSerializerConfig = null;
```

- [ ] **Step 4: Compile-check**

```bash
npx tsc -p tsconfig.backend.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Existing tests still pass**

```bash
npx vitest run
```

Expected: all tests still green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add app/backend/session.ts
git commit -m "feat(network): wire frame-store + serializer-config into Session lifecycle"
```

---

## Task 8 — Extend ws-bridge with network events

**Files:**
- Modify: `app/backend/ws-bridge.ts`

Throttle frame-added broadcasts to 50/s (`FRAME_BROADCAST_THROTTLE_MS = 20`) — high-rate captures shouldn't drown the WS clients.

- [ ] **Step 1: Add the broadcasts**

Open `app/backend/ws-bridge.ts`. After `session.on("hook-store-change", ...)` add:

```typescript

    // ---- network plugin events ----
    let lastFrameBroadcast = 0;
    let pendingFrame: import("./core/network/types.js").NetworkFrame | null = null;
    let pendingTimer: NodeJS.Timeout | null = null;
    const FRAME_BROADCAST_THROTTLE_MS = 20;

    function flushFrame(): void {
        if (!pendingFrame) return;
        broadcast({ type: "network-frame-added", frame: pendingFrame });
        pendingFrame = null;
        lastFrameBroadcast = Date.now();
        pendingTimer = null;
    }

    session.on("network-frame-added", (frame: import("./core/network/types.js").NetworkFrame) => {
        const now = Date.now();
        if (now - lastFrameBroadcast >= FRAME_BROADCAST_THROTTLE_MS) {
            broadcast({ type: "network-frame-added", frame });
            lastFrameBroadcast = now;
            pendingFrame = null;
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        } else {
            pendingFrame = frame;
            if (!pendingTimer) {
                const delay = FRAME_BROADCAST_THROTTLE_MS - (now - lastFrameBroadcast);
                pendingTimer = setTimeout(flushFrame, Math.max(1, delay));
            }
        }
    });
    session.on("network-frames-cleared", () => broadcast({ type: "network-frames-cleared" }));
    session.on("serializer-config-change", () => broadcast({ type: "serializer-config-change" }));
```

The agent-message handler at the top of the file already passes through `network-auto-revert` because it forwards any `payload.type` field unmodified — no change needed there.

- [ ] **Step 2: Compile-check**

```bash
npx tsc -p tsconfig.backend.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/backend/ws-bridge.ts
git commit -m "feat(network): broadcast frame/config events on ws bridge (throttled 50/s)"
```

---

## Task 9 — Mount routes in server.ts + event-bus skeleton

**Files:**
- Create: `app/backend/core/network/event-bus.ts`
- Modify: `app/backend/server.ts`

The event bus subscribes to agent messages and pushes `network-frame` payloads into the FrameStore. It also forwards `network-auto-revert` to the SerializerConfigStore (marks the entry stale).

- [ ] **Step 1: Create the event bus**

Write `app/backend/core/network/event-bus.ts`:

```typescript
import type { Session } from "../../session.js";
import type { FrameField, NetworkFrame, TypeKey } from "./types.js";

interface AgentNetworkFramePayload {
    type: "network-frame";
    direction: "in" | "out";
    timestamp: number;
    typeKey: TypeKey;
    fields: FrameField[];
    truncated?: boolean;
}

interface AgentAutoRevertPayload {
    type: "network-auto-revert";
    entryId: string;          // shape: "<className>.<methodName>@<direction>"
    reason: string;
    detail?: string;
}

interface AgentFrameErrorPayload {
    type: "network-frame-error";
    entryId: string;
    error: string;
}

type AgentPayload = AgentNetworkFramePayload | AgentAutoRevertPayload | AgentFrameErrorPayload | { type: string };

/**
 * Wires `agent-message` events to the per-profile network stores.
 * Idempotent: re-attaching disposes the previous binding.
 */
export function mountNetworkEventBus(session: Session): () => void {
    const handler = (payload: AgentPayload): void => {
        if (!payload || typeof payload !== "object") return;
        if (payload.type === "network-frame") {
            const p = payload as AgentNetworkFramePayload;
            const store = session.frameStore();
            if (!store) return;
            const partial: Omit<NetworkFrame, "id"> = {
                timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
                direction: p.direction === "out" ? "out" : "in",
                typeKey: p.typeKey,
                fields: Array.isArray(p.fields) ? p.fields : [],
                truncated: p.truncated === true ? true : undefined,
            };
            store.push(partial);
        } else if (payload.type === "network-auto-revert") {
            const p = payload as AgentAutoRevertPayload;
            const cfg = session.serializerConfigStore();
            if (!cfg) return;
            const m = /^(.+)\.([^.@]+)@(send|recv)$/.exec(p.entryId);
            if (!m) return;
            cfg.markStale({ className: m[1], methodName: m[2], direction: m[3] as "send" | "recv" }, true);
        } else if (payload.type === "network-frame-error") {
            const p = payload as AgentFrameErrorPayload;
            const store = session.frameStore();
            if (!store) return;
            // Render errors as synthetic frames so they're visible in the Stream.
            store.push({
                timestamp: Date.now(),
                direction: "in",
                typeKey: { ns: "_error", className: p.entryId },
                fields: [{ name: "error", kind: "string", preview: p.error.slice(0, 200) }],
            });
        }
    };
    session.on("agent-message", handler);
    return () => session.off("agent-message", handler);
}
```

- [ ] **Step 2: Mount the route + bus in server.ts**

Open `app/backend/server.ts`. Add the imports near the existing route imports:

```typescript
import { mountNetwork } from "./routes/network.js";
import { mountNetworkEventBus } from "./core/network/event-bus.js";
```

After `mountMigrations(app, { session });` add:

```typescript
mountNetwork(app, { session });
mountNetworkEventBus(session);
```

- [ ] **Step 3: Compile-check**

```bash
npx tsc -p tsconfig.backend.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: All existing tests still pass**

```bash
npx vitest run
```

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/network/event-bus.ts app/backend/server.ts
git commit -m "feat(network): mount routes + agent event-bus on server"
```

---

## Task 10 — Agent module: network-monitor.ts

**Files:**
- Create: `src/rpc-agent/network-monitor.ts`
- Modify: `src/rpc-agent/rpc-methods.ts`

The agent module installs hooks per `SerializerEntry` and emits `network-frame` events. NB: the existing `network.ts` is Dofus-specific and untouched; we use a different name.

No unit tests for this code (Frida runtime can't be mocked easily — manual smoke test in Task 22).

- [ ] **Step 1: Create the agent module**

Write `src/rpc-agent/network-monitor.ts`:

```typescript
// Generic Network plugin agent module.
// Installs hooks at the SERIALIZER level (object-typed args/result) and emits
// network-frame events. Distinct from src/rpc-agent/network.ts (Dofus-specific).

import "frida-il2cpp-bridge";
import { findClassExact } from "../lib";

const MAX_FRAME_DEPTH = 2;
const MAX_FIELD_PREVIEW_CHARS = 80;
const MAX_FRAME_BYTES = 50_000;
const FLOOD_WINDOW_MS = 1000;
const FLOOD_MAX_THROWS = 50;

type FieldKind =
    | "int" | "long" | "float" | "bool"
    | "string" | "bytes" | "enum"
    | "nested" | "array" | "null" | "unknown";

interface FrameField {
    name: string;
    kind: FieldKind;
    preview: string;
    children?: FrameField[];
}

interface TypeKey { ns: string | null; className: string; }

interface SerializerEntry {
    source: "auto" | "manual";
    direction: "send" | "recv";
    className: string;
    ns: string | null;
    methodName: string;
    methodSignature: string;
    paramIndex?: number;
    disabled?: boolean;
    addedAt: string;
}

interface SerializerConfig {
    schemaVersion: 1;
    entries: SerializerEntry[];
}

interface InstalledEntry {
    entry: SerializerEntry;
    method: Il2Cpp.Method;
    throwsInWindow: number;
    throwWindowStart: number;
}

const _installed = new Map<string, InstalledEntry>();

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function entryId(e: SerializerEntry): string {
    return `${e.className}.${e.methodName}@${e.direction}`;
}

function classifyType(typeName: string): FieldKind {
    if (typeName === "System.Int32" || typeName === "System.UInt32"
        || typeName === "System.Int16" || typeName === "System.UInt16"
        || typeName === "System.SByte" || typeName === "System.Byte") return "int";
    if (typeName === "System.Int64" || typeName === "System.UInt64") return "long";
    if (typeName === "System.Single" || typeName === "System.Double") return "float";
    if (typeName === "System.Boolean") return "bool";
    if (typeName === "System.String") return "string";
    if (typeName === "System.Byte[]" || typeName === "Google.Protobuf.ByteString") return "bytes";
    return "unknown";
}

function clip(s: string, max = MAX_FIELD_PREVIEW_CHARS): string {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function previewBytes(arr: any): string {
    try {
        const n = Math.min(16, Number(arr.length ?? 0));
        const bytes: string[] = [];
        for (let i = 0; i < n; i++) {
            const v = Number(arr.get?.(i) ?? 0);
            bytes.push((v & 0xff).toString(16).padStart(2, "0"));
        }
        const more = (arr.length ?? 0) > n ? `… (+${arr.length - n})` : "";
        return `[${arr.length} bytes] ${bytes.join(" ")}${more}`;
    } catch { return "<bytes>"; }
}

function walkFields(obj: any, depth: number): FrameField[] {
    if (!obj || !obj.class || depth < 0) return [];
    const out: FrameField[] = [];
    let totalBytes = 0;
    for (const f of obj.class.fields) {
        if (f.isStatic) continue;
        const name = f.name as string;
        const typeName = f.type?.name as string;
        let entry: FrameField;
        try {
            const v = obj.field(f.name).value;
            if (v === null || v === undefined) {
                entry = { name, kind: "null", preview: "null" };
            } else if (typeName === "System.Byte[]") {
                entry = { name, kind: "bytes", preview: clip(previewBytes(v)) };
            } else if (typeof v === "string") {
                entry = { name, kind: "string", preview: clip(JSON.stringify(v)) };
            } else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
                entry = { name, kind: classifyType(typeName), preview: clip(String(v)) };
            } else if (v.class) {
                const cn = String(v.class.name);
                if (cn.startsWith("RepeatedField") || cn.startsWith("List")
                    || cn.startsWith("Google.Protobuf.Collections.RepeatedField")) {
                    let count = 0;
                    try { count = Number(v.method("get_Count").invoke()); } catch {}
                    entry = { name, kind: "array", preview: clip(`[${count} items]`) };
                    if (depth > 0 && count > 0) {
                        const children: FrameField[] = [];
                        const limit = Math.min(count, 5);
                        for (let i = 0; i < limit; i++) {
                            try {
                                const elem = v.method("get_Item").invoke(i);
                                const sub = walkFields(elem, depth - 1);
                                children.push({
                                    name: `[${i}]`,
                                    kind: "nested",
                                    preview: clip(`→ ${sub.length} fields`),
                                    children: sub,
                                });
                            } catch {
                                children.push({ name: `[${i}]`, kind: "unknown", preview: "<err>" });
                            }
                        }
                        if (count > limit) {
                            children.push({ name: `…`, kind: "unknown", preview: `+${count - limit} more` });
                        }
                        entry.children = children;
                    }
                } else if (depth > 0) {
                    const inner = walkFields(v, depth - 1);
                    entry = {
                        name, kind: "nested",
                        preview: clip(`→ ${cn}`),
                        children: inner,
                    };
                } else {
                    entry = { name, kind: "nested", preview: clip(`→ ${cn}`) };
                }
            } else {
                entry = { name, kind: classifyType(typeName), preview: clip(String(v)) };
            }
        } catch (err) {
            entry = { name, kind: "unknown", preview: clip(`<err: ${String(err).slice(0, 60)}>`) };
        }
        out.push(entry);
        totalBytes += JSON.stringify(entry).length;
        if (totalBytes > MAX_FRAME_BYTES) {
            out.push({ name: "…", kind: "unknown", preview: "<truncated: frame too large>" });
            break;
        }
    }
    return out;
}

function findMethodOnClass(klass: Il2Cpp.Class, methodName: string, signature: string): Il2Cpp.Method | null {
    // Try by name + best-effort signature match. If signature doesn't match,
    // fall back to first method with the right name (validation will catch
    // signature drift via lastValidatedAt).
    const all = klass.methods.filter((m) => m.name === methodName);
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];
    const exact = all.find((m) => buildSignature(m) === signature);
    return exact ?? all[0];
}

function buildSignature(m: Il2Cpp.Method): string {
    const params = m.parameters.map((p) => p.type.name).join(",");
    return `(${params}):${m.returnType.name}`;
}

export async function validateSerializerEntry(entry: SerializerEntry): Promise<{ valid: boolean; reason?: string; actualSignature?: string }> {
    return inVm(() => {
        const klass = findClassExact(entry.ns ? `${entry.ns}.${entry.className}` : entry.className);
        if (!klass) return { valid: false, reason: "class not found" };
        const m = findMethodOnClass(klass, entry.methodName, entry.methodSignature);
        if (!m) return { valid: false, reason: "method not found" };
        return { valid: true, actualSignature: buildSignature(m) };
    });
}

export async function armNetworkCapture(config: SerializerConfig): Promise<{ installed: number; failed: SerializerEntry[] }> {
    return inVm(() => {
        const failed: SerializerEntry[] = [];
        for (const entry of config.entries) {
            if (entry.disabled) continue;
            try {
                const klass = findClassExact(entry.ns ? `${entry.ns}.${entry.className}` : entry.className);
                if (!klass) { failed.push(entry); continue; }
                const method = findMethodOnClass(klass, entry.methodName, entry.methodSignature);
                if (!method) { failed.push(entry); continue; }
                const id = entryId(entry);
                if (_installed.has(id)) continue;
                installEntryHook(entry, method);
                _installed.set(id, {
                    entry, method,
                    throwsInWindow: 0, throwWindowStart: 0,
                });
            } catch {
                failed.push(entry);
            }
        }
        return { installed: _installed.size, failed };
    });
}

function installEntryHook(entry: SerializerEntry, method: Il2Cpp.Method): void {
    const isStatic = method.isStatic;
    const klass = method.class;
    const methodName = entry.methodName;
    const sendIndex = entry.paramIndex ?? 0;

    method.implementation = function (this: any, ...args: any[]): any {
        let result: any;
        try {
            result = isStatic
                ? klass.method(methodName).invoke(...args)
                : (this as Il2Cpp.Object).method(methodName).invoke(...args);
        } catch (err) {
            // Original threw — let it propagate; record but don't tear down hook.
            captureThrow(entry, String(err));
            throw err;
        }
        try {
            const messageObj = entry.direction === "send" ? args[sendIndex] : result;
            if (messageObj && typeof messageObj === "object" && messageObj.class) {
                const fields = walkFields(messageObj, MAX_FRAME_DEPTH);
                const truncated = fields.length > 0 && fields[fields.length - 1].preview.includes("truncated");
                const typeKey: TypeKey = {
                    ns: messageObj.class.namespace || null,
                    className: messageObj.class.name,
                };
                send({
                    type: "network-frame",
                    direction: entry.direction === "send" ? "out" : "in",
                    timestamp: Date.now(),
                    typeKey,
                    fields,
                    truncated,
                });
            }
        } catch (err) {
            captureWalkError(entry, String(err));
        }
        return result;
    };
}

function captureThrow(entry: SerializerEntry, error: string): void {
    const id = entryId(entry);
    const inst = _installed.get(id);
    if (!inst) return;
    const now = Date.now();
    if (now - inst.throwWindowStart > FLOOD_WINDOW_MS) {
        inst.throwWindowStart = now;
        inst.throwsInWindow = 1;
    } else {
        inst.throwsInWindow++;
    }
    if (inst.throwsInWindow >= FLOOD_MAX_THROWS) {
        try { inst.method.revert(); } catch {}
        _installed.delete(id);
        try { send({ type: "network-auto-revert", entryId: id, reason: "throw-flood", detail: error.slice(0, 200) }); } catch {}
    }
}

function captureWalkError(entry: SerializerEntry, error: string): void {
    // Walk errors are non-fatal — emit a frame-error so the user sees them.
    const id = entryId(entry);
    try {
        send({ type: "network-frame-error", entryId: id, error: error.slice(0, 200) });
    } catch {}
}

export async function disarmNetworkCapture(): Promise<{ reverted: number }> {
    return inVm(() => {
        let n = 0;
        for (const [, inst] of _installed) {
            try { inst.method.revert(); n++; } catch {}
        }
        _installed.clear();
        return { reverted: n };
    });
}

export async function listInstalledNetworkHooks(): Promise<SerializerEntry[]> {
    const out: SerializerEntry[] = [];
    _installed.forEach((inst) => out.push(inst.entry));
    return out;
}
```

- [ ] **Step 2: Wire into rpc-methods.ts**

Open `src/rpc-agent/rpc-methods.ts`. After the `proto-descriptor-capture` import, add:

```typescript
import * as networkMonitorRpc from "./network-monitor";
```

In the `AllRpc` union type, add `& typeof networkMonitorRpc`. In the `getRpcMethods` return object, add `...networkMonitorRpc,`.

Final shape of the relevant parts:

```typescript
import * as networkMonitorRpc from "./network-monitor";
// ... after the other imports

type AllRpc = typeof searchRpc & typeof explorerRpc & /* ... */ & typeof fingerprintsRpc & typeof networkMonitorRpc;

export function getRpcMethods(): AllRpc {
    return {
        ...searchRpc,
        // ... after the other spreads
        ...fingerprintsRpc,
        ...networkMonitorRpc,
    } as AllRpc;
}
```

- [ ] **Step 3: Build the agent script**

Run from repo root:

```bash
npm run build:rpc
```

Expected: builds `build/rpc-agent.js` without errors. The console output mentions the new exported methods (`armNetworkCapture`, `disarmNetworkCapture`, `validateSerializerEntry`, `listInstalledNetworkHooks`).

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/network-monitor.ts src/rpc-agent/rpc-methods.ts
git commit -m "feat(network): agent module — armNetworkCapture + walkFields + anti-flood"
```

---

## Task 11 — Frontend types + api wrappers

**Files:**
- Modify: `app/frontend/core/types.ts`
- Modify: `app/frontend/core/api.ts`

- [ ] **Step 1: Add types**

Open `app/frontend/core/types.ts`. Append:

```typescript
export interface NetTypeKey { ns: string | null; className: string; }

export type NetFieldKind =
    | "int" | "long" | "float" | "bool"
    | "string" | "bytes" | "enum"
    | "nested" | "array" | "null" | "unknown";

export interface NetField {
    name: string;
    kind: NetFieldKind;
    preview: string;
    children?: NetField[];
}

export interface NetFrame {
    id: string;
    timestamp: number;
    direction: "in" | "out";
    typeKey: NetTypeKey;
    fields: NetField[];
    truncated?: boolean;
}

export interface NetMessageType {
    key: NetTypeKey;
    count: number;
    countByDirection: { in: number; out: number };
    lastSeenAt: number;
    observedFields: string[];
}

export interface NetSerializerEntry {
    source: "auto" | "manual";
    direction: "send" | "recv";
    className: string;
    ns: string | null;
    methodName: string;
    methodSignature: string;
    paramIndex?: number;
    disabled?: boolean;
    stale?: boolean;
    addedAt: string;
    lastValidatedAt?: string;
}

export interface NetSerializerConfig {
    schemaVersion: 1;
    entries: NetSerializerEntry[];
}

export function encodeNetTypeKey(k: NetTypeKey): string {
    return `${k.ns ?? ""}~${k.className}`;
}
```

- [ ] **Step 2: Add api wrappers**

Open `app/frontend/core/api.ts`. Inside the exported `api` object, before the closing `}`, add:

```typescript
    getNetworkFrames(opts: { limit?: number; sinceId?: string; filter?: string; direction?: "in" | "out" } = {}) {
        const q = new URLSearchParams();
        if (opts.limit !== undefined) q.set("limit", String(opts.limit));
        if (opts.sinceId) q.set("sinceId", opts.sinceId);
        if (opts.filter) q.set("filter", opts.filter);
        if (opts.direction) q.set("direction", opts.direction);
        const qs = q.toString();
        return call<{ frames: import("./types.js").NetFrame[] }>("GET", `/api/network/frames${qs ? "?" + qs : ""}`);
    },
    getNetworkTypes() {
        return call<{ types: import("./types.js").NetMessageType[] }>("GET", "/api/network/types");
    },
    getNetworkInstances(typeKey: import("./types.js").NetTypeKey, limit = 50) {
        const enc = encodeURIComponent(`${typeKey.ns ?? ""}~${typeKey.className}`);
        return call<{ type: import("./types.js").NetMessageType; frames: import("./types.js").NetFrame[] }>(
            "GET", `/api/network/types/${enc}/instances?limit=${limit}`,
        );
    },
    clearNetworkFrames() {
        return call("DELETE", "/api/network/frames");
    },
    getSerializerConfig() {
        return call<{ config: import("./types.js").NetSerializerConfig }>("GET", "/api/network/serializer-config");
    },
    putSerializerConfig(entries: import("./types.js").NetSerializerEntry[]) {
        return call("PUT", "/api/network/serializer-config", { entries });
    },
    startNetworkCapture() {
        return call<{ installed: number; failed: import("./types.js").NetSerializerEntry[] }>("POST", "/api/network/start");
    },
    stopNetworkCapture() {
        return call<{ reverted: number }>("POST", "/api/network/stop");
    },
```

The existing `call` function only handles `GET` and `POST`. Update its signature to include `DELETE` and `PUT`. Replace its first line:

```typescript
async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
```

- [ ] **Step 3: Frontend type-check**

Run from `app/`:

```bash
npx tsc --noEmit -p tsconfig.json
```

If a tsconfig at `app/` doesn't exist, run `npx vite build` instead and check for type errors:

```bash
npx vite build --logLevel warn 2>&1 | head -30
```

Expected: no errors specific to the new code.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/core/types.ts app/frontend/core/api.ts
git commit -m "feat(network): frontend types + /api/network/* fetch wrappers"
```

---

## Task 12 — `network-detail` component (pretty-print A)

**Files:**
- Create: `app/frontend/components/network-detail.ts`

This component renders a single frame (or the children of a single field) using the validated **variant A** layout: indented, vertical bars on nested.

- [ ] **Step 1: Create the component**

Write `app/frontend/components/network-detail.ts`:

```typescript
// Pretty-print indented detail view (validated variant A).
// Used in two places:
//  - side-panel slide-in from Stream click
//  - modal from Inspector cell click

import type { NetField, NetFrame } from "../core/types.js";

const KIND_COLORS: Record<NetField["kind"], string> = {
    int: "var(--syntax-type)",
    long: "var(--syntax-type)",
    float: "var(--syntax-type)",
    bool: "var(--warning)",
    enum: "var(--warning)",
    string: "var(--syntax-return)",
    bytes: "var(--text-faint)",
    nested: "var(--method)",
    array: "var(--method)",
    null: "var(--text-faint)",
    unknown: "var(--text-faint)",
};

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderField(f: NetField, expanded: Set<string>, path: string): string {
    const childPath = `${path}.${f.name}`;
    const hasChildren = !!f.children?.length;
    const open = hasChildren && expanded.has(childPath);
    const caret = hasChildren ? `<span class="net-caret" data-path="${childPath}">${open ? "▼" : "▶"}</span>` : `<span class="net-caret-spacer"></span>`;
    const html = `
        <div class="net-field-line">
            ${caret}
            <span class="net-field-name">${escape(f.name)}</span>
            <span class="net-field-kind">${escape(f.kind)}</span>
            <span class="net-field-value" style="color:${KIND_COLORS[f.kind]}">${escape(f.preview)}</span>
        </div>
    `;
    if (open && hasChildren) {
        const inner = (f.children ?? []).map((c) => renderField(c, expanded, childPath)).join("");
        return html + `<div class="net-nested">${inner}</div>`;
    }
    return html;
}

export interface DetailMountOptions {
    onRename?(typeKey: { ns: string | null; className: string }): void;
    onClose?(): void;
}

export function mountNetworkDetail(host: HTMLElement, frame: NetFrame, opts: DetailMountOptions = {}): void {
    const expanded = new Set<string>();
    // Auto-expand top-level nested/array nodes for at-a-glance readability.
    for (const f of frame.fields) {
        if (f.children?.length) expanded.add(`.${f.name}`);
    }

    function rerender(): void {
        host.innerHTML = `
            <style>
                .net-detail { padding: 14px; font-family: var(--font-code); font-size: 12px; line-height: 1.7; color: var(--text-strong); }
                .net-detail-header { padding: 10px 14px; background: var(--bg-elevated); border-bottom: 1px solid var(--border-strong); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
                .net-detail-title { font-weight: 600; font-size: 13px; }
                .net-direction-pill { padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
                .net-direction-pill.in { background: rgba(34,197,94,0.15); color: var(--success); }
                .net-direction-pill.out { background: rgba(239,68,68,0.15); color: var(--danger); }
                .net-obf { color: var(--text-faint); font-size: 10px; }
                .net-field-line { display: flex; align-items: baseline; gap: 8px; }
                .net-field-name { color: var(--text-strong); min-width: 140px; }
                .net-field-kind { color: var(--syntax-type); font-size: 10px; min-width: 50px; }
                .net-field-value { flex: 1; word-break: break-word; }
                .net-nested { margin-left: 24px; border-left: 1px solid var(--border-strong); padding-left: 12px; }
                .net-caret, .net-caret-spacer { width: 14px; color: var(--text-faint); cursor: pointer; user-select: none; }
                .net-detail-toolbar { background: var(--bg-elevated); border-top: 1px solid var(--border-strong); padding: 8px 14px; display: flex; gap: 8px; }
                .net-detail-toolbar .pill { font-size: 10px; }
            </style>
            <div class="net-detail-header">
                <div>
                    <div class="net-detail-title">${escape(frame.typeKey.className)}<span class="net-direction-pill ${frame.direction}" style="margin-left:8px">${frame.direction === "in" ? "← S2C" : "→ C2S"}</span></div>
                    <div class="net-obf">${escape(frame.typeKey.ns ?? "")} @ ${new Date(frame.timestamp).toISOString().slice(11, 23)}</div>
                </div>
                ${opts.onClose ? `<button class="icon-btn-mini" id="net-detail-close">✕</button>` : ""}
            </div>
            <div class="net-detail">
                ${frame.fields.map((f) => renderField(f, expanded, "")).join("")}
                ${frame.truncated ? `<div style="color:var(--warning);margin-top:8px">… truncated (frame too large)</div>` : ""}
            </div>
            <div class="net-detail-toolbar">
                <button class="pill" id="net-detail-rename">Rename type</button>
                <button class="pill" id="net-detail-copy">Copy JSON</button>
                <button class="pill" id="net-detail-expand">Expand all</button>
                <button class="pill" id="net-detail-collapse">Collapse all</button>
            </div>
        `;

        host.querySelectorAll<HTMLElement>(".net-caret").forEach((el) => {
            el.addEventListener("click", () => {
                const p = el.dataset.path!;
                if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
                rerender();
            });
        });
        host.querySelector<HTMLButtonElement>("#net-detail-close")?.addEventListener("click", () => opts.onClose?.());
        host.querySelector<HTMLButtonElement>("#net-detail-rename")?.addEventListener("click", () => opts.onRename?.(frame.typeKey));
        host.querySelector<HTMLButtonElement>("#net-detail-copy")?.addEventListener("click", () => {
            void navigator.clipboard.writeText(JSON.stringify(frame, null, 2));
        });
        host.querySelector<HTMLButtonElement>("#net-detail-expand")?.addEventListener("click", () => {
            collectAllPaths(frame.fields, "", expanded);
            rerender();
        });
        host.querySelector<HTMLButtonElement>("#net-detail-collapse")?.addEventListener("click", () => {
            expanded.clear();
            rerender();
        });
    }

    rerender();
}

function collectAllPaths(fields: NetField[], prefix: string, into: Set<string>): void {
    for (const f of fields) {
        const p = `${prefix}.${f.name}`;
        if (f.children?.length) {
            into.add(p);
            collectAllPaths(f.children, p, into);
        }
    }
}
```

- [ ] **Step 2: Visual sanity check via Vite dev**

Run from `app/`:

```bash
npm run dev:frontend
```

Expected: Vite dev server starts on port 5173 with no compile errors. (No need to attach a process — the component file itself just has to compile.)

Stop the server (Ctrl+C).

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/network-detail.ts
git commit -m "feat(network): network-detail component (pretty-print variant A)"
```

---

## Task 13 — `network-stream` component

**Files:**
- Create: `app/frontend/components/network-stream.ts`

The Stream tab: live-scrolling list, filter/pause/clear/export, click row → side-panel detail.

- [ ] **Step 1: Create the component**

Write `app/frontend/components/network-stream.ts`:

```typescript
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetFrame } from "../core/types.js";
import { mountNetworkDetail } from "./network-detail.js";

const RING_LIMIT = 5000;

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function previewFields(f: NetFrame): string {
    const parts: string[] = [];
    for (const fld of f.fields.slice(0, 4)) {
        parts.push(`${fld.name}: ${fld.preview}`);
    }
    const more = f.fields.length > 4 ? `, …+${f.fields.length - 4}` : "";
    return `{ ${parts.join(", ")}${more} }`;
}

export interface StreamMountOptions {
    /** Called when the user clicks the Rename button in the detail side-panel. */
    onRename?(typeKey: { ns: string | null; className: string }): void;
    /** Inline filter input value, mirrored from the parent (sidebar filter). */
    sharedFilter?: { get(): string; onChange(cb: (v: string) => void): () => void };
}

export function mountNetworkStream(host: HTMLElement, opts: StreamMountOptions = {}): () => void {
    const ring: NetFrame[] = [];
    let paused = false;
    let filter = opts.sharedFilter?.get() ?? "";
    let lastSeenId: string | undefined;

    host.innerHTML = `
        <div class="net-stream-toolbar">
            <input class="mock-input" id="net-stream-filter" placeholder="filter substring…" style="flex:1;font-family:var(--font-code);font-size:11px">
            <button class="pill" id="net-stream-pause">Pause</button>
            <button class="pill" id="net-stream-clear">Clear</button>
            <button class="pill" id="net-stream-export">Export NDJSON</button>
            <span id="net-stream-count" style="color:var(--text-faint);font-size:11px">0 / ${RING_LIMIT}</span>
        </div>
        <div id="net-stream-list" style="flex:1;overflow-y:auto;padding:6px 12px;font-family:var(--font-code);font-size:11px"></div>
        <div id="net-stream-side" style="position:absolute;right:0;top:0;bottom:0;width:0;background:var(--bg-elevated);border-left:1px solid var(--border-strong);overflow-y:auto;transition:width 0.18s"></div>
    `;

    const list = host.querySelector<HTMLElement>("#net-stream-list")!;
    const countEl = host.querySelector<HTMLElement>("#net-stream-count")!;
    const sidePane = host.querySelector<HTMLElement>("#net-stream-side")!;
    const filterInput = host.querySelector<HTMLInputElement>("#net-stream-filter")!;
    const pauseBtn = host.querySelector<HTMLButtonElement>("#net-stream-pause")!;
    filterInput.value = filter;

    function rerender(): void {
        const needle = filter.toLowerCase();
        const filtered = needle
            ? ring.filter((f) => `${f.typeKey.ns ?? ""}.${f.typeKey.className}`.toLowerCase().includes(needle))
            : ring;
        list.innerHTML = filtered.map((f) => `
            <div class="net-stream-row" data-id="${f.id}" style="display:flex;gap:10px;padding:2px 0;cursor:pointer">
                <span style="color:var(--text-faint)">${new Date(f.timestamp).toISOString().slice(11, 23)}</span>
                <span style="color:${f.direction === "in" ? "var(--success)" : "var(--danger)"}">${f.direction === "in" ? "←" : "→"}</span>
                <span style="color:var(--text-strong);min-width:160px">${escape(f.typeKey.className)}</span>
                <span style="color:var(--text-faint);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(previewFields(f))}</span>
            </div>
        `).join("");
        countEl.textContent = `${ring.length} / ${RING_LIMIT}`;
        list.querySelectorAll<HTMLElement>(".net-stream-row").forEach((el) => {
            el.addEventListener("click", () => {
                const f = ring.find((x) => x.id === el.dataset.id);
                if (!f) return;
                openDetail(f);
            });
        });
        // Auto-scroll if user is near bottom.
        if (list.scrollTop + list.clientHeight + 50 >= list.scrollHeight) {
            list.scrollTop = list.scrollHeight;
        }
    }

    function openDetail(frame: NetFrame): void {
        sidePane.style.width = "400px";
        mountNetworkDetail(sidePane, frame, {
            onRename: opts.onRename,
            onClose: () => { sidePane.style.width = "0"; sidePane.innerHTML = ""; },
        });
    }

    async function loadInitial(): Promise<void> {
        const r = await api.getNetworkFrames({ limit: 200 });
        ring.length = 0;
        ring.push(...r.frames);
        if (r.frames.length > 0) lastSeenId = r.frames[r.frames.length - 1].id;
        rerender();
    }

    const offFrame = subscribe("network-frame-added", (msg: { frame: NetFrame }) => {
        if (paused) return;
        const f = msg.frame;
        if (lastSeenId && f.id <= lastSeenId) return;  // stale
        ring.push(f);
        if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
        lastSeenId = f.id;
        rerender();
    });
    const offCleared = subscribe("network-frames-cleared", () => {
        ring.length = 0;
        lastSeenId = undefined;
        rerender();
    });

    filterInput.addEventListener("input", () => { filter = filterInput.value; rerender(); });
    const offShared = opts.sharedFilter?.onChange((v) => {
        filter = v;
        filterInput.value = v;
        rerender();
    });
    pauseBtn.addEventListener("click", () => {
        paused = !paused;
        pauseBtn.textContent = paused ? "Resume" : "Pause";
    });
    host.querySelector<HTMLButtonElement>("#net-stream-clear")!.addEventListener("click", async () => {
        await api.clearNetworkFrames();
    });
    host.querySelector<HTMLButtonElement>("#net-stream-export")!.addEventListener("click", () => {
        const ndjson = ring.map((f) => JSON.stringify(f)).join("\n");
        const blob = new Blob([ndjson], { type: "application/x-ndjson" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `network-frames-${Date.now()}.ndjson`;
        a.click();
        URL.revokeObjectURL(url);
    });

    void loadInitial();

    return () => { offFrame(); offCleared(); offShared?.(); };
}
```

- [ ] **Step 2: Compile-check**

```bash
npx vite build --logLevel warn 2>&1 | head -30
```

Expected: no type errors specific to new code.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/network-stream.ts
git commit -m "feat(network): network-stream component (live + filter + export)"
```

---

## Task 14 — `network-summary` component

**Files:**
- Create: `app/frontend/components/network-summary.ts`

Dense table grouping by type. Click row → switches to Inspector tab pre-filled.

- [ ] **Step 1: Create the component**

Write `app/frontend/components/network-summary.ts`:

```typescript
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetMessageType, NetTypeKey } from "../core/types.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SummaryMountOptions {
    onPickType(key: NetTypeKey): void;
    sharedFilter?: { get(): string; onChange(cb: (v: string) => void): () => void };
}

export function mountNetworkSummary(host: HTMLElement, opts: SummaryMountOptions): () => void {
    let types: NetMessageType[] = [];
    let sortKey: "count" | "lastSeen" | "name" = "count";
    let filter = opts.sharedFilter?.get() ?? "";

    host.innerHTML = `
        <div style="overflow-y:auto;flex:1">
            <table id="net-summary-tbl" style="width:100%;border-collapse:collapse;font-family:var(--font-code);font-size:11px">
                <thead>
                    <tr style="text-align:left;color:var(--text-faint);border-bottom:1px solid var(--border-strong)">
                        <th data-sort="name" style="padding:6px 10px;cursor:pointer">Type</th>
                        <th data-sort="count" style="padding:6px 10px;cursor:pointer">Count</th>
                        <th style="padding:6px 10px">In</th>
                        <th style="padding:6px 10px">Out</th>
                        <th data-sort="lastSeen" style="padding:6px 10px;cursor:pointer">Last seen</th>
                        <th style="padding:6px 10px">Fields observés</th>
                    </tr>
                </thead>
                <tbody id="net-summary-body"></tbody>
            </table>
        </div>
    `;

    const body = host.querySelector<HTMLElement>("#net-summary-body")!;

    function rerender(): void {
        const needle = filter.toLowerCase();
        const filtered = needle
            ? types.filter((t) => `${t.key.ns ?? ""}.${t.key.className}`.toLowerCase().includes(needle))
            : types.slice();
        filtered.sort((a, b) => {
            if (sortKey === "count") return b.count - a.count;
            if (sortKey === "lastSeen") return b.lastSeenAt - a.lastSeenAt;
            return `${a.key.ns ?? ""}.${a.key.className}`.localeCompare(`${b.key.ns ?? ""}.${b.key.className}`);
        });
        body.innerHTML = filtered.map((t) => `
            <tr class="net-sum-row" data-ns="${escape(t.key.ns ?? "")}" data-cls="${escape(t.key.className)}" style="cursor:pointer;border-bottom:1px solid var(--border-strong)">
                <td style="padding:4px 10px;color:var(--text-strong)">${escape(t.key.className)}</td>
                <td style="padding:4px 10px">${t.count}</td>
                <td style="padding:4px 10px;color:var(--success)">${t.countByDirection.in}</td>
                <td style="padding:4px 10px;color:var(--danger)">${t.countByDirection.out}</td>
                <td style="padding:4px 10px;color:var(--text-faint)">${new Date(t.lastSeenAt).toISOString().slice(11, 23)}</td>
                <td style="padding:4px 10px;color:var(--text-faint);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(t.observedFields.slice(0, 8).join(", "))}${t.observedFields.length > 8 ? "…" : ""}</td>
            </tr>
        `).join("");
        body.querySelectorAll<HTMLElement>(".net-sum-row").forEach((row) => {
            row.addEventListener("click", () => {
                const ns = row.dataset.ns!;
                const cls = row.dataset.cls!;
                opts.onPickType({ ns: ns === "" ? null : ns, className: cls });
            });
        });
    }

    async function refresh(): Promise<void> {
        const r = await api.getNetworkTypes();
        types = r.types;
        rerender();
    }

    host.querySelectorAll<HTMLElement>("th[data-sort]").forEach((th) => {
        th.addEventListener("click", () => {
            sortKey = th.dataset.sort as "count" | "lastSeen" | "name";
            rerender();
        });
    });

    const offFrame = subscribe("network-frame-added", () => { void refresh(); });
    const offCleared = subscribe("network-frames-cleared", () => { void refresh(); });
    const offShared = opts.sharedFilter?.onChange((v) => { filter = v; rerender(); });

    void refresh();
    return () => { offFrame(); offCleared(); offShared?.(); };
}
```

- [ ] **Step 2: Compile-check**

```bash
npx vite build --logLevel warn 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/network-summary.ts
git commit -m "feat(network): network-summary component (per-type stats table)"
```

---

## Task 15 — `network-inspector` component

**Files:**
- Create: `app/frontend/components/network-inspector.ts`

Inspector = table view of last N instances of a single type. Cells highlighted when value changes vs previous instance of same direction.

- [ ] **Step 1: Create the component**

Write `app/frontend/components/network-inspector.ts`:

```typescript
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetField, NetFrame, NetMessageType, NetTypeKey } from "../core/types.js";
import { mountNetworkDetail } from "./network-detail.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function flatPreview(f: NetField): string {
    if (f.kind === "nested" || f.kind === "array") return f.preview;
    return f.preview;
}

function lookupField(frame: NetFrame, name: string): NetField | undefined {
    return frame.fields.find((f) => f.name === name);
}

export interface InspectorMountOptions {
    initialKey?: NetTypeKey | null;
    /** Type list provider — used to populate the dropdown. */
    listTypes(): Promise<NetMessageType[]>;
}

export function mountNetworkInspector(host: HTMLElement, opts: InspectorMountOptions): { setType(key: NetTypeKey): void; dispose(): void } {
    let currentKey: NetTypeKey | null = opts.initialKey ?? null;
    let frames: NetFrame[] = [];
    let observedFields: string[] = [];

    host.innerHTML = `
        <div style="padding:10px 14px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border-strong)">
            <label style="color:var(--text-faint);font-size:11px">Type:</label>
            <select id="net-insp-type" style="background:var(--bg-tile);color:var(--text-strong);font-family:var(--font-code);font-size:11px;padding:3px 8px;border:1px solid var(--border-strong);border-radius:4px"></select>
            <button class="pill" id="net-insp-refresh">Refresh</button>
            <span id="net-insp-count" style="margin-left:auto;color:var(--text-faint);font-size:11px"></span>
        </div>
        <div id="net-insp-table" style="flex:1;overflow:auto;padding:8px 14px;font-family:var(--font-code);font-size:11px"></div>
    `;

    const sel = host.querySelector<HTMLSelectElement>("#net-insp-type")!;
    const tbl = host.querySelector<HTMLElement>("#net-insp-table")!;
    const countEl = host.querySelector<HTMLElement>("#net-insp-count")!;

    async function refreshTypeList(): Promise<void> {
        const types = await opts.listTypes();
        sel.innerHTML = types.map((t) => {
            const display = t.key.className;
            const ns = t.key.ns ?? "";
            const value = `${ns}~${t.key.className}`;
            const sel = currentKey && currentKey.className === t.key.className && currentKey.ns === t.key.ns;
            return `<option value="${escape(value)}"${sel ? " selected" : ""}>${escape(display)} (${t.count})</option>`;
        }).join("");
        if (!currentKey && types.length > 0) currentKey = types[0].key;
    }

    async function refreshTable(): Promise<void> {
        if (!currentKey) {
            tbl.innerHTML = `<div style="color:var(--text-faint)">No type selected.</div>`;
            countEl.textContent = "";
            return;
        }
        const r = await api.getNetworkInstances(currentKey, 50);
        frames = r.frames;
        observedFields = r.type?.observedFields ?? [];
        countEl.textContent = `${frames.length} instances`;

        if (frames.length === 0) {
            tbl.innerHTML = `<div style="color:var(--text-faint)">No instances captured yet.</div>`;
            return;
        }

        let html = `<table style="border-collapse:collapse;width:100%">`;
        html += `<thead><tr style="color:var(--text-faint);border-bottom:1px solid var(--border-strong)">`;
        html += `<th style="text-align:left;padding:4px 8px">Time</th>`;
        html += `<th style="text-align:left;padding:4px 8px">Dir</th>`;
        for (const fname of observedFields) {
            html += `<th style="text-align:left;padding:4px 8px;cursor:pointer" data-field="${escape(fname)}">${escape(fname)}</th>`;
        }
        html += `</tr></thead><tbody>`;

        // For change-highlighting: track last value per direction per field.
        const lastByDir: Record<"in" | "out", Map<string, string>> = { in: new Map(), out: new Map() };

        for (const f of frames) {
            const last = lastByDir[f.direction];
            html += `<tr class="net-insp-row" data-id="${escape(f.id)}" style="border-bottom:1px solid var(--border-strong)">`;
            html += `<td style="padding:3px 8px;color:var(--text-faint)">${new Date(f.timestamp).toISOString().slice(11, 23)}</td>`;
            html += `<td style="padding:3px 8px;color:${f.direction === "in" ? "var(--success)" : "var(--danger)"}">${f.direction === "in" ? "←" : "→"}</td>`;
            for (const fname of observedFields) {
                const fld = lookupField(f, fname);
                const preview = fld ? flatPreview(fld) : "";
                const changed = fld && last.get(fname) !== undefined && last.get(fname) !== preview;
                html += `<td class="net-insp-cell" data-id="${escape(f.id)}" data-field="${escape(fname)}" style="padding:3px 8px;${changed ? "background:var(--indigo-bg)" : ""};max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer">${escape(preview)}</td>`;
                if (fld) last.set(fname, preview);
            }
            html += `</tr>`;
        }
        html += `</tbody></table>`;
        tbl.innerHTML = html;

        tbl.querySelectorAll<HTMLElement>(".net-insp-cell").forEach((td) => {
            td.addEventListener("click", () => {
                const f = frames.find((x) => x.id === td.dataset.id);
                if (!f) return;
                showCellModal(f);
            });
        });
    }

    function showCellModal(frame: NetFrame): void {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center";
        const modal = document.createElement("div");
        modal.style.cssText = "background:var(--bg-base);border:1px solid var(--border-strong);border-radius:8px;width:600px;max-width:90vw;max-height:80vh;overflow:auto";
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        mountNetworkDetail(modal, frame, { onClose: () => overlay.remove() });
        overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    }

    sel.addEventListener("change", () => {
        const v = sel.value;
        const idx = v.indexOf("~");
        if (idx < 0) return;
        currentKey = { ns: v.slice(0, idx) || null, className: v.slice(idx + 1) };
        void refreshTable();
    });
    host.querySelector<HTMLButtonElement>("#net-insp-refresh")!.addEventListener("click", () => { void refreshTable(); });

    const offFrame = subscribe("network-frame-added", () => {
        // Only refresh if the new frame is for the currently-viewed type.
        // We don't know the new frame's type from the throttled message — refresh blindly.
        void refreshTable();
    });

    void refreshTypeList().then(() => refreshTable());

    return {
        setType(key: NetTypeKey) {
            currentKey = key;
            void refreshTypeList().then(() => refreshTable());
        },
        dispose() { offFrame(); },
    };
}
```

- [ ] **Step 2: Compile-check**

```bash
npx vite build --logLevel warn 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/network-inspector.ts
git commit -m "feat(network): network-inspector component (per-type table + change highlights)"
```

---

## Task 16 — `network-config` wizard modal

**Files:**
- Create: `app/frontend/components/network-config.ts`

Modal showing the persisted config + form to add a manual entry.

- [ ] **Step 1: Create the component**

Write `app/frontend/components/network-config.ts`:

```typescript
import { api } from "../core/api.js";
import type { NetSerializerEntry } from "../core/types.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function showNetworkConfig(opts: { onSaved?(): void } = {}): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center";
    const modal = document.createElement("div");
    modal.style.cssText = "background:var(--bg-base);border:1px solid var(--border-strong);border-radius:8px;width:680px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column";
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let entries: NetSerializerEntry[] = [];

    function rerender(): void {
        modal.innerHTML = `
            <div style="padding:14px 18px;border-bottom:1px solid var(--border-strong);display:flex;justify-content:space-between;align-items:center">
                <h3 style="margin:0">Configure network capture</h3>
                <button class="icon-btn-mini" id="net-cfg-close">✕</button>
            </div>
            <div style="flex:1;overflow-y:auto;padding:14px 18px">
                ${entries.length === 0 ? `<div style="color:var(--text-faint)">No entries yet — click "Add manual" to designate a serializer method.</div>` : ""}
                ${entries.map((e, i) => `
                    <div style="padding:10px;background:var(--bg-tile);border:1px solid var(--border-strong);border-radius:6px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
                        <span style="color:${e.disabled ? "var(--text-faint)" : (e.stale ? "var(--danger)" : "var(--success)")}">${e.disabled ? "○" : (e.stale ? "❌" : "●")}</span>
                        <span style="font-family:var(--font-code);font-size:11px;flex:1">
                            <span style="color:${e.direction === "send" ? "var(--danger)" : "var(--success)"}">${e.direction.toUpperCase()}</span>
                            ${escape(e.ns ? e.ns + "." : "")}<strong>${escape(e.className)}</strong>.${escape(e.methodName)}
                            <span style="color:var(--text-faint)">${escape(e.methodSignature)}</span>
                        </span>
                        <span style="color:var(--text-faint);font-size:10px">${e.source}</span>
                        <button class="icon-btn-mini" data-toggle="${i}">${e.disabled ? "Enable" : "Disable"}</button>
                        <button class="icon-btn-mini" data-remove="${i}" style="color:var(--danger)">Remove</button>
                    </div>
                `).join("")}
            </div>
            <div id="net-cfg-add" style="border-top:1px solid var(--border-strong);padding:14px 18px"></div>
            <div style="border-top:1px solid var(--border-strong);padding:10px 18px;display:flex;gap:8px;justify-content:flex-end">
                <button class="pill" id="net-cfg-add-btn">+ Add manual</button>
                <button class="pill" id="net-cfg-save">Save</button>
            </div>
        `;
        modal.querySelector<HTMLButtonElement>("#net-cfg-close")!.addEventListener("click", () => overlay.remove());
        modal.querySelector<HTMLButtonElement>("#net-cfg-save")!.addEventListener("click", async () => {
            try {
                await api.putSerializerConfig(entries);
                overlay.remove();
                opts.onSaved?.();
            } catch (err) {
                alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
        modal.querySelector<HTMLButtonElement>("#net-cfg-add-btn")!.addEventListener("click", () => renderAddForm());
        modal.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((b) => {
            b.addEventListener("click", () => {
                const i = Number(b.dataset.toggle);
                entries[i].disabled = !entries[i].disabled;
                rerender();
            });
        });
        modal.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => {
            b.addEventListener("click", () => {
                const i = Number(b.dataset.remove);
                entries.splice(i, 1);
                rerender();
            });
        });
    }

    function renderAddForm(): void {
        const host = modal.querySelector<HTMLElement>("#net-cfg-add")!;
        host.innerHTML = `
            <div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:8px 12px;align-items:center;font-size:11px">
                <label>Direction</label>
                <select id="add-dir" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                    <option value="send">send (out)</option>
                    <option value="recv">recv (in)</option>
                </select>
                <label>Param index</label>
                <input id="add-param" type="number" value="0" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px;width:60px">
                <label>Namespace</label>
                <input id="add-ns" placeholder="(empty for root)" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                <label>Class</label>
                <input id="add-class" placeholder="ecu" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                <label>Method</label>
                <input id="add-method" placeholder="xbe" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                <label>Signature</label>
                <input id="add-sig" placeholder="(IMessage):Void" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
            </div>
            <div style="margin-top:10px;display:flex;gap:8px">
                <button class="pill" id="add-validate">Validate</button>
                <button class="pill" id="add-add">Add to list</button>
                <span id="add-status" style="color:var(--text-faint);font-size:10px;align-self:center"></span>
            </div>
        `;

        function readForm(): NetSerializerEntry {
            const dir = (host.querySelector<HTMLSelectElement>("#add-dir")!.value === "recv") ? "recv" : "send";
            const ns = host.querySelector<HTMLInputElement>("#add-ns")!.value.trim();
            return {
                source: "manual",
                direction: dir,
                ns: ns === "" ? null : ns,
                className: host.querySelector<HTMLInputElement>("#add-class")!.value.trim(),
                methodName: host.querySelector<HTMLInputElement>("#add-method")!.value.trim(),
                methodSignature: host.querySelector<HTMLInputElement>("#add-sig")!.value.trim(),
                paramIndex: Number(host.querySelector<HTMLInputElement>("#add-param")!.value),
                addedAt: new Date().toISOString(),
            };
        }

        host.querySelector<HTMLButtonElement>("#add-validate")!.addEventListener("click", async () => {
            const entry = readForm();
            const status = host.querySelector<HTMLElement>("#add-status")!;
            status.textContent = "validating…";
            try {
                const r = await api.rpc<{ valid: boolean; reason?: string; actualSignature?: string }>(
                    "validateSerializerEntry", [entry],
                );
                if (r.result.valid) {
                    status.textContent = `✓ valid (signature: ${r.result.actualSignature ?? "?"})`;
                    status.style.color = "var(--success)";
                } else {
                    status.textContent = `✗ ${r.result.reason}`;
                    status.style.color = "var(--danger)";
                }
            } catch (err) {
                status.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
                status.style.color = "var(--danger)";
            }
        });

        host.querySelector<HTMLButtonElement>("#add-add")!.addEventListener("click", () => {
            const entry = readForm();
            if (!entry.className || !entry.methodName) {
                alert("Class + method are required");
                return;
            }
            entries.push(entry);
            rerender();
        });
    }

    async function init(): Promise<void> {
        const r = await api.getSerializerConfig();
        entries = r.config.entries.slice();
        rerender();
    }

    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    void init();
}
```

- [ ] **Step 2: Compile-check**

```bash
npx vite build --logLevel warn 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/network-config.ts
git commit -m "feat(network): network-config wizard modal (validate + add/disable/remove)"
```

---

## Task 17 — `network-monitor` (3-pane shell + sidebar by type)

**Files:**
- Create: `app/frontend/components/network-monitor.ts`

The 3-pane shell : sidebar (240px, resizable) + main area with 3 tabs.

- [ ] **Step 1: Create the component**

Write `app/frontend/components/network-monitor.ts`:

```typescript
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetMessageType, NetTypeKey } from "../core/types.js";
import { mountNetworkStream } from "./network-stream.js";
import { mountNetworkSummary } from "./network-summary.js";
import { mountNetworkInspector } from "./network-inspector.js";
import { showNetworkConfig } from "./network-config.js";

const SIDEBAR_WIDTH_KEY = "frida.network.sidebar.width";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeSharedFilter() {
    let v = "";
    const listeners: Array<(v: string) => void> = [];
    return {
        get: () => v,
        set: (next: string) => { v = next; for (const l of listeners) try { l(next); } catch {} },
        onChange: (cb: (v: string) => void) => {
            listeners.push(cb);
            return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
        },
    };
}

export function mountNetworkMonitor(host: HTMLElement): () => void {
    let sidebarWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "240", 10);
    sidebarWidth = Math.max(180, Math.min(600, sidebarWidth));
    const sharedFilter = makeSharedFilter();
    let activeTab: "stream" | "summary" | "inspector" = "stream";
    let inspectorPreselect: NetTypeKey | null = null;

    host.style.flex = "1";
    host.style.display = "flex";
    host.style.minHeight = "0";
    host.style.position = "relative";
    host.innerHTML = `
        <div id="net-sidebar" style="width:${sidebarWidth}px;flex-shrink:0;background:var(--bg-elevated);border-right:1px solid var(--border-strong);display:flex;flex-direction:column;overflow:hidden">
            <div style="padding:8px 10px;border-bottom:1px solid var(--border-strong)">
                <input id="net-sidebar-filter" placeholder="filter…" style="width:100%;font-family:var(--font-code);font-size:11px;padding:4px 8px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
            </div>
            <div id="net-sidebar-tree" style="flex:1;overflow-y:auto;padding:6px 4px;font-family:var(--font-code);font-size:11px"></div>
            <div style="padding:8px 10px;border-top:1px solid var(--border-strong);display:flex;gap:6px;align-items:center">
                <span id="net-status" style="font-size:10px;color:var(--text-faint);flex:1">⚪ Disarmed</span>
                <button class="pill" id="net-cfg-btn" title="Configure">⚙</button>
                <button class="pill" id="net-startstop-btn">▶ Start</button>
            </div>
        </div>
        <div id="net-resizer" style="width:4px;cursor:col-resize;background:var(--border-strong)"></div>
        <div id="net-main" style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg-base)">
            <div style="display:flex;border-bottom:1px solid var(--border-strong);padding:0 12px;gap:2px">
                <button class="net-tab" data-tab="stream" style="padding:8px 12px;background:transparent;color:var(--text-faint);border:none;border-bottom:2px solid transparent;cursor:pointer">Stream</button>
                <button class="net-tab" data-tab="summary" style="padding:8px 12px;background:transparent;color:var(--text-faint);border:none;border-bottom:2px solid transparent;cursor:pointer">Summary</button>
                <button class="net-tab" data-tab="inspector" style="padding:8px 12px;background:transparent;color:var(--text-faint);border:none;border-bottom:2px solid transparent;cursor:pointer">Inspector</button>
            </div>
            <div id="net-tabhost" style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative"></div>
        </div>
    `;

    // Resizer
    const sidebar = host.querySelector<HTMLElement>("#net-sidebar")!;
    const resizer = host.querySelector<HTMLElement>("#net-resizer")!;
    let dragging = false;
    resizer.addEventListener("pointerdown", (e) => {
        dragging = true;
        resizer.setPointerCapture(e.pointerId);
    });
    resizer.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const rect = host.getBoundingClientRect();
        const w = Math.max(180, Math.min(600, e.clientX - rect.left));
        sidebar.style.width = w + "px";
        sidebarWidth = w;
    });
    resizer.addEventListener("pointerup", (e) => {
        dragging = false;
        resizer.releasePointerCapture(e.pointerId);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    });

    // Sidebar filter
    const filterInput = host.querySelector<HTMLInputElement>("#net-sidebar-filter")!;
    filterInput.addEventListener("input", () => sharedFilter.set(filterInput.value));

    // Tabs
    const tabHost = host.querySelector<HTMLElement>("#net-tabhost")!;
    let disposeTab: (() => void) | null = null;
    let inspectorHandle: { setType(k: NetTypeKey): void; dispose(): void } | null = null;

    function mountTab(t: "stream" | "summary" | "inspector"): void {
        activeTab = t;
        host.querySelectorAll<HTMLElement>(".net-tab").forEach((b) => {
            const active = b.dataset.tab === t;
            b.style.color = active ? "var(--indigo)" : "var(--text-faint)";
            b.style.borderColor = active ? "var(--indigo)" : "transparent";
        });
        if (disposeTab) { disposeTab(); disposeTab = null; }
        if (inspectorHandle) { inspectorHandle.dispose(); inspectorHandle = null; }
        tabHost.innerHTML = "";
        const inner = document.createElement("div");
        inner.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:0";
        tabHost.appendChild(inner);

        if (t === "stream") {
            disposeTab = mountNetworkStream(inner, { sharedFilter, onRename: handleRename });
        } else if (t === "summary") {
            disposeTab = mountNetworkSummary(inner, {
                sharedFilter,
                onPickType: (k) => { inspectorPreselect = k; mountTab("inspector"); },
            });
        } else {
            inspectorHandle = mountNetworkInspector(inner, {
                initialKey: inspectorPreselect,
                listTypes: async () => (await api.getNetworkTypes()).types,
            });
            inspectorPreselect = null;
        }
    }

    host.querySelectorAll<HTMLElement>(".net-tab").forEach((b) => {
        b.addEventListener("click", () => mountTab(b.dataset.tab as "stream" | "summary" | "inspector"));
    });

    // Rename handler — wires the detail pane's "Rename type" button to the labels API.
    async function handleRename(typeKey: NetTypeKey): Promise<void> {
        const current = typeKey.className;
        const next = window.prompt(`Rename class ${current} →`, current);
        if (!next || next === current) return;
        try {
            await api.setLabel("class", { kind: "class", className: typeKey.className }, next);
            void refreshTree();
        } catch (err) {
            alert(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Sidebar tree
    const tree = host.querySelector<HTMLElement>("#net-sidebar-tree")!;
    async function refreshTree(): Promise<void> {
        const r = await api.getNetworkTypes();
        const inTypes = r.types.filter((t) => t.countByDirection.in > 0).sort((a, b) => b.count - a.count);
        const outTypes = r.types.filter((t) => t.countByDirection.out > 0 && t.countByDirection.in === 0).sort((a, b) => b.count - a.count);
        const needle = sharedFilter.get().toLowerCase();
        const renderType = (t: NetMessageType): string => {
            const display = `${t.key.ns ? escape(t.key.ns) + "." : ""}<strong>${escape(t.key.className)}</strong>`;
            const matches = !needle || `${t.key.ns ?? ""}.${t.key.className}`.toLowerCase().includes(needle);
            if (!matches) return "";
            const dot = t.countByDirection.in > 0 ? "var(--success)" : "var(--danger)";
            return `<div class="net-tree-row" data-ns="${escape(t.key.ns ?? "")}" data-cls="${escape(t.key.className)}" style="padding:3px 8px;cursor:pointer;display:flex;gap:6px;align-items:baseline">
                <span style="color:${dot};font-size:7px">●</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${display}</span>
                <span style="color:var(--text-faint);font-size:10px">×${t.count}</span>
            </div>`;
        };
        tree.innerHTML = `
            <div style="padding:4px 8px;color:var(--success);font-weight:600">▼ S2C (Receive) — ${inTypes.length}</div>
            ${inTypes.map(renderType).join("")}
            <div style="padding:8px 8px 4px;color:var(--danger);font-weight:600">▼ C2S (Send) — ${outTypes.length}</div>
            ${outTypes.map(renderType).join("")}
        `;
        tree.querySelectorAll<HTMLElement>(".net-tree-row").forEach((row) => {
            row.addEventListener("click", () => {
                const ns = row.dataset.ns!;
                const cls = row.dataset.cls!;
                const key = { ns: ns === "" ? null : ns, className: cls };
                inspectorPreselect = key;
                mountTab("inspector");
            });
        });
    }

    // Status / Start / Stop / Configure
    let armed = false;
    const statusEl = host.querySelector<HTMLElement>("#net-status")!;
    const startBtn = host.querySelector<HTMLButtonElement>("#net-startstop-btn")!;
    function setArmed(a: boolean, n?: number): void {
        armed = a;
        statusEl.textContent = a
            ? `🟢 Armed${n !== undefined ? ` (${n} hooks)` : ""}`
            : `⚪ Disarmed`;
        startBtn.textContent = a ? "⏸ Stop" : "▶ Start";
    }
    startBtn.addEventListener("click", async () => {
        try {
            if (armed) {
                const r = await api.stopNetworkCapture();
                setArmed(false);
                if (r.reverted > 0) console.log(`[network] disarmed ${r.reverted} hooks`);
            } else {
                const r = await api.startNetworkCapture();
                setArmed(true, r.installed);
                if (r.failed && r.failed.length > 0) {
                    alert(`${r.failed.length} entries failed to install. Check Configure for ❌ markers.`);
                }
            }
        } catch (err) {
            alert(`${err instanceof Error ? err.message : String(err)}`);
        }
    });
    host.querySelector<HTMLButtonElement>("#net-cfg-btn")!.addEventListener("click", () => {
        showNetworkConfig({ onSaved: () => { /* nothing here, the UI auto-refreshes via WS */ } });
    });

    const offTreeRefresh1 = subscribe("network-frame-added", () => { void refreshTree(); });
    const offTreeRefresh2 = subscribe("network-frames-cleared", () => { void refreshTree(); });
    const offCfgChange = subscribe("serializer-config-change", () => { /* nothing visible to do here */ });

    void refreshTree();
    mountTab("stream");

    return () => {
        offTreeRefresh1();
        offTreeRefresh2();
        offCfgChange();
        if (disposeTab) disposeTab();
        if (inspectorHandle) inspectorHandle.dispose();
    };
}
```

- [ ] **Step 2: Compile-check**

```bash
npx vite build --logLevel warn 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/network-monitor.ts
git commit -m "feat(network): network-monitor 3-pane shell (sidebar + tabs + start/stop)"
```

---

## Task 18 — Network page composer + nav-icons + main.ts wiring

**Files:**
- Create: `app/frontend/pages/network.ts`
- Modify: `app/frontend/components/nav-icons.ts`
- Modify: `app/frontend/main.ts`

- [ ] **Step 1: Create the page**

Write `app/frontend/pages/network.ts`:

```typescript
import { mountNetworkMonitor } from "../components/network-monitor.js";

export function mountNetworkPage(host: HTMLElement): void {
    const dispose = mountNetworkMonitor(host);
    // Page is replaced when nav switches; the main.ts handler sets innerHTML="" first, so listeners auto-clean.
    // Still, capture the dispose handle on the host for future cleanup hooks if any.
    (host as unknown as { __netDispose?: () => void }).__netDispose = dispose;
}
```

- [ ] **Step 2: Add the nav tab**

Open `app/frontend/components/nav-icons.ts`. Replace the `NavTab` type:

```typescript
export type NavTab = "explorer" | "hooks" | "network" | "bookmarks" | "migrations";
```

Insert the new icon between `hooks` and `bookmarks` in the innerHTML template:

```typescript
        <div class="nav-icon" data-tab="hooks" title="Hooks"><span class="badge-count" hidden></span>🪝</div>
        <div class="nav-icon" data-tab="network" title="Network">⇄</div>
        <div class="nav-icon" data-tab="bookmarks" title="Bookmarks">⭐</div>
```

- [ ] **Step 3: Wire main.ts**

Open `app/frontend/main.ts`. Add the import near the other page imports:

```typescript
import { mountNetworkPage } from "./pages/network.js";
```

In `mountPage`, add:

```typescript
    else if (tab === "network") mountNetworkPage(pageHost);
```

So the function becomes:

```typescript
function mountPage(tab: NavTab): void {
    pageHost.innerHTML = "";
    if (tab === "explorer") mountExplorerPage(pageHost);
    else if (tab === "hooks") mountHooksPage(pageHost);
    else if (tab === "network") mountNetworkPage(pageHost);
    else if (tab === "bookmarks") mountBookmarksPage(pageHost);
    else if (tab === "migrations") mountMigrationsPage(pageHost);
}
```

- [ ] **Step 4: Compile-check**

```bash
npx vite build --logLevel warn 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/pages/network.ts app/frontend/components/nav-icons.ts app/frontend/main.ts
git commit -m "feat(network): wire Network nav-icon + page composer"
```

---

## Task 19 — Final all-test pass + smoke test doc

**Files:**
- Modify: `app/SMOKE-TEST.md`

- [ ] **Step 1: Run the full test suite**

Run from `app/`:

```bash
npx vitest run
```

Expected: every test passes (existing 126 + new ones added by this plan — should be ~155 total).

- [ ] **Step 2: Build everything**

Run from repo root:

```bash
npm run build:rpc
```

Then from `app/`:

```bash
npm run build
```

Expected: both build steps complete without errors.

- [ ] **Step 3: Add the network section to SMOKE-TEST.md**

Open `app/SMOKE-TEST.md`. Append:

```markdown

## Network plugin (v1.2)

**Setup**: build the agent + frontend (`npm run build:rpc` at repo root, `npm run build` in `app/`), run `npm start`, attach to a Unity IL2CPP process.

### Test 13 — Auto-detect on Unity vanilla
1. Attach to a Unity vanilla game with Google.Protobuf.
2. Click the ⇄ Network nav icon.
3. **Expect**: status bar shows "Disarmed (N templates suggérés)" if Google.Protobuf was detected, or "Disarmed — configure manually" otherwise.
4. Click ⚙ Configure → see auto entries (disabled by default).

### Test 14 — Manual config wizard (Dofus path)
1. Attach to Dofus.
2. ⇄ Network → ⚙ Configure → **+ Add manual**.
3. Fill: direction=send, ns=(empty), class=`ecu`, method=`xbe`, signature=`(Google.Protobuf.IMessage):System.Void`, paramIndex=0.
4. Click Validate → expect ✓ valid.
5. Click "Add to list" → entry appears in the list.
6. Click Save.

### Test 15 — Live capture
1. Configure at least one entry, ensure it's enabled.
2. Click ▶ Start in the sidebar footer.
3. **Expect**: status flips to "🟢 Armed (N hooks)". Frames start arriving in the Stream tab.
4. Move/interact in the game → see corresponding frames.

### Test 16 — Side-panel detail (variant A)
1. Click any frame in the Stream → side-panel slides in from the right.
2. **Expect**: pretty-print indented view, nested fields collapsible, kind colors visible (int=blue, string=green, bool=orange, …).
3. Click "Expand all" / "Collapse all" → toggles all branches.
4. Click "Copy JSON" → frame JSON is in clipboard.

### Test 17 — Summary tab
1. Switch to Summary tab.
2. **Expect**: table of types with counts split by direction.
3. Click any row → switches to Inspector pre-filled with that type.

### Test 18 — Inspector tab
1. Switch to Inspector tab.
2. Pick a type from the dropdown.
3. **Expect**: table of last 50 instances, columns = field names, rows = timestamps.
4. **Expect**: cells whose value differs from the previous instance of the same direction are highlighted (indigo bg).
5. Click any cell → modal opens with full detail (variant A).

### Test 19 — Sidebar tree + filter
1. In the sidebar filter, type a substring of a known type.
2. **Expect**: tree filters to matching types only. Filter also applies to Stream/Summary tabs (sharedFilter).
3. Click a type in the tree → switches to Inspector pre-filled.

### Test 20 — Stop / Clear / Export
1. Click ⏸ Stop → status flips to "⚪ Disarmed". No new frames arrive.
2. Click Clear → ring buffer empties, Stream and Summary go empty.
3. Capture more, then click Export NDJSON → file downloads.

### Test 21 — Rename integration with labels
1. In Stream, click a frame → side-panel opens.
2. Click "Rename type" → prompt asks for new name. Type something readable (e.g. `MapMovement`) and confirm.
3. **Expect**: the type appears with the new name in the sidebar tree, in Stream rows, in Summary, and in **Process Explorer** (proof of `labels.ts` integration).

### Test 22 — Persistence across attach
1. Configure entries, click Save.
2. Detach (red badge / "disconnected").
3. Re-attach to the same process → status shows "Disarmed (config: N entries)" — your config survived.

### Test 23 — Anti-flood auto-revert
1. Configure an entry against a class whose method is hot but throws (use a wrong signature on purpose).
2. Start → expect a `network-auto-revert` event after 50 throws/sec, status reverts to disarmed for that entry.
3. Open Configure → that entry is now ❌ stale.
```

- [ ] **Step 4: Verify the smoke test doc renders**

```bash
head -5 SMOKE-TEST.md
```

Expected: starts with the existing first heading.

- [ ] **Step 5: Commit**

```bash
git add app/SMOKE-TEST.md
git commit -m "docs(network): smoke-test scenarios for v1.2"
```

---

## Self-review checklist (run after all tasks complete)

After every task is committed, run this final check yourself:

- [ ] `npx vitest run` — all tests pass.
- [ ] `npm run build:rpc` (root) — agent builds.
- [ ] `npm run build` (app/) — frontend + backend build.
- [ ] `npm start` (app/) — server boots, no crash.
- [ ] Attach to a process, click ⇄ Network → page mounts without console errors.
- [ ] Configure → Save → entries persist on file (`<profile>/plugins/network/storage.json`).
- [ ] Start → frames arrive in Stream when the game emits messages.

---

## Spec coverage check

Each spec section maps to at least one task:

| Spec section | Task |
|---|---|
| TL;DR auto-detect (point 1) | Task 5 (SerializerDetector) |
| Wizard manuel (point 2) | Task 16 (network-config) |
| Hook au sérialiseur (point 3) | Task 10 (agent network-monitor.ts) |
| Page dédiée + sidebar (point 4) | Tasks 17, 18 |
| Vue détail pretty-print A (point 5) | Task 12 (network-detail) |
| Renames via labels.ts (point 6) | Task 12 (callback) + Task 17 (handleRename → api.setLabel) |
| Persistance config / frames volatiles (point 7) | Tasks 4, 7 |
| Architecture vue d'ensemble | Tasks 1-10 (backend), 11-18 (frontend) |
| File layout | Covered by file-by-file task structure |
| Capture pipeline / agent code | Task 10 |
| Data model (NetworkFrame, MessageType, SerializerConfig) | Task 1 |
| Frame store (ring buffer) | Task 2 |
| Routes /api/network | Task 6 |
| WS broadcast (frame-added throttled) | Task 8 |
| UI Stream | Task 13 |
| UI Summary | Task 14 |
| UI Inspector | Task 15 |
| Vue détail (variant A) | Task 12 |
| Wizard config | Task 16 |
| Build-version migration (stale flag) | Tasks 1, 4 (data model + setStale), Task 9 (event-bus auto-revert handler) |
| Error handling | Tasks 6, 9, 10 (each layer handles its errors) |
| Testing pure modules | Tasks 2, 3, 4, 5 |
| Testing routes | Task 6 |
| Smoke test doc | Task 19 |
| Out of scope | N/A — explicitly out |
