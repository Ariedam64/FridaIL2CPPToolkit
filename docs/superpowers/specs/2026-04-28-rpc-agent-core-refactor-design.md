# RPC Agent — Core Extraction & sender.ts Decomposition

**Date** : 2026-04-28
**Status** : draft (awaiting user review)
**Scope** : refactor of `src/rpc-agent/sender.ts` (4827 lines, ~95 exported RPCs) into a layered `core/` + `features/` structure. Primary goal : kill the constant ~500ms freeze that hits Dofus on every RPC call. Secondary goal : navigable codebase.

---

## 1. Intent

The user has been building Dofus tooling on top of the Frida IL2CPP toolkit for several months. `sender.ts` has accreted into a 4827-line file holding ~95 RPCs across autopilot, pathfinder, mapload, packet capture/replay, zaap teleport, introspection — every operation that talks to the Unity main thread.

Two pains drive this refactor:

1. **Every RPC freezes the Dofus game window for ~500ms.** The work runs on the Unity main thread (correct), but each call performs a fresh `Il2Cpp.gc.choose(klass)` heap walk to find a singleton (~100-500ms) and is wrapped in inline `pendingMainWork = () => {...}` boilerplate that bypasses caching. **68 direct `Il2Cpp.gc.choose` calls** vs **5 uses of the existing `getLiveSingleton` helper**.
2. **The file is too big to navigate or extend.** Adding a new RPC means scrolling 4000+ lines to find the right neighborhood ; helpers and feature code intermix ; the dispatch pattern is duplicated 30+ times with subtle variations.

The refactor is constructed to make the perf fix **structurally enforced** — once landed, no contributor (human or Claude) can re-introduce a heap walk or a raw `pendingMainWork` block, because feature modules cannot import the offending APIs directly.

---

## 2. Scope

**In scope :**
- Extract dispatch / singleton / IL2CPP-utils / field-ops infrastructure into `src/rpc-agent/core/`
- Decompose `sender.ts` into `src/rpc-agent/features/{autopilot, pathfinder, mapload, packets, zaap, introspection}.ts`
- Replace all 68 inline `gc.choose` calls with sticky-cached singleton accessors
- Replace all 30+ inline `pendingMainWork` blocks with `runOnMainThread<T>(work)`
- Add a single batched dispatcher that drains the queue per `dtt.tjz` tick
- Pre-warm class index + method table at agent attach (off the main thread)
- Update `index.ts` (Frida agent entry) to import from the new modules ; keep `sender.ts` as a thin re-export layer until all call sites are migrated, then delete

**Explicitly out of scope :**
- `dofus-app/` UI (panels, server, persistence) — separate refactor (B2)
- Python scripts (`dofus-app/scripts/*.py`) — separate refactor (B3)
- Existing modules already extracted from `sender.ts` — `network.ts` (1276 lines), `catalog.ts` (813), `render-geom.ts` (426), `instance-ops.ts` (417), `scanner.ts` (335), `mapstate.ts` (311), `inspector.ts` (131), `screenshot.ts` (123), `search.ts` (131), `watchlist.ts` (92), `explorer.ts` (85), `stacktrace.ts` (52), `registry.ts` (55), `hooks.ts` (54), `rpc-methods.ts` (35), `diff.ts` (24) — they stay as-is. They will adopt the new `core/` helpers opportunistically (e.g. `network.ts` keeps its packet hooks but its `getXyz` reads can move to `core/singletons.ts`), but no forced rewrite.
- The packet-capture/replay RPCs currently in `sender.ts` may either stay in a new `features/packets.ts` OR merge into the existing `network.ts` — decided during implementation, after reading `network.ts` content (see open question §10.1).
- New features. This refactor is purely structural + perf.

---

## 3. File Structure

