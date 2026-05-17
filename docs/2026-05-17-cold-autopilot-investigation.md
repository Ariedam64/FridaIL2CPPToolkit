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

---

## Update 2026-05-17 (afternoon) — region-scoped warm-up, not binary

After more empirical testing, the "1 manual click warms the whole session"
model is wrong. The warm-up is **region-scoped**: a manual travel only
unlocks native forges to destinations within the radius (or pre-loaded
worldmap chunk?) of that manual travel.

### Observed sequence

1. Cold-fresh Dofus.
2. Manual travel to a **nearby** map (e.g., 1-2 hops).
3. Native forge to a **far** map → fails with the in-game chat error:
   > Impossible de lancer un voyage automatique : il n'existe aucune carte
   > accessible à la position souhaitée.
4. Manual travel to a **farther** destination than step 2.
5. Native forge to the same far map as step 3 → **works**.

So the warmth a manual travel provides scales with the manual travel's
distance — or more precisely, with the worldmap region the manual travel
forced the client to load.

### Hypothesis

The wbi fallback's viewport validation rejects Vector2(0,0) for maps that
aren't in the currently-loaded worldmap region. Manual travels expand this
loaded region. The chat message above is empirically the wbi rejection
path (matches the "aucune carte accessible à la position souhaitée"
fingerprint noted earlier in this doc).

But there's likely a similar region constraint on tkw: even after a manual
travel, our tkw forge to a far map still fails warm (we'd otherwise never
hit the wbi fallback and never see this error). So both paths share some
"loaded-region" gate that's keyed on the manual travel's scope.

### Where the chat message comes from — not yet traced

The string "Impossible de lancer un voyage automatique : il n'existe aucune
carte accessible à la position souhaitée." is in Dofus's localization
bundle (Unity-side, not in any of our static data). To find the exact
emission site, three tractable approaches:

- **Hook the chat dispatch.** The message goes through the in-game chat —
  hook whichever method writes a system message to the chat scrollback and
  log the stack frames whenever the string matches. The frame just above
  the dispatch will be the rejection site.
- **Hook the i18n lookup.** Find the localization function (look for
  methods on a class like `LocalizationService` / `Translator` / `I18n` in
  the dump — single arg `string key`, returns `string`) and log calls
  whose result contains "voyage automatique". The key string identifies
  the call site.
- **Stack-trace tkw / wbi return paths.** Both paths return without
  invoking the path-compute when the region check fails. Adding an `onLeave`
  hook on tkw and wbi that captures the return value + a backtrace whenever
  the result is the rejection branch should isolate the validator.

The chat-dispatch approach is the cheapest (single hook, no need to
identify the i18n function or guess the validator method).

### Implications for the autopilot

The previous workaround ("1 manual click warms the session") is incomplete.
A more honest workaround until the validator is bypassed:
- Do a manual travel **at least as far** as your intended native destination
  before launching the native forge.
- Or fall back to our custom orchestrator (non-native) for any travel
  beyond the manual warm-up's reach.

### Runtime instrumentation attempt (chat-dispatch hunt)

Tried to trace where the chat message originates by hooking every string-arg
method on every candidate class. Added TEMP RPC functions
`installStringSubstringTrace` and `installChatDispatchTrace` to the agent
(`src/rpc-agent/plugins/dofus/actions/world-pathfinding.ts`) + 2 routes
in the plugin (`/install-string-trace`, `/install-chat-dispatch-trace`).

**Classes hooked, none caught the message:**
- `ChatMessageHistory.Add` / `ResetIndexIfNeeded`
- `ChatView.AddNewMessage` + 6 other string-arg methods
- `ChatTab` (no string-arg methods)
- `ChatMessage.bkwi` (content setter) — fires hundreds of times but with
  bogus arg pointers (`0x11716`, `0x1174e`, `0x11792`) → "access violation
  accessing 0x11716". `bkwi` is likely virtual/interface-dispatched and
  Frida's `Interceptor` catches a trampoline stub, not the real impl.
- `ChatMessage..ctor` — never fires (chat messages are pooled, not freshly
  built per emission)
- `gqz.bkvv(ChatMessage)` — the chat-service interface dispatch (discovered
  via `ChatChannelCounter.m_chatService` field type). Doesn't fire either.
  Confirmed `gqz` is an interface (0 fields). `listSubclasses("gqz")`
  returned empty — couldn't find the concrete impl class. The
  `Core.Services.ChatService.AnkamaChatService.Protocol.*` classes in the
  namespace are gRPC server-protocol commands, not the client-side service.
