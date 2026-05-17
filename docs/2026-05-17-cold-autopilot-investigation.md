# Dofus Native Auto-Travel Cold-Fresh Investigation

**Date:** 2026-05-17
**Branch:** `feat/v1.5-dofus-map`
**Status:** Closed — accepted limitation, restored tkw+wbi fallback with field-set fix
for tkw. Warm sessions clean; cold-fresh requires 1 manual minimap double-click as
session warm-up before far-map autopilots work.

## Problem

The native auto-travel forge (`startNativeAutoTravel`) calls `dtw.tkw(dck)` to
replicate a worldmap double-click. It works **warm** (after the player has
already done at least one manual auto-travel in the session) but fails **cold-
fresh** (first action after Dofus restart) with a generic Frida "system error"
and the character does not move.

The user's pragmatic constraint: 1 manual click after Dofus restart fully warms
the state, after which our forge works cleanly. We want to remove that manual
warmup requirement.

## Timeline of attempts

### 1. `.ctor` → field-set fix on `dck` *(committed in cleanup attempt)*

**Observation:** previously the forge built the `dck` (`AutoTravelRequest`)
struct via `req.method(".ctor").invoke(Int64, true)`. That signature doesn't
exist on `dck` — the class has only a parameterless ctor. Result: `dck.dbpf`
and `dck.dbpg` stayed at 0/false → `tkw` later dereferenced a null mapId and
crashed.

**Fix:** allocate via `dckK.new()` then assign fields directly:

```ts
req.field(proto.fields.AutoTravelRequest_destMapId).value = new Int64(destMapId.toString());
req.field(proto.fields.AutoTravelRequest_skipConfirmation).value = true;
```

**Verified:** captured a real manual minimap double-click via the tkw hook,
saw `dck.dbpf=126091546` and `dck.dbpg=true` set directly — confirms no
parametric ctor.

**Result:** warm sessions now work cleanly. Cold-fresh still throws system
error (different root cause, see next).

### 2. Cold-fresh state diff: `<dent>k__BackingField`

Dumped `dtw` (`AutoTravelUiController`) instance state cold-fresh vs after
1 manual auto-travel. Snap1 vs snap2 diff shows 8 fields changing:

| Field | Cold | Post-manual |
|-------|------|-------------|
| `<dent>k__BackingField` (bool) | false | **true** |
| `deoi` `MapsInformationDataRoot` | null | populated |
| `deoj` `MapInformationData` | null | populated |
| `deok` `List<Edge>` | null | populated |
| `deol` Int32 | 0 | 4 |
| `deom` (class `gay` cold / `cnw` post — state machine?) | null | populated |
| `deoo` (static, class `eba`) | non-null A | non-null B (reassigned) |
| `deoq`, `deor` (`dzo`, source/dest vertex?) | null | populated |

`<dent>` is a C# auto-property backing field — looks like an "init done" flag.

**Attempted fix:** force `<dent>=true` before forging tkw.

**Result:** `tkw` no longer throws system error, BUT travel is **partial** —
character walks 1 map (the pre-loaded neighbor) then stops. Forcing the flag
true bypasses the actual init code, so `deoi/deoj/deom/...` stay null and the
state machine can't continue past the first hop.

### 3. `tlb` direct (skip tkw)

The backtrace from a manual click showed the chain `tkw → tlb → bapc`.
`tlb(Int64 destMapId, Boolean skip)` takes the same args we extract from `dck`.
Hypothesis: tkw is just a thin wrapper around tlb that does the validation,
so calling tlb directly bypasses whatever check fails cold.

**Result:** `tlb` direct **also** throws "system error" cold-fresh. The crash
is not specific to tkw — it's upstream init.

### 4. Brute-force no-arg dtw methods

Invoked every no-arg `dtw` method (`it`, `tkv`, `tlm`, `tlv`, `tlw`, `tls`,
`tma`, `tmb`, `dnj`, `edm`, `krz`, `loz`, `jtm`, `tln`, `hzo`, `ilv`, `tlk`,
`tlu`, `tlg`) trying to find one that flips `<dent>=true`.

**Result:** none of them flip `<dent>`. Either they don't do the init, or
they crash cold (several returned "system error"). The init is **not** a
self-contained no-arg method on dtw.

### 5. Full method trace on dtw + manual minimap click