```
src/rpc-agent/
├── core/                          ← NEW : Frida/IL2CPP infra, zero Dofus logic
│   ├── dispatch.ts                ← runOnMainThread<T>, queue, batching, timeout
│   ├── singletons.ts              ← sticky cache (dtt/MapRenderer/…)
│   ├── il2cpp-utils.ts            ← classIndex, methodTable, resolveFrame, inVm
│   └── field-ops.ts               ← read/write/null on fields & static fields
│
├── features/                      ← NEW : Dofus logic, imports core/
│   ├── autopilot.ts               ← bbd, abort, hooks bbd/tkl, autopilot traces
│   ├── pathfinder.ts              ← foz state, dpgi/CTS, BFS, dumpOutgoingEdges,
│   │                                eli/foz/deiz watchers
│   ├── mapload.ts                 ← loadMapNative, snapshotDtt, neighbors,
│   │                                enterHavreSac, triggerKwd
│   ├── packets.ts                 ← (or merge into network.ts — see §10.1)
│   ├── zaap.ts                    ← zaapTeleport, listKnownZaaps
│   └── introspection.ts           ← describeClass, findClassesWithFieldType,
│                                    callOnLive, callStaticOnClass, resolveAddress
│
├── index.ts                       ← UPDATED : pre-warm + wire feature exports
├── sender.ts                      ← TEMPORARY : thin re-export, deleted at end
│
└── (UNCHANGED)                    network.ts, catalog.ts, render-geom.ts,
                                   inspector.ts, mapstate.ts, scanner.ts,
                                   screenshot.ts, search.ts, hooks.ts,
                                   stacktrace.ts, watchlist.ts, registry.ts,
                                   instance-ops.ts, explorer.ts, diff.ts,
                                   rpc-methods.ts
```

**Dependency rules** (enforced by code review, optionally by lint) :
- `core/*` imports only from `frida-il2cpp-bridge` and other `core/*` files.
- `features/*` imports freely from `core/*`, never from other `features/*` (cross-feature reuse is a sign helpers belong in `core/`).
- **No `Il2Cpp.gc.choose` in `features/*`** — only via `core/singletons.ts`.
- **No `pendingMainWork = ...` in `features/*`** — only via `core/dispatch.ts:runOnMainThread`.
- Feature modules expose only `export function`s ; module-level state (hooks lists, capture buffers) is co-located in the same module that owns the export.

---

## 4. Components

### 4.1 `core/dispatch.ts`

```ts
interface DispatchOptions {
    timeoutMs?: number;   // default 3000
    label?: string;       // for telemetry / error context
}

// Schedules `work` to run on Unity main thread inside dtt.tjz onLeave.
// Resolves with the work's return value, rejects on timeout / dispatcher fail / work throw.
// Concurrent calls are queued ; the dispatcher drains up to N work items per tick.
export function runOnMainThread<T>(
    work: () => T,
    opts?: DispatchOptions,
): Promise<T>;

// Lazy attach. Returns false only when dtt class can't be found.
export function ensureDispatcher(): boolean;

// Telemetry — replaces current getMainThreadDispatcherStats.
export function getDispatcherStats(): {
    attached: boolean;
    fireCount: number;          // # of dtt.tjz onLeave invocations
    workCount: number;          // # of work items executed
    pending: number;            // current queue length
    lastWorkDurationMs: number; // wall time of last drained item
    queueHighWaterMark: number; // max queue length seen
};
```

**Internals :**
- Queue : `Array<{ work, resolve, reject, label, deadline }>`.
- One `Interceptor.attach(dtt.tjz, { onLeave })` for the lifetime of the agent (replaces the existing one).
- Per-tick drain budget : up to **50 ms cumulated**. If exceeded, remaining items wait for the next tick. This caps the worst-case freeze at 50 ms even if 10 RPCs queue in burst — versus today's potential 5×500 ms = 2500 ms cascading freeze.
- Timeout check at drain time : if `Date.now() > deadline`, reject without executing.
- Work errors caught and routed to `reject` ; no leak to console.