- `grs.{dvf, Add, kqq}(string)` and `grt.{gyx, hrh, bkzh, jxw}(string, string)`
  — providers returned by `gqz.bkvk()` / `gqz.bkvm()`. Take string messages,
  but never fire for the wbi rejection either.

Filters tried (case-sensitive substring match on string args): `voyage`,
`Impossible`, `carte`, `automatique`, `auto`, `ui.`, `autoTravel`. None hit.

**Conclusion:** the rejection message is dispatched through a path we
didn't reach with substring-on-string-arg tracing. Possibilities:
1. **UI-direct write.** Maybe the chat scrollback receives the message via
   a direct `Label.text = "..."` or `VisualElement` text set. Hooking
   `UnityEngine.UIElements.TextField` or `TMP_Text.text` would catch it,
   but those fire constantly across the whole UI and tracing them is
   prohibitive without a tight filter.
2. **StringBuilder/concat dispatch.** The text is assembled piecewise via
   `StringBuilder.Append` chains, so no single string-arg call ever contains
   the full substring. The fully-assembled string only exists transiently
   inside the formatter.
3. **Notification/popup system separate from chat.** Dofus may have a
   "toast"/"info-popup" pipeline that mirrors into the chat scrollback as a
   side effect. The primary dispatch wouldn't be a chat method.

### What to try next, if anyone picks this up

- **Decompile offline.** The strings won't be in the .cs files (the
  AssetRipper export's TextAssets are binary). But running `dnSpy` / `ilSpy`
  on the assembly DLLs in `dofus-app/data/external/assetripper-export/
  Assemblies/Core.dll` (etc.) might reveal the validator call site if the
  binary still embeds the i18n key. Pattern to grep: any method on the
  AutoTravel namespace that calls a `Translate(...)`/`I18n.get(...)` with a
  key like `ui.autoTravel.error.*` or similar.
- **Skip the dispatch hunt, patch the validator instead.** The viewport
  validation in `wbi` is likely a single `if (viewport.contains(pos))`
  check. If we identify the validating predicate (early-return path in
  `eaw.wbi`) and either patch it to always return true or pass a Vector2
  that always passes, we bypass the rejection without needing to know what
  chat method emits the error. Approach: hook `wbi` with `onLeave`, observe
  return value, then walk it back to its predecessor branches via
  `Stalker.follow`. Heavy but conclusive.
- **Live-set the worldmap viewport.** `eaw` has 111 fields; some hold the
  loaded-region state (likely `dgkv` Dictionary<eba,bool> or one of the
  Vector2 / Double fields named `dgkw/dgkx/dgky/dgkz`). Identifying which
  one represents the "loaded region" and force-expanding it would let wbi
  accept any (0,0) for any map. Investigation requires field-shadowing
  during a manual travel sequence to spot which field changes scope.

### Files left in place

- `src/rpc-agent/plugins/dofus/actions/world-pathfinding.ts` — keeps
  `installStringSubstringTrace` and `installChatDispatchTrace` for any
  future investigator. Both are inert until called via the routes below.
- `app/plugins/dofus/routes/index.ts` — `/install-string-trace` and
  `/install-chat-dispatch-trace` POST routes.

### Offline decompilation attempt — also a wall

Scanned all 143 DLLs in `dofus-app/data/external/assetripper-export/Assemblies/`
(Core.dll = 6 MB, Core.Localization.dll = 660 KB, etc.) for:
- The literal French message ("voyage automatique", "Impossible de lancer",
  "aucune carte accessible") — UTF-8 and UTF-16 encodings.
- Common i18n key patterns (`ui.X.Y.Z`, `ui.*.error.*`).
- File path debug strings referring to `*Travel*.cs`.

**All scans returned zero hits.** The Dofus 3 localization system likely
uses:
- Numeric hash IDs (Unity Localization package style) instead of string
  keys in the code. The code reads `Localize(0x1234abcd)` rather than
  `Localize("ui.autoTravel.error.noAccessible")`.
- Binary tables stored in the unreadable Unity TextAssets in
  `Assets/TextAsset/UnreadableTextAsset_*.json` (which are stub wrappers —
  the real data is in the corresponding `.bundle` files in
  `dofus-app/data/external/dofus-app` outside the assetripper export).

Without decoding those binary tables, the literal French string cannot be
mapped back to a code site through static analysis.

### Final state — accepting the limit