Installed `Interceptor.attach` on **every** dtw method (with `tkt` blacklisted
— it's a per-frame predicate that spams). User did 1 manual minimap double-
click cold-fresh. Captured trace:

```
dtw..ctor(0 args)      ← at Dofus startup, not relevant
---  click at t=68959  ---
dtw.tla(1 arg)         ← takes `dcl` (click event)
dtw.lii(1 arg)         ← takes `dcl`
dtw.tle(1 arg)         ← takes Int64 destMapId
dtw.tln(0 args)
dtw.tlp(2 args)        ← takes (Int64 destMapId, Int32 cellId)
dtw.tlu(0 args)
```

**Critical finding:** the minimap click cold-fresh chain is
`tla → lii → tle → tln → tlp → tlu`. **`tkw` and `tlb` are NOT in this path.**
Two different manual entry points exist on dtw — `tkw(dck)` and `tla(dcl)`.
We've been forging via the wrong one for cold-fresh.

### 6. Inner chain forge (tle → tln → tlp → tlu)

Replaced the tkw forge with calling the inner chain directly, skipping
`tla/lii` (they need a `dcl` event we don't have):

```ts
c.method("tle").invoke(new Int64(destMapId.toString()));
c.method("tln").invoke();
c.method("tlp").invoke(new Int64(destMapId.toString()), 0);
c.method("tlu").invoke();
```

**Result:** non-deterministic.
- Run 1: `forge ok` — but character doesn't move
- Run 2: `forge ok: false, reason: system error` — same code, same setup

The race-condition smell: same code, different result across Dofus restarts.
Cold Dofus loads async (scenes, services, UniTask scheduler) — the state when
we attach varies depending on how loaded Dofus is by the time we call.

### 7. User hypothesis: UniTask SyncContext

The user theorizes: tla/tle/etc. are called normally from Unity's UI input
thread, which has the correct `SynchronizationContext` for UniTask
continuations. Our forge dispatches via `MapRenderer.Update.onLeave` —
Unity main thread but not the input-event context. UniTask continuations
enqueued by these methods may never fire because the scheduler context
isn't right.

This matches the "ok at call site but state machine doesn't progress"
observation.

## Current state of code

- `startNativeAutoTravel` currently calls the inner chain
  `tle → tln → tlp → tlu`. Non-deterministic cold-fresh.
- TEMP debug functions installed:
  - `dumpDtwState` (instance + statics snapshot)
  - `dumpDtwMethods` (full method dump)
  - `invokeDtwMethod` (single-method probe)
  - `forceWarmDtw` (set `<dent>=true`)
  - `installTkwDebug` (Interceptor on tkw with args + backtrace)
  - `installDtwTrace` (Interceptor on every dtw method, `tkt` blacklisted)
- TEMP routes mirror each.

## Hypotheses still open

1. **`dcl` event needed.** `tla` and `lii` take a `dcl` instance. If we can
   construct one with the click info (mapId, position, etc.) and invoke
   `tla(dcl)`, we replicate the exact manual entry. This is the next attempt
   the user requested.

2. **UniTask context wrong.** Even if we replicate the chain perfectly, our
   `MapRenderer.Update.onLeave` dispatcher may not provide the
   `SynchronizationContext` UniTask continuations need. Worth trying a
   different Unity Update hook (e.g. `UIToolkitInputModule.Update`).

3. **Cold race with Dofus loading.** Some service in dtw's dependency graph
   may not be fully constructed by the time we attach. Could detect by polling
   field values and waiting until all key refs are non-null before forging.

## Next: forge a `dcl` event

The user wants to try option 1: dump the `dcl` class, construct an instance
with reasonable defaults (destMapId, maybe a position), invoke `tla(dcl)`,
observe.

If `dcl` is small (a struct with mapId + maybe position), this is direct.
If it's a complex object with many service refs, may need to set just the
mapId field and hope tla validates the minimum.

### 8. dcl forge attempt

`dcl` (arg type of `tla`/`lii`) turned out to be tiny: 1 field `dbph: Int64`
(destMapId) and a `.ctor(Int64)`. We built one, set `dbph`, called
`dtw.tla(dcl)` cold-fresh.

**Result:** non-deterministic — across multiple Dofus restarts, same code
gave `ok` once and `system error` another time. Both times the character
didn't move. Same UniTask-context problem as section 6.

## Final decision

We've invested significant time. Cold-fresh deterministic forge requires
fixing the UniTask `SynchronizationContext` plumbing — a deep Unity/UniTask
investigation that's out of scope.

**Resolution:** restored the tkw + wbi fallback architecture of the prior
commit `f7b5d9ef`, with the field-set fix for `dck` so the tkw path is now
clean warm. Cold-fresh limitation documented: 1 manual minimap double-click
as session warm-up unlocks the autopilot for the rest of the session.

### Behavior matrix

| Session state | tkw forge | wbi fallback | Result |
|---|---|---|---|
| Warm (post-manual or post-forge in session) | ok | n/a (skipped) | Travel works fully |
| Cold-fresh, near map (≤1 hop) | system error | wbi ok | Travel works |
| Cold-fresh, far map | system error | wbi ok (call returns) | Travel does not start — chat error "no map accessible" |

### Workaround for users

Tell users: after restarting Dofus, do one manual minimap double-click on a
nearby map (or any worldmap pin) before using the autopilot. That warms up
the dtw state machine, after which all autopilot calls work normally.

### Reverted TEMP debug

All TEMP routes and agent functions added during the investigation
(`dumpDclClass`, `dumpDtwState`, `dumpDtwMethods`, `invokeDtwMethod`,
`forceWarmDtw`, `installTkwDebug`, `installDtwTrace` and their routes) were
removed when the resolution was reached. The doc itself is the artifact left
behind so a future investigation can pick up where this one stopped.

### What's worth trying next, if anyone wants to take this up

1. **Match the `SynchronizationContext` of Unity input dispatch.** UniTask
   reads `SynchronizationContext.Current` at enqueue time. Find which
   field/object holds the Unity scheduler context and set it on our thread
   before invoking tkw/tla.
2. **Hook deeper.** Replace our `MapRenderer.Update.onLeave` dispatcher with
   a hook on `UIToolkitInputModule.Update` or `EventSystem.Update` — the
   Updates that actually drive Unity UI input dispatch. UniTask continuations
   enqueued from inside those callbacks see the right context.
3. **Find a "session ready" signal.** Some service in dtw's dependency graph
   is only fully constructed by the time the player has interacted with the
   UI once. If we can detect that signal (e.g., a static field flipping, or
   a specific service becoming non-null) and gate our forge on it, we delay
   automatically.