### 4.2 `core/singletons.ts`

```ts
// Typed accessors for the well-known Dofus singletons.
// Throws "no live <className>" if first build fails.
export function getDtt(): Il2Cpp.Object;
export function getMapRenderer(): Il2Cpp.Object;
// foz, eli are accessed primarily as classes (static fields like foz.dpgi,
// eli.djzf) — use getClass("foz") + readStaticField. Instance access exists
// (e.g. replaceEliInstance) but is rare ; use the generic getSingleton for those.

// Generic — for less-common classes (cwq, dch, …) used by introspection RPCs.
export function getSingleton(className: string): Il2Cpp.Object;

// Strict variant — re-probes liveness via cached.class.name throw-test.
// Used only by RPCs paranoid about post-reload state.
export function getSingletonChecked(className: string): Il2Cpp.Object;

// Drop the entire cache. Wired on Frida re-attach.
export function invalidateAllSingletons(): void;

// Telemetry.
export function getSingletonStats(): {
    cached: number;             // # of cached entries
    classes: string[];          // their names (debug)
};
```

**Internals :**
- `Map<string, Il2Cpp.Object>` keyed by class name.
- First call : `Il2Cpp.gc.choose(klass)`, take `[length-1]` (matches existing `getLiveSingleton` semantics — last is typically the live one), cache.
- Subsequent calls : pure map lookup. **No liveness probe.** Trust the cache for the entire session.
- Invalidation events : `Script.unload` listener, `Script.reload` listener (when Frida re-attaches) ; plus an explicit RPC `invalidateSingletons()` for manual recovery if a bug appears.
- Dead handles in IL2CPP : if the cached instance is GC'd, reading fields throws. We let that throw propagate — caller gets a clean error with the class name. They retry by calling `invalidateSingletons()` then re-issuing the RPC. This is observed to be **rare** in practice (the user's autopilot doc shows singletons stable for entire sessions).

### 4.3 `core/il2cpp-utils.ts`

```ts
// Class index — currently inline at top of sender.ts.
export function getClass(name: string): Il2Cpp.Class | null;
export function buildClassIndex(): void;       // explicit pre-warm
export function getClassIndexSize(): number;

// Method address table — currently inline at top of sender.ts.
export function buildMethodTable(): number;
export function resolveFrame(frame: NativePointer): string;
export function getMethodTableSize(): number;

// Frida.perform wrapper — currently inline at top of sender.ts.
export function inVm<T>(fn: () => T | Promise<T>): Promise<T>;

// Enum value cache — currently inline at top of sender.ts.
export function getEnumValues(className: string, valueNames: string[]): Il2Cpp.Object[] | null;
```

**Pre-warm policy :** `index.ts` (agent entry) calls `buildClassIndex()` + `buildMethodTable()` **once at attach time**, on the Frida thread (not inside `runOnMainThread`). The cost (~13k classes × method scan ~ 1-2s once) is paid up front — the Unity main thread is never blocked by this build.

### 4.4 `core/field-ops.ts`

```ts
// Generic field accessors used by ~20 RPCs across sender.ts.
// Centralizes the type dispatch (Bool / Int32 / Int64 / Object / string / …).

export function readField(obj: Il2Cpp.Object, name: string): {
    type: string;
    value: string;          // stringified for transport
    raw: any;               // typed raw value if caller wants it
};
export function writeField(obj: Il2Cpp.Object, name: string, value: unknown): void;
export function nullField(obj: Il2Cpp.Object, name: string): void;

export function readStaticField(klass: Il2Cpp.Class, name: string): {
    type: string;
    value: string;
    raw: any;
};
export function writeStaticField(klass: Il2Cpp.Class, name: string, value: unknown): void;
export function nullStaticField(klass: Il2Cpp.Class, name: string): void;

// Walk a chain like "dpgl._state" — read multi-step paths.
export function readFieldPath(obj: Il2Cpp.Object | Il2Cpp.Class, path: string): string;
```