We've exhausted reasonable investigation budget. The cold-fresh + region-
scoped limitation is documented; the autopilot remains usable with the
workaround (manual travel ≥ intended native destination distance).

If a future maintainer wants to take this up again, the most promising
remaining angle is **bypass via viewport patching, not dispatch tracing**:
identify which `eaw` field holds the worldmap-loaded-region state (via
field-shadowing during a manual travel sequence), then force-set it from
the agent before invoking wbi. This sidesteps the question of where the
chat error comes from entirely.

---

## Resolution (later that afternoon) — path injection

A different bypass turned out to work: we don't fix the validator and don't
trace the chat dispatch. We just **skip the compute step entirely**.

### The insight

The auto-travel pipeline is `tkw → bapj → walker`. The viewport rejection
lives in **bapj** (the path-compute). The **walker** that follows is happy
to consume any `List<Edge>` you hand it — it doesn't re-validate.

So:

1. Host computes the path via its own JS A* over the cached world graph
   (`app/plugins/dofus/lib/movement/world-path.ts`). Pure topology, no
   viewport check.
2. Agent allocates IL2CPP `Edge`/`Vertex` objects from the JSON path
   (`Vertex.ctor(long mapId, int zoneId, ulong uid)` +
   `Edge.ctor(Vertex, Vertex)` + `Edge.bgux(...)` per transition, into a
   freshly-allocated `List<Edge>`).
3. Agent writes the list into `worker.resultEdges`, calls `tkw(dck)` for
   the side-effect of subscribing the walker to the result event (its
   later bapj throw is caught and ignored), then fires
   `WorldPathfindingWorker.deliverResult(list, true)`.
4. The walker receives the forged list and walks. All transitions (isa per
   cell, ito for map changes, iev for doors/zaaps, client-desync recovery)
   are handled natively by the game — we don't need to forge any of them.

This works **cold-fresh, any distance, no warm-up required**. The viewport
check never runs against our destination.

### Implementation

Single agent function `startAutoTravel(proto, destMapId, edgesJson)` in
`src/rpc-agent/plugins/dofus/actions/world-pathfinding.ts`. The path types
(`Edge`, `Vertex`) are clear-named in
`Core.PathFinding.WorldPathfinding.*`. The transition-builder
`Edge.bgux(pn dir, int type, int skillId, string criterion, long transMapId,
int cellId, long id)` saves us from resolving the generic
`List<Transition>` concrete class — it constructs and appends a Transition
in one call.

The only obfuscated bits that needed labelling (now all in
`WORLD_PATHFINDING_PROTO`, so the migration engine re-keys them after obf
rotations): `fpc/dpln/nwf` (worker + result list + deliver method),
`dtw/tkw/dck` (UI controller + start + request struct), `bgux` (Edge add-
transition), `bapg/bgul/gmj` (PathFindingData loader + setters), plus the
clear-named `Edge`, `Vertex`, `WorldPathfinder`, `MapRenderer`.

### Refactor — the autopilot is now just this

Once path injection worked reliably, the entire previous autopilot stack
got removed:

- `app/plugins/dofus/lib/movement/autopilot.ts` (TravelOrchestrator) —
  deleted. Was forging `isa` per-edge + `ito` per-map-change manually.
- `app/plugins/dofus/lib/movement/basic-ping.ts` — deleted. Was only used
  for orchestrator keepalive.
- `app/plugins/dofus/lib/interactives/npc-dialog.ts` — deleted. Was only
  used for the orchestrator's transit-NPC fallback (the native walker
  handles NPCs internally).
- Old `startNativeAutoTravel` (tkw + wbi fallback) — deleted from the agent.
- TEMP dispatch tracers (`installStringSubstringTrace`,
  `installChatDispatchTrace`) and bapc/nwf observation hooks — deleted.
- `/api/dofus/travel/cancel` + `/api/dofus/travel/status` endpoints —
  deleted. No status polling: the user observes the walk in-game; to
  interrupt, manually move the character.
- UI: dropped `fast`/`native`/`custom` checkboxes. The autopilot panel is
  now just `mapId input + Go button + last-response message`.

Slimmed `WORLD_PATHFINDING_PROTO`: dropped `AutoTravelManager`,
`WorldmapController`, `Transition`, all `AutoTravelManager_*` /
`AutoTravelRequest_*` field entries, `WorldPathfinder` field accessors
(worker/startVertex/destMapId/state), `bapc`/`bapj`/`wbi` methods. What
remains is exactly what the path injection touches.