**Migration target** : `nullDttField`, `setIntField`, `probeStaticField`, `probeFozCts`, `writeDeiz`, `writeDpglState`, `nullFozField` all become 5-10 line wrappers in `pathfinder.ts` that delegate to `core/field-ops.ts`.

### 4.5 Feature modules (all follow the same shape)

```ts
// features/autopilot.ts — example
import { runOnMainThread } from "../core/dispatch";
import { getDtt } from "../core/singletons";
import { getClass } from "../core/il2cpp-utils";

export function autoTravelInstant(mapId: number, instantFlag: boolean | null = true) {
    return runOnMainThread(() => {
        const dtt = getDtt();                  // <1ms cached
        const dch = getClass("dch")!.new();
        dch.field("dbkk").value = mapId;
        dch.field("dbkl").value = instantFlag ?? false;
        // ... existing logic, inlined in runOnMainThread body ...
        return { ok: true, targetMapId: mapId };
    }, { label: "autoTravelInstant", timeoutMs: 3000 });
}
```

vs current pattern (one of 30+ duplications) :
```ts
// CURRENT — gone after refactor
export function autoTravelInstant(mapId: number) {
    return inVm(() => new Promise((resolve) => {
        // ... 20 lines of setup ...
        const dttInsts = Il2Cpp.gc.choose(dttKlass);  // 100-500ms freeze
        if (!dttInsts.length) { resolve({ ok: false }); return; }
        // ...
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false }); return; }
        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try { /* work */ settle({ ok: true }); }
            catch (e) { settle({ ok: false, reason: String(e) }); }
        };
        setTimeout(() => settle({ ok: false, reason: "dispatch timeout" }), 3000);
    }));
}
```

The new pattern is **shorter, type-safe, no `gc.choose`, no `pendingMainWork`, no manual `settled` flag, no manual timeout**. All of that is `core/dispatch.ts` boilerplate now.

### 4.6 `index.ts` (agent entry — updated)

```ts
import "frida-il2cpp-bridge";
import { buildClassIndex, buildMethodTable } from "./core/il2cpp-utils";
import { ensureDispatcher } from "./core/dispatch";
import { invalidateAllSingletons } from "./core/singletons";

import * as autopilot from "./features/autopilot";
import * as pathfinder from "./features/pathfinder";
import * as mapload from "./features/mapload";
import * as packets from "./features/packets";
import * as zaap from "./features/zaap";
import * as introspection from "./features/introspection";
// Existing modules — same import style.
import * as network from "./network";
import * as catalog from "./catalog";
// ... other existing modules ...

// Pre-warm at attach. Pays the IL2CPP scan cost once, off the main thread.
Il2Cpp.perform(() => {
    buildClassIndex();
    buildMethodTable();
    ensureDispatcher();
});

// Hook reload events to drop singleton cache.
Script.unload.connect(() => invalidateAllSingletons());

// Wire RPC exports — flat namespace for the bridge / curl callers.
rpc.exports = {
    ...autopilot,
    ...pathfinder,
    ...mapload,
    ...packets,
    ...zaap,
    ...introspection,
    ...network,
    ...catalog,
    // ... other existing modules ...
};
```

---

## 5. Data Flow

### 5.1 Hot-path RPC (e.g. `getDeizState` — read-only)

```
HTTP POST /api/call { method: "getDeizState", args: [] }
  → server.js  routes to bridge.callRpc("getDeizState", [])
  → frida-bridge sends to agent via Frida RPC
  → agent's pathfinder.getDeizState(  ) is invoked
  → returns runOnMainThread(() => { … }, { label: "getDeizState", timeoutMs: 1000 })
    → enqueue { work, resolve, reject, deadline }
    → on next dtt.tjz onLeave (≤16 ms wait at 60fps) :
        - drain queue
        - work() : getDtt() (cached, <1ms) + readField(dtt, "deiy") (<1ms)
        - resolve(value)
    → total main-thread time : <2ms
  → Promise resolves, marshalled back via Frida RPC
  → server returns JSON
  → total wall time : ~20ms typical, no observable game freeze
```

vs today : ~500ms freeze on every call.

### 5.2 Cold-path RPC (e.g. `dumpOutgoingEdges` — heavy)

```
… same up to runOnMainThread …
  → on dtt.tjz onLeave :
      - drain : work() iterates 30k edges → builds JSON
      - takes ~80ms → exceeds 50ms per-tick budget → next item deferred
  → resolve with { adjacency, uidToMapId, vertexCount, edgeCount }
  → next queued item runs on the following tick (16ms later)
```

The expensive RPC still freezes for ~80 ms (its actual work), but **doesn't cascade** — other queued reads aren't held hostage waiting for it. Today, cascading is the worst offender during heavy panels (coverage.ts polls every 250ms).

### 5.3 Concurrent RPC burst (e.g. UI panel mounting fires 5 reads)

```
runOnMainThread(read1) → enqueue
runOnMainThread(read2) → enqueue
runOnMainThread(read3) → enqueue
runOnMainThread(read4) → enqueue
runOnMainThread(read5) → enqueue
  → on next dtt.tjz tick :
      drain all 5, each <2ms → total ~10ms in one frame
  → 5 promises resolve in parallel
  → wall time per request : ~16-32ms (one tick wait + work)
```

vs today : 5 reads × 500ms each, serialized = 2.5s of cascading freezes.

---

## 6. Error Handling

| Failure mode | Behavior |
|--------------|----------|
| `dtt` class not found (game not loaded) | `ensureDispatcher()` returns false ; `runOnMainThread` rejects fast with `dispatcher unavailable` |
| Singleton missing on first build | accessor throws `no live <className>` ; RPC rejects with a clear message |
| Cached singleton GC'd (rare) | field read throws Frida error ; propagates to RPC as-is. User can call `invalidateSingletons()` to recover |
| Work item throws inside `runOnMainThread` | dispatcher catches, rejects the promise with the error (no console spam, no orphan state) |
| Queue timeout (item not drained within `deadline`) | dispatcher rejects with `main-thread dispatch timeout (label=...)` and removes from queue |
| `dtt.tjz` interceptor fails to attach | one-time error logged at attach, `runOnMainThread` always rejects with `dispatcher unavailable` |
| Frida re-attach mid-session | `Script.unload` → `invalidateAllSingletons()` ; subsequent calls rebuild |

**No fallbacks.** Today's `setTimeout(..., 3000)` + `settled` boolean dance is replaced by the dispatcher's deadline-checked drain. If a caller wants a custom timeout, they pass `timeoutMs` ; otherwise the default applies.

---

## 7. Testing Strategy

This codebase has no unit-test infrastructure (nothing to mock — IL2CPP runtime can't be faked). Verification is empirical :

1. **Compile gate** : `tsc --noEmit` on `src/rpc-agent/` clean.
2. **Build gate** : the existing `npm run build` produces a working `build/rpc-agent.js`.
3. **Smoke test** : a small JS script (already exists as `dofus-app/scripts/smoke-coverage.js` shape) runs against an attached Dofus session :
   - Call `getMainThreadDispatcherStats` 10× rapidly → all return <50 ms wall time.
   - Call `snapshotDttState` 5× → no `gc.choose` in the trace, all <50 ms.
   - Call `autoTravelInstant(mapId)` once → walk engages, behavior unchanged from current.
   - Call `dumpOutgoingEdges` once → JSON identical to current output (saved baseline).
   - Manually click in the Dofus window during a burst of reads → no perceptible frame drop.
4. **Migration baseline** : before refactor, capture `dumpOutgoingEdges`, `snapshotDttState`, `getAutopilotTrace` outputs to `tmp/baseline-*.json`. After each phase, re-run and `diff`.
5. **Performance baseline** : before refactor, instrument 5 representative RPCs with `Date.now()` start/end ; record. After refactor, repeat ; expect ≥10× improvement on read RPCs.

---

## 8. Migration Phases

Each phase is an independent, shippable commit. The agent stays functional after every phase.

### Phase 1 — Land `core/` (≈ 1 day)

- Create `core/dispatch.ts`, `core/singletons.ts`, `core/il2cpp-utils.ts`, `core/field-ops.ts`.
- Move the existing helpers from top of `sender.ts` (`buildClassIndex`, `getClass`, `inVm`, `getEnumValues`, `getLiveSingleton`, the `pendingMainWork` machinery, `ensureMainThreadDispatcher`, `scheduleMainThread`) into `core/`.
- `sender.ts` re-imports them from `core/` — no behavior change, just relocation.
- Update `index.ts` to pre-warm `buildClassIndex` + `buildMethodTable` at attach.
- Compile + smoke test.

**Visible effect at end of phase 1** : nothing yet (sender.ts still does inline `gc.choose` everywhere).

### Phase 2 — Wire sticky singletons + `runOnMainThread` everywhere (≈ 1 day)

- Inside `sender.ts`, replace each of the 68 `Il2Cpp.gc.choose(klass)` with the appropriate `getDtt()` / `getMapRenderer()` / `getSingleton(name)`.
- Replace each of the 30+ `pendingMainWork = () => {...}` blocks with `runOnMainThread(work, opts)`. The body becomes synchronous (no `Promise` constructor, no `settled` flag, no `setTimeout`).
- Compile + smoke test after every ~10 replacements.

**Visible effect at end of phase 2** : **the 500ms freeze is gone.** This is the perf win.

### Phase 3 — Decompose `sender.ts` into `features/` (≈ 2-3 days)

For each feature module, in this order :
1. `features/zaap.ts` (smallest, ~100 lines)
2. `features/introspection.ts` (~300 lines)
3. `features/mapload.ts` (~400 lines)
4. `features/packets.ts` (or merge into `network.ts` — see §10.1) (~800 lines)
5. `features/autopilot.ts` (~1000 lines)
6. `features/pathfinder.ts` (~1500 lines)

Process per feature :
- Identify the export functions belonging to the feature.
- Move them + their helpers + their module-level state (hooks lists, capture buffers) to the new file.
- `sender.ts` adds a `export * from "./features/X";` for compat.
- Compile + smoke test.

**Visible effect at end of phase 3** : `sender.ts` is empty (or just re-exports).

### Phase 4 — Drop `sender.ts` (≈ 0.5 day)

- Update `index.ts` to import directly from `features/*`.
- Delete `sender.ts`.
- Update `src/rpc-agent/index.ts` of the agent and `dofus-app/server.js` if any path references remain (none expected — `bridge.callRpc(method, args)` uses RPC names, not paths).
- Final smoke test : full panel walkthrough in the dofus-app UI.

**Total estimate** : ~5-6 days, broken into 4 ship-able commits.

---

## 9. Performance Targets

| Metric | Today | Target after refactor |
|--------|-------|------------------------|
| Trivial RPC wall time (e.g. `getDispatcherStats`) | ~500 ms | <30 ms |
| Read RPC freeze on Dofus window | ~500 ms | <16 ms (one frame) |
| Heavy RPC freeze (e.g. `dumpOutgoingEdges`) | ~500 ms + 80ms = 580 ms | ~80 ms (just the work) |
| Concurrent 5-RPC burst total time | ~2.5 s (cascading) | ~50 ms (batched in one tick) |
| First-call cold start (build indexes) | up to 2 s, blocks first RPC | up to 2 s, paid at attach, no RPC blocked |

These are **estimates**. Phase 2 commit message will record actual measured numbers from the smoke test.

---

## 10. Open Questions

### 10.1 Should packet RPCs merge into `network.ts` or live in `features/packets.ts` ?

`network.ts` is already 1276 lines and owns `installOutgoingHook` infrastructure + low-level packet capture. `sender.ts` has the higher-level packet ops : `sendFakeIri`, `sendFakeIsu`, `sendFakeIsp`, `sendFakeJmw`, `armCaptureIri`, `armCaptureSequence`, `inspectIriPath`, `replayIriWithExtra`, `executeFakeTransition`, `replayCapturedIri`, etc.

Decision deferred to Phase 3 : if `network.ts` accepts these ops without exceeding ~2000 lines, merge there. Otherwise create `features/packets.ts` and leave `network.ts` for the low-level hook plumbing.

### 10.2 Singleton invalidation event for game logout

`Script.unload` covers Frida re-attach, but if the user logs out of Dofus mid-session the cached singletons become dead handles. We'll catch the throw and surface a clear error, but a proactive invalidation hook would be cleaner.

Candidate trigger : hook a known logout method (TBD — needs a session of investigation). Deferred. Acceptable workaround for now : RPC `invalidateSingletons()` exposed for manual call.

### 10.3 Strict-liveness opt-in per RPC

The default is "trust the cache forever". Some RPCs may want to verify (e.g. after a long idle). Provide `getSingletonChecked(name)` as opt-in ; flag in code review which RPCs adopt it. No automatic policy.

### 10.4 Dispatch queue capacity & overflow policy

The queue is unbounded. If an RPC hangs (work() doesn't return), backpressure builds. Mitigation : per-item `deadline` rejects stale items at drain time. We may add a hard cap (e.g. 100 items) with `reject('queue overflow')` later if needed. Not required for v1.

### 10.5 Will `core/dispatch.ts` interact with the existing `network.ts` interceptor on `ecu.xbe` ?

`network.ts` has its own `Interceptor.attach` for the outgoing-packet hook. Different attach point, different callback — no conflict expected. Both run on the IL2CPP main thread, both should be quick. Confirm during phase 1 smoke test.

---

## 11. Non-goals & Deferred Items

- **Background-thread reads (Frida thread, no main-thread dispatch).** The frida-il2cpp-bridge docs suggest some IL2CPP reads can run off the main thread once attached. This is risky (GC moves, type-marshal pitfalls) and the sticky singleton + per-tick batching gets us close to the target without it. Deferred to a follow-up if measurements show queueing delays exceed 50 ms typical.
- **Typed RPC declaration framework (Approach 3 from brainstorm).** Over-engineered for one user. Revisit if a third contributor shows up.
- **dofus-app UI / panel cleanup.** Separate refactor (B2).
- **Python script consolidation.** Separate refactor (B3).
- **Hot reload of agent without re-attach.** Out of scope.

---

## 12. Glossary

| Term | Meaning |
|------|---------|
| `dtt.tjz` | Dofus class `dtt` method `tjz` — a bool getter Unity polls every frame. We hook its `onLeave` as the main-thread tick. |
| `pendingMainWork` | Existing module-level slot in `sender.ts` holding the next callback to execute on Unity main thread. **Replaced** by an internal queue in `core/dispatch.ts`. |
| `gc.choose(klass)` | `Il2Cpp.gc.choose` — walks the IL2CPP heap, returns all live instances of `klass`. ~100-500 ms. **Eliminated** from feature code by sticky singleton cache. |
| Sticky cache | Cache that never invalidates implicitly. Entries live for the entire Frida session unless explicit `invalidate()` is called. Trades correctness in rare GC-eviction edge cases for a >10× perf win on the hot path. |
| `inVm` | Wrapper around `Il2Cpp.perform` that ensures the calling thread is attached to the IL2CPP runtime. Required for any IL2CPP API call. |
