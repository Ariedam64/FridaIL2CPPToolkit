# Autopilot — investigation log & open hypotheses

Living doc tracking the deep-dive on why our agent-driven autopilot misbehaves
on certain targets. **Read** `dofus-reverse-engineering.md` §4 first for the
canonical autopilot architecture; this doc focuses on the still-unexplained
behaviors.

Last updated: 2026-04-26.

---

## TL;DR — current state of knowledge

| Fact | Confidence | Evidence |
|------|-----------|----------|
| Agent's `dtt.bbd(dch)` calls bypass our `m.implementation` hooks | ★★★ | hookAutopilot returns 0 hits when triggered from agent; full chain visible when triggered from UI |
| Agent's bbd via `NativeFunction(virtualAddress)` ALSO bypasses hooks | ★★★ | Tested, 0 hits |
| Both agent paths CAN engage autopilot (deiy=true) for short-distance targets | ★★★ | 1-hop neighbors work reliably from any position |
| Some far targets (e.g. 88081176 Village d'Amakna) consistently fail (deiy=false) from certain positions even on first try | ★★★ | 3 trials, all fail, no prior bbd to "poison" state |
| The same target may succeed when triggered from in-game UI from the same position | ★★ | User report — needs verification with controlled position |
| "system error" return from bbd is a Frida marshaling artifact, not the actual game state | ★★★ | Player moves anyway, deiy reflects truth, dejp gets populated |

**The mystery**: why does agent-triggered bbd reject some targets that UI-triggered bbd accepts?

---

## The problem in one paragraph

When the coverage-plan orchestrator calls `dtt.bbd(dch{mapId, true})` via Frida,
the call returns (often with cosmetic "system error"), but in many cases
`<deiy>k__BackingField` stays `false` afterwards — meaning the autopilot never
engaged. Our orchestrator correctly classifies this as "unreachable" and skips.
However, the user can sometimes manually click the same target in-game and it
DOES engage — suggesting the pathfinder CAN find a path, but our agent's call
path doesn't trigger that path-finding correctly. After many such fails, the
orchestrator hits its auto-reload threshold which causes Dofus to disconnect.

---

## What we've tried

### 1. Distinguishing "system error" types

`dtt.bbd` throws "system error" cosmetically on its return path almost every time
when called via `method.invoke`. Confirmed:
- Player moves anyway → IL2CPP method completed its work
- Frida bridge marshals the Boolean return badly (artifact of `il2cpp_runtime_invoke`)

Hooked the bbd return via `Interceptor.attach(virtualAddress)` → 0 hits. Confirmed
that Frida's invoke path bypasses the JIT-entry interceptor.

Switched to `m.implementation = wrapper` → STILL 0 hits when called from agent.
Works fine for game-triggered bbd (UI clicks).

### 2. NativeFunction approach (rejected)

Built `autoTravelInstantNative` that calls bbd via `NativeFunction(bbd.virtualAddress, 'uint8', ['pointer','pointer','pointer'], 'win64')`
to skip Frida's invoke wrapper. Result:
- Successful for short-distance targets (1-2 hop neighbors): `returnValue=1`, `deiy=true` ✓
- Same "system error" cosmetic for some calls
- Same "unreachable" rejection for the SAME targets that fail via method.invoke

→ NativeFunction does NOT change the engage/reject behavior. The reject is real.

### 3. Forced `dtt.fob(dck)` between bbds

Hypothesis: residual elg/foz state from a previous failed bbd poisons subsequent ones.

Tested: bbd(unreachable) → forced abort via `fob(dck)` → bbd(known-failing-target).
Result: Still rejected. Forced abort doesn't unstick the path solver.

### 4. Time delay between bbds

Tested: bbd(unreachable) → wait 1.5s, 3s, 5s, 10s → bbd(known-failing-target).
Result: All trials fail. Time alone doesn't heal the rejection.

### 5. Three-trial controlled test

```
Trial 1: bbd(88081176) directly from 188743683
  → "system error" + deiy=false at all observation points (1s, 3s, 5s)
Trial 2: same → same result
Trial 3: same → same result
```

Three independent trials all reject the same target. **There is no "poison" — the
target is genuinely unreachable from this position via OUR call path.**

### 6. Orchestrator-side workarounds (deployed)

- `runOneAutoTravel` arms the WS sync barrier BEFORE bbd (avoids race on tkl event)
- 1.5s deiy probe after bbd to detect engage vs reject
- `abortAutoTravel()` (= `dtt.fob(dck)`) called between maps when the autopilot got stuck
- Auto-reload threshold raised from 3 → 10 (still triggered Dofus disconnect on plans with too many unreachable targets)

---

## Open hypotheses (ranked by plausibility)

### H1 — Agent path skips a critical pre-pathfinder init step  (★★★)

**Theory**: In the UI's full bbd trace we see ~22 method calls BEFORE the pathfinder
solve (`elg.baoh()`, `elg.baoj()`, `elg.baok()`, `foz.bgtt()`, `eli.baot/baos`,
`dtt.cwi()`, `dtt.tlc()`, `dtt.tkm()`, etc). Our agent bbd executes ZERO of these
through our hooks (0 trace hits) — but `dejo` DOES get set. So tkh runs
natively but the inner chain might short-circuit at some step.

If the agent's bbd skips one of those early init methods (e.g. `elg.baok()`
which seems to set up the worldmap graph), the pathfinder later runs with stale
inputs → no path found → reject.

**Test idea**: install hookAutopilot, call bbd via `NativeFunction` from inside
ANOTHER hooked method. If the call comes from inside a hook callback, the inner
methods MIGHT now go through hook entries (we'd see them in the trace).

**Action**: build a "trampoline RPC" that hooks a high-frequency method and,
on its onLeave, calls bbd from there.

### H2 — Pathfinder uses thread-local state that's not set up on Frida threads  (★★★)

**Theory**: foz.bgtq and the worldmap solver might use thread-local Unity context
(e.g. job system schedulers, frame allocators). Our agent's `pendingMainWork`
runs inside an Interceptor.onLeave callback on dtt.tjz — which IS on the Unity
main thread, but might not have all the Unity Update-loop context active that
the UI's call has.

**Test idea**: instead of Interceptor.attach(tjz) for main-thread dispatch,
hook a different Unity-loop method (Update, FixedUpdate, LateUpdate) and
schedule there.

### H3 — Pathfinder caches "no path" results and refreshes on map-change  (★★)

**Theory**: foz solver has a cache. First bbd from agent fails (for whatever
reason), result cached as "no path". Subsequent attempts hit cache → also
reject. UI-triggered bbd uses a different code path that bypasses cache OR
forces a re-solve.

**Counter-evidence**: trial 1 from clean state also fails. So either the cache
is populated at game startup, or this isn't the cause.

**Test idea**: force a foz cache invalidation. Methods like `foz.bgtw()` or
`foz.bgtv()` were excluded from hookAutopilot — maybe one of these is "clear
cache".

### H4 — Player position state has TWO sources, agent reads one, UI reads other  (★★)

**Theory**: pathfinder needs the player's "current vertex" as starting point.
There might be two sources:
- `MapRenderer.cywa` (the simple currentMapId we read)
- Some `gav` instance on dtt or elsewhere with richer position info (cell, sub-area, navigation context)

Agent's bbd reads cywa-only path → uses simple coords. UI's bbd reads the
richer path → uses navigation context that includes "I just arrived from
direction X via map Y" which helps pathfinder.

**Test idea**: snapshot ALL dtt fields BEFORE agent bbd vs BEFORE UI bbd
(triggered with hookAutopilot active). Compare.

### H5 — Server desync that recovers on map-change  (★)

**Theory**: our agent's bbd somehow makes the server think the player is
in a "computing path" state. Server then ignores subsequent move requests
until the player physically moves to a new map.

**Counter-evidence**: walking to a new map should trigger a server packet.
But if server still thinks we're "computing", it should reject the walk too.
Yet user can walk normally after our failed bbds.

**Test idea**: monitor server packets via `startIncomingCapture` during the
bbd cycle — see if there's a "rejected" or "wait" message we're missing.

### H6 — Specific maps are in unreachable sub-graph regardless of caller  (★★)

**Theory**: maybe (2,-1) Village d'Amakna IS truly unreachable from
(1,-19) Forêt d'Astrub via continuous walking — no continuous path exists in
the worldmap graph because of water/mountains. UI succeeds because it uses
**zaaps** automatically when needed; our agent's `instant=true` flag might
disable zaap usage.

**Test idea**: inspect `dch.dbkl` (the bool we set to true) — what does it
actually do? Maybe `false` means "use zaaps if needed", `true` means "walking
only".

**Action**: try bbd with dch.dbkl=false instead of true and see if more
targets engage.

**RESULT 2026-04-26**: `dbkl` decoded — `false` = instant/no-dialog (UI default),
`true` = ask-user dialog. Has nothing to do with zaap usage. Default flipped to
`false`. H6 still open re: zaap usage on isolated subgraphs (untested).

### H7 — bbd's invocation context (caller stack) matters for IL2CPP  (★)

**Theory**: IL2CPP method dispatch examines the caller's stack frame for
context (e.g. UnityEngine's implicit "frame allocator"). Frida's runtime_invoke
provides a synthetic stack that's missing required context. The pathfinder
might use frame-allocator memory that's not available in our context.

**Test idea**: hard to test directly. Maybe inject our bbd call via patching
a real Unity callsite to call bbd with our args.

---

## RESOLVED 2026-04-26 — `foz.dpgl._state` CTS pollution = real bug

**Symptom**: After many bbds in a session, bbd to FAR targets (Otomai from
Astrub etc.) silent-rejects (deiy stays false). Restart Dofus → same target
engages immediately. The "after-restart works" pattern is what tipped us off.

**Root cause**: `foz.dpgl` is the CancellationTokenSource backing the world
pathfinder. After each bbd cycle, `_state` may end up at 1 (Notifying =
cancellation requested). Subsequent bbds short-circuit because the CTS thinks
a cancellation is in flight. Forcing `_state = 0` + clearing the working
collections (dpgn/dpgp/dpgo/dpgr/dpgs) restores fresh-session behaviour.

**Fix integrated in `src/rpc-agent/sender.ts:autoTravelInstant`**:
the function now performs the foz cleanup *inline* on the main thread before
every `bbd.invoke`, so EVERY caller (panel, curl, scripts) gets fresh-session
semantics automatically. The standalone `resetPathfinderState` RPC still
exists for explicit use.

Verification: from Cité d'Astrub (188744706), bbd 155149 (Otomai -47,13):
- Before fix (after several bbds): deiy=false silent reject
- After fix (auto reset in autoTravelInstant): deiy=true, player walks toward
  Otomai immediately

## INVESTIGATION 2026-04-26 — "system error" is purely cosmetic, hooks innocent

**Root cause of the user-reported "every bbd brick"**: noisy log spam, not a real bug.

The orchestrator was logging `[plan] bbd(X) reported err: Error: system error`
as a warning on every bbd call because Frida-il2cpp-bridge's `method.invoke`
on `dtt.bbd` ALWAYS throws when the method returns a `UniTask` (Cysharp's
custom awaitable). The throw happens during return-value marshaling AFTER bbd
has fully scheduled the autopilot — `deiy` turns `true` within ~200ms regardless.

**Confirmed by direct testing** (hook isolation matrix on bbd 155149 Otomai):
- No hooks at all → "Error: system error" + deiy=true
- hookAutopilotDone (just tkl) → "Error: system error" + deiy=true
- hookBbdArgs (just bbd) → "Error: system error" + deiy=true
- hookAutopilot (165 methods) → "Error: system error" + deiy=true

The hooks have ZERO effect on the err. They also don't break engagement.

**deiy timing**: turns true within 200ms of the bbd call. Our 1500ms wait
before probing deiy is more than enough — the value is reliable.

**Smoke test (panels/scripts/smoke-coverage.js)** — 5 plan entries from
Amakna start position:
- gfx 3507 → cand1 (Château d'Amakna) arrived after 24s walk ✓
- gfx 656 → cand1+2 silent-rejected, cand3 (Cité d'Astrub) arrived ✓
- 3 entries had all 3 candidates silent-reject (genuinely unreachable from
  Astrub city center — different region than the candidates)
- **No cumulative bricking**, **no cascade failure**, fallback mechanism
  works as designed.

**Fix applied**:
1. `src/rpc-agent/sender.ts:autoTravelInstant` — silenced the
   `[autopilot] bbd(X) threw` console.log; the throw is captured into the
   RPC `reason` field but no longer printed.
2. `dofus-app/public/panels/coverage.ts:tryCandidate` — silenced the
   `[plan] bbd(X) reported err` logRpcLine. We trust deiy probe exclusively.

**Open optimisation** (not bug): many top candidates fail because they're
scored by `bonusGfx` count without considering distance/region from the
player. Future: prefer candidates in the same connected region as the
current map (requires region graph or runtime probe).

## INVESTIGATION 2026-04-26 — silent reject does NOT pollute foz

Two parallel subagents investigated the "one fail bricks the session" complaint.

**Findings (Agent 2, state diff)**: Snapshotted `foz` fields BEFORE and AFTER a
single `bbd(unreachable)`. Result: `foz.dpgn`, `foz.dpgo`, `foz.dpgp`,
`foz.dpgq`, `foz.dpgs`, `foz.dpgl._state` — **none changed**. The worldgraph
solver `foz.bgtq` is **never invoked** for unreachable targets. The reject
happens upstream — between `eli.baos(end)` (step 8) and `foz.bgtq` (step 9).
Likely a "are start and end in the same connected component?" guard.

→ The "foz cache poisoning on a single bbd" hypothesis is **wrong**.

**However**, observed: `foz.dpgl._state == 1` (CancellationTokenSource in
"Notifying" state) was found stale at session start before any test — meaning
**cumulative** bbd+abort cycles CAN leave a stale CTS. Writing `_state = 0`
fixed it. So mitigation is still useful, just for a different reason than
originally believed.

**Findings (Agent 1, pathfinder query)**: Identified a clean pre-check primitive:
- `eli.baos(Int64 mapId, Int32 zone)` is **static** and returns the canonical
  `Vertex` for a map. `Vertex = {m_mapId:Int64, m_zoneId:Int32, m_uid:UInt64}`.
- `foz.bgtq(fromVertex, toVertex, Action<List<Edge>,bool> callback, bool _)` →
  `UniTask`. Callback signature `(edges, success)` — `success` is the cleanest
  reachability bool we've found, doesn't touch `dtt.deiy` or any UI state.
- Cleanup pair: `foz.bgts()` then `foz.bgtt()` (untraced no-arg void = highly
  likely the result-set reset).
- `foz.bgtw` (Edge → bool, **static**) and `foz.lw / ehn / bgtx` are pure
  edge-traversable predicates. `foz.bgtv()` returns Int32 (counter, not reset).

Building a JS→C# `Action<List<Edge>,bool>` delegate via Frida is non-trivial.
Skipped for now in favor of the simpler `resetPathfinderState()` approach —
revisit if the defensive cleanup proves insufficient.

## RESOLVED: defensive `resetPathfinderState()` (sender.ts)

Implemented based on Agent 2's confirmed-writable fields:
1. Force `foz.dpgl._state = 0` (CTS unstuck)
2. Set `foz.dpgq = null` (pending callback ref)
3. `Clear()` on `foz.{dpgn, dpgp, dpgo, dpgr, dpgs}` collections

Called from coverage panel BEFORE every bbd and AFTER every fail/abort path.
Eliminates the cumulative-state symptom (TBD: confirm under load).

## RESOLVED: subarea level=0 = non-autopilot-able

**Discovery**: Subareas with `level == 0` are instances/special maps that
the autopilot cannot reach from outdoor maps. Includes:
- Prison de Madrestam, Prison des MJs (jails)
- Base des Justiciers (admin map)
- Havres-Sacs (player havenbags)
- Mode tactique, Cartes de combat (combat instances)
- Résidence brékmarienne / bontarienne (housing instances)
- Halls de guilde (×6 — guild halls)
- Maelström de Shariva, Amphithéâtre du Kolizéum
- Quelque part, Horloge du Chaos, Bouts du monde, Dofus Games (events)
- Fouilles sufokiennes, Repaire de Sphincter Cell

25 such subareas total → 1009 maps on wm=1 alone.

**Filter applied** in `build-coverage-plan.py`: drop targets where
`subarea.level == 0`. Tested: removes Base des Justiciers (which would
have been plan target #1 = guaranteed fail), keeps Village d'Amakna +
Château d'Amakna (legitimate walkable Amakna maps).

This doesn't fix the bbd state corruption (still need to figure out the
"-21,-17 Routes Rocailleuses" type cases that get poisoned mid-session),
but eliminates ~1000 false-positive failures from each plan run, which
in turn means MUCH less cache pollution per session.

## Recommended next steps (priority order)

1. **Test H6 (zaap usage)** — trivial: try bbd with `dch.dbkl=false`.
   If unreachable maps suddenly engage, this is the answer.

2. **Test H1 (trampoline)** — call bbd from inside a hooked method's callback.
   If hooks fire then, we have a way to "fix" the call path.

3. **Test H4 (state comparison)** — exhaustive snapshot diff between agent
   and UI bbd. Tedious but might reveal the missing piece.

4. **Build a reachability prober RPC** — for each plan target, fire bbd then
   probe deiy at 1.5s. If false, mark as unreachable and skip in plan generation
   (rather than mid-execution). Reduces orchestrator failure cascade.

5. **Final fallback**: revise the coverage plan algorithm to ONLY include
   targets that are walking-reachable from a small "anchor zone" around the
   player's current position. Move the anchor manually between batches.

---

## Test scripts in this repo

| Script | Purpose |
|--------|---------|
| `dofus-app/scripts/test-autopilot-poison.js` | Run series of bbd calls, snapshot state between, classify engage/reject |
| `dofus-app/scripts/test-autopilot-method-vs-native.js` | A/B compare `method.invoke` vs `NativeFunction` for a target |
| `dofus-app/scripts/test-autopilot-reachability.js` | Probe each plan target individually, output reachable/unreachable list |

---

## Session-bricked state (CRITICAL for testers)

**Confirmed empirically**: running heavy autopilot probing via the agent
(20+ bbd attempts in quick succession, especially mixed with `abortAutoTravel`
calls) puts the GAME's pathfinder in a state where:

- ALL bbd targets are rejected (deiy=false even for 1-hop neighbors)
- Frida agent reload does NOT recover (the broken state lives on the IL2CPP
  side, not Frida side)
- The ONLY recovery is to **walk the player MANUALLY** in-game to a new map
  (any direction)
- After manual walk, autopilot re-engages normally

This means **the test scripts in this repo CAN brick your session**. Specifically:
- `test-autopilot-reachability.js` — running on 30+ maps with abort between
  each will poison the state
- Repeated `autoTravelInstant` calls within seconds → eventually pollute

Mitigations:
- Run scripts on a SHORT batch (~5-10 targets max)
- Walk the player manually between batches
- If state is bricked, walk one cell in-game then re-test

## Reproducible fail recipe

From any Astrub-area starting position:

```bash
node -e "
async function go() {
  const r = await fetch('http://localhost:3001/api/call', {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'autoTravelInstant',args:[88081176]})}).then(r=>r.json());
  console.log('bbd:', JSON.stringify(r.result));
  await new Promise(r=>setTimeout(r,1500));
  const s = await fetch('http://localhost:3001/api/call', {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'snapshotDttState',args:[]})}).then(r=>r.json());
  console.log('deiy:', s.result?.fields?.['<deiy>k__BackingField']);
}
go();
"
```

Expected output: `bbd ok=true OR ERR system error`, `deiy=false` (rejected).

If the user manually clicks (2,-1) Village d'Amakna in-game from this same
position, autopilot engages successfully.

The discrepancy is the heart of the mystery.

---

## RESOLVED-PARTIAL 2026-04-27 — `foz.dpgi` static Exception is the real bricking root

**Critical discovery via dynamic call tracing**: the bricking has FOUR
intertwined symptoms, only one of which is the actual root cause; the others
are downstream effects that disappear once the root is fixed.

### The bricking symptom map

| Symptom | What you see | Root or downstream? |
|---------|-------------|---------------------|
| Popup "Une recherche d'itinéraire est déjà en cours" | bbd UI dispatch fails before solver runs | Downstream of `dtt.deiz=true` + `dejo!=null` |
| Popup "Aucun itinéraire" then "Voyage?" then no walk | solver runs but returns empty path | **Root** — `foz.dpgi` static Exception is set |
| `eli.djzh != 0` (state machine stuck on 2 or 3) | bbd guard rejects | Downstream of failed previous solve |
| `foz.dpgl._state == 1` (CTS Notifying) | new solves auto-cancel | Downstream of failed previous solve |

### The real root: `foz.dpgi` static Exception

`foz` has a STATIC field `dpgi` typed `System.Exception`. When `foz.bgtq`
catches an exception during a solve, it stashes it into `dpgi` (debugging
hook). On a healthy session `dpgi` is null. When stuck, `dpgi` contains:

```
Exception {
  _message: "Pathfinding already in progress"
  _HResult: -2146233088 (= System.InvalidOperationException)
  native_trace_ips: [0x1b30b02, 0x6305be, 0x1b467da, 0x17ddbbf]
}
```

While `dpgi` is non-null, every subsequent `bgtq` solve appears to short-circuit
internally and return an empty path (`foz.dpgs = List[0]`). The UI sees the
empty path → first popup "Aucun itinéraire", then on user retry second popup
"Voyage?" because the previous attempt cleared a UI flag — but on OK click
the dispatched walk has no hops to execute, so nothing moves and no `iri`
packet is sent (verified via empty outgoing log).

### What does NOT work as recovery

Tested on a confirmed-stuck session, none of these by themselves restore
solver functionality:
- `abortAutoTravel` (= `dtt.fob(dck)`) — only cancels active autopilot, ignores stuck dpgi
- Havre-sac round-trip (enter HB + return) — state strictly identical before/after
- `resetPathfinderState` (existing RPC clearing dpgn/dpgp/dpgo/dpgr/dpgs + CTS=0 + dpgq=null)
- `clearStuckCallbacks` (eli.djze + eli.djzg + foz.dpgq + dtt.deiz)
- `fullFozReset` (.ctor + Clear lists + deiz=false) — note: ctor doesn't actually
  empty dpgn/dpgp; collection counts persist as Dictionary[1516] / Dictionary[1931]
- `nullDttField("dejo")` + `nullDttField("deiz")` + `setIntField("eli","djzh",0)` + `probeFozCts(0)` — bbd dispatches
  but solver still returns empty path because dpgi is still non-null
- `clearFozOpenClosed` (Clear dpgn + dpgp) — solver re-fills them on next bgtq
- `callOnLive("foz","bgts" / "bgtt" / "rc" / "cvn" / "erz")` — no-arg voids, no effect on dpgi
- `callOnLive("eli","luh"/"kzj"/"baoq"/"eey"/"cbb")` — same
- `dispatchBaoiWithStuckCallback(mapId)` — direct invoke of `elg.baoi` reusing the stuck `eli.djze`
  callback throws "system error" (likely null callback chain corruption)

### The minimal cleanup (still incomplete)

Combined cleanup that DOES restore "popup shows Voyage? OK", but **walk still
doesn't engage** because dpgi gets re-set during the next solve:

1. `clearFozOpenClosed` → empty dpgn + dpgp
2. `callOnLive("foz","bgtt")` → null djze + dpgq + deiz
3. `probeFozCts(0)` → CTS Notifying → NotCanceled
4. `nullDttField("dejo")` → drop residual target
5. `nullDttField("deiz")` → drop reject latch (set false by bgtt anyway)
6. `setIntField("eli","djzh",0)` → state machine → idle
7. `probeStaticField("foz","dpgi",true)` → null the cached Exception
8. fire bbd → popup "Voyage?" — but **OK click does nothing**: solver
   re-throws "already in progress" internally, re-fills dpgi, returns empty path.

### What we proved about cached Vertices (NOT the cause)

- `eli.djzf.m_uid = 7146` (start, current map 73401858)
- `foz.dpgk.m_uid = 2909` (target, 189399809)
- `eli.baos(73401858, 1)` (canonical) → `m_uid=7146` ← matches
- `eli.baos(189399809, 1)` (canonical) → `m_uid=2909` ← matches

So Vertex UIDs are NOT stale relative to the worldgraph. The graph itself
(static `foz.dpgh = PathFindingData` containing m_vertices, m_edges,
m_outgoingEdges) is intact too. The bricking is in the SOLVER's transient
state, not in the graph data.

### Static fields discovered (mostly absent from prior investigation)

| Field | Type | Role |
|-------|------|------|
| `static foz.dpgh` | `PathFindingData` | World graph (vertices+edges+outgoing) |
| `static foz.dpgi` | `Exception` | Last solve exception — **THE bricking marker** |
| `static eli.djzd` | `PathFindingData` | Same world graph (probably alias of dpgh) |

### Useful new RPCs added for this investigation

In `src/rpc-agent/sender.ts`:
- `nullDttField(name)` — write ptr(0) into any dtt field (handles bool / object refs)
- `setIntField(class, field, value)` — write Int32/Int64 into any field
- `probeFozCts(forceTo?)` — read or force-write `foz.dpgl._state`
- `probeStaticField(class, field, writeNull?)` — read/null any static field
- `dumpFozPathEnds()` — dump foz.dpgj + foz.dpgk + eli.djzf with sub-fields
- `clearFozOpenClosed()` — Clear dpgn + dpgp dictionaries
- `callOnLive(class, method, args)` — invoke method on last live instance
- `callStaticOnClass(class, method, args)` — invoke static method, dump result
- `dispatchBaoiWithStuckCallback(mapId)` — direct elg.baoi reusing stuck callback (failed)
- `traceAutopilotMinimal()` / `untraceAutopilotChain()` / `getAutopilotTrace(clear?)` —
  dynamic trace of ~17 core autopilot methods (no UniTask returners). Used to compare
  healthy vs bricked call sequences.

### Healthy vs bricked dynamic trace pattern

**Healthy** (captured 2026-04-27 on clean session):
```
Phase 0 init  : dtt.tlc → tkr(true) → tkq → foz.bgts → foz.bgtv x N (1→15+)
Phase 1 setup : dtt.tky → tkv(map,cell) → tkt → tla → tkk(prev) → tks → cwi(List, false) → eli.baot(true) THREW → tkh(map, true)
Phase 2 hops  : repeat (tkv → tkt → tla → tkk) per hop, ~3-4s each
Phase 3 final : dtt.tlc → tkl(true,false) → tkk(finalMap)
```

**Bricked** (same minimal trace, after several aborts):
```
foz.bgts is called → foz.bgtv NEVER fires → eli.baot(true) THREW → tkh(map, true)
(no Phase 2, no Phase 3, no walk)
```

**Diagnostic invariant**: `foz.bgts` followed by `foz.bgtv ≥ 1` = solver
exploring nodes (healthy). `foz.bgts` followed by NO `bgtv` = solver
short-circuited (bricked, almost certainly because `foz.dpgi != null`).

### Open questions for next session

1. Does `foz.dpgi` get re-set BY bgtq during the next solve, or before it?
   (Test: null dpgi → bbd → check dpgi within 100ms vs 2s.)
2. Where is the actual "in progress" check that throws? Probably a Mutex /
   SemaphoreSlim somewhere in foz that we haven't found. Needs deeper scan
   of foz fields including private generic types.
3. Can we invoke `foz.ot(PathFindingData)` or `foz.bgtr(PathFindingData)`
   (the static setters of dpgh/djzd) to "swap in" a fresh worldgraph
   instance? Would re-create solver state from scratch.
4. The hooked methods themselves (m.implementation wrappers) DEGRADE the
   IL2CPP state machine over time. Confirmed: even after `unhookSolverProbes`,
   only `/api/reload` (= re-attach Frida) restores normal autotravel.
   `foz.bgtq`, `elg.baoi`, `dtt.bbd/tkc`, `dtt.tjz` cannot be safely hooked
   via m.implementation (banned in `TRACE_BANLIST`).

### Practical recovery (for now)

Restart Dofus = the only reliable fix. `fullFozReset` works in some cases but
only if the static dpgi happens to be already null. The proper proactive fix
to test next is: `probeStaticField("foz","dpgi",true)` BEFORE every bbd in
the coverage panel — if it prevents bricking accumulation in healthy sessions,
that's the answer.

---

## RESOLVED 2026-04-27 (later) — Minimal fix CONFIRMED on fresh session

After Dofus restart + Frida re-attach, the static state was STILL bricked:
- `foz.dpgi` = Exception("Pathfinding already in progress") (residual from prior session?)
- `foz.dpgl._state` = 1 (CTS Notifying)

Applied the minimal fix:
1. `probeStaticField("foz","dpgi", true)` — null the static Exception
2. `probeFozCts(0)` — reset CTS to NotCanceled

Then `autoTravelInstant(189399809, false)` (popup mode):
- Snap after 4s: `dejp = List[50]` (was always `<access violation>` before = empty)
- Popup: "Un itinéraire a été trouvé pour atteindre la carte [16,-24] (Village de
  Pandala) en traversant 50 cartes. Voulez-vous démarrer ce voyage maintenant ?"
- User clicks OK → walk physically engages, hops to next maps normally

**The 2-step minimal fix WORKS.** No need for the heavier cleanups (dpgn/dpgp
Clear, dejo/deiz null, djzh reset, bgtt) — bbd handles all of those itself
when it can actually dispatch a successful solve.

### Caveats / open questions
- Whether this fix repairs a session bricked DURING use (not just leftover from prior
  session) is not yet confirmed. Pending test: brick state mid-session via
  several aborts → apply the 2-step fix → verify recovery without restart.
- The static `foz.dpgi` survived a Dofus process restart (or the user did not
  fully restart — needs verification). Either way: probing dpgi proactively
  before each bbd appears safe, since restoring it to null on a healthy
  session is a no-op.

### Recommended integration

Call sequence to wrap every coverage-panel bbd dispatch:

```js
await rpc("probeStaticField", ["foz", "dpgi", true]);  // null static Exception
await rpc("probeFozCts", [0]);                          // unstick CTS
await rpc("autoTravelInstant", [mapId]);                // existing dispatch
```

Cost: 2 cheap field reads/writes per bbd. Should not lag the way
`clearStuckCallbacks` did (4 writes touching reactive Action delegates).

---

## CONFIRMED 2026-04-27 (final) — Two-tier bricking, only one is fixable

The full picture:

### Tier 1 — Solver state stuck (FIXABLE via Frida)

Symptoms:
- Popup "Une recherche d'itinéraire est déjà en cours" or
- Popup "Aucun itinéraire" then "Voyage?" but no walk
- `foz.dpgi` (static) = Exception("Pathfinding already in progress") — common
- `foz.dpgl._state` = 1 (CTS Notifying) — common

Fix: 2 RPC calls in any order, fast, no lag:
```
probeStaticField("foz", "dpgi", true)  // null the static Exception
probeFozCts(0)                          // CTS Notifying → NotCanceled
```

After fix, next bbd dispatches normally and the solver runs against the
existing worldgraph.

### Tier 2 — Worldgraph data corrupted (NOT FIXABLE via Frida)

Symptoms:
- After Tier 1 fix, solver runs but `foz.dpgs = List[0]` (no path found)
- Even adjacent maps (1 cell away) become "no path"
- Sometimes the OPPOSITE: paths to UNREACHABLE maps (e.g. Île de Noël) are
  found in bricked state — proof that edges are randomly present/absent/redirected
- Vertex UIDs (eli.djzf, foz.dpgk) compared to canonical `eli.baos(mapId, zone)`
  show NO drift — the corruption is in the Edges, not the Vertices

The `PathFindingData` static (foz.dpgh) holds:
- `m_vertices` (DictionaryMapIdVertices) — checked, intact
- `m_edges` (DictionaryUidToEdges) — corrupted in bricked state
- `m_outgoingEdges` (DictionaryUlongEdgeList) — corrupted

Edges seem to be loaded from Unity assets at login. No Frida-side reset
recreates them — restart Dofus is the only known fix.

### Verified non-fixes for Tier 2

| Attempt | Result |
|---------|--------|
| `fullFozReset` (.ctor + Clear lists + deiz=false) | dpgs still `List[0]` after retest |
| `clearFozOpenClosed` (Clear dpgn + dpgp) | solver re-fills, still no path |
| All combo cleanups (dpgi + CTS + dejo + deiz + djzh) | dispatch works, solver returns empty |
| `triggerWalkFromFozPath` (manual `dtt.cwi(foz.dpgs, false)`) | uses stale path from previous solve, no real walk |
| Re-attach Frida (`/api/reload`) | only wipes JS-side hooks, IL2CPP state survives |

### Practical recipe

1. **Pre-bbd defensive cleanup** (cheap, harmless): apply Tier 1 fix proactively
   before each `autoTravelInstant` in the coverage panel. Should massively
   reduce the rate of bricking accumulation.
2. **When Tier 2 hits** (path always empty even after Tier 1): restart Dofus.
   No way around it currently. The user's observation that walking 1 map
   manually fixes it = the manual walk presumably re-loads worldgraph chunks
   from server on map transition, healing the in-memory edge corruption.

### Exhaustive class scan for PathFindingData consumers (negative result)

To find a hidden re-loader for the corrupted worldgraph, scanned every class
in every IL2CPP assembly via two RPC introspection helpers (added in
sender.ts):

- `findClassesWithFieldType(["PathFindingData"], …)` → 2 hits: `eli.djzd` (static)
  and `foz.dpgh` (static). Both already known.
- `findClassesWithFieldType(["DictionaryUidToEdges","DictionaryMapIdVertices","DictionaryUlongEdgeList"], …)` → 1 hit: `PathFindingData` itself (its 3 owned dicts).
- `findMethodsWithType(["PathFindingData"], …)` → 6 hits, all known:
  - getters `eli.baon, kme, bal, kty` (static, no-arg, return PathFindingData)
  - setters `foz.ot, foz.bgtr` (static, take PathFindingData, void)

**Conclusion**: the worldgraph populator is in a class that references
PathFindingData only via local variables. Cannot find it by signature scan.
The only paths forward (deferred):
1. Hook `PathFindingData.ctor()` with backtrace at login (intrusive, risks
   degrading IL2CPP state machine before observation completes)
2. Attach Frida at process start, before login, to observe the load chain

For now, **restart Dofus is the confirmed-only Tier 2 recovery**.

---

## OPERATIONAL SOLUTION 2026-04-27 (final) — Worldgraph BFS pre-check

After identifying that bricking has two tiers (Tier 1 = solver state stuck,
fixable via dpgi+CTS reset; Tier 2 = corrupted state observable as "no path
returned even on adjacent maps"), the user proposed: **"can't we predict
reachability before firing bbd, and skip if non-reachable?"**

This works. It also revealed that **most Tier 2 corruption originates from
firing bbd toward genuinely non-reachable maps** (isolated worldgraph
components like Île de Noël). Pre-checking eliminates the corruption source.

### The pipeline

1. **Dump the worldgraph** once via `dumpOutgoingEdges` RPC (sender.ts):
   - Iterates `foz.dpgh.m_outgoingEdges` (DictionaryUlongEdgeList)
   - Returns `{ adjacency: { srcUid: [destUid, ...] }, uidToMapId: { uid: mapId }, vertexCount, edgeCount, mappedUids }`
   - 10k+ vertices, 30k+ edges, ~1MB JSON

2. **Persist on disk** via the new `/api/worldgraph` endpoint (server.js):
   - `GET` serves `data/worldgraph-adjacency.json` (instant)
   - `POST` re-dumps from Frida and saves (only needed after a Dofus patch)

3. **In-agent BFS cache** (sender.ts: `_wgAdj`, `_wgUidToMid`, `_wgMidToUids`):
   - Built lazily on first call to `isReachableMapIds(srcMid, dstMid)`
   - Survives the entire Frida session (worldgraph is loaded once at login,
     never mutated by gameplay)
   - **mapId-level BFS** — game treats all zone-vertices of a map as one
     logical node. We push ALL uids of a destination map into the frontier
     to reflect that semantic. Without this, asymmetric reachability appears
     where genuine paths via other zones exist.

4. **Pre-check in `autoTravelInstant`**:
   - Reads current map via `MapRenderer.cywa`
   - Calls `isReachableMapIds(curMid, targetMid)`
   - If unreachable → returns `{ ok:false, reason:"non-reachable in worldgraph (BFS pre-check from X)" }` immediately, no bbd fire, **zero corruption**

5. **Coverage panel shortcut** (coverage.ts:`travelAndCapture`):
   - Reads the `ok:false` from `autoTravelInstant` and `return "fail"` immediately on non-reachable
   - Skips the 5s engagement wait
   - Logs `[plan] X non-reachable per worldgraph BFS — skipping`

6. **Reachability checker UI** (panels/map.ts) — manual probing tool:
   - FROM/TO inputs accept `mapId` or `x,y`
   - Lazy-loads adjacency from `/api/worldgraph` (disk-cached)
   - Builds `mapIdToAllUids` for mapId-level BFS
   - Shows `REACHABLE in N hops` or `NOT REACHABLE`
   - REFRESH button forces re-dump after Dofus patches

### Smart plan generation (build-coverage-plan.py)

Updated to consume `data/worldgraph-adjacency.json`:
- Loads adjacency + uidToMapId + builds reverse-adjacency
- Provides `is_reachable_mid`, `reachable_set_from`, `reachable_set_to`,
  `find_bridge_waypoint` helpers
- Logs reachability stats: `N walking-reachable / M need zaap` (no drops —
  zaaps are absent from the worldgraph, so non-reachable doesn't always mean
  isolated; the agent-side pre-check decides at runtime)
- Old Manhattan-grid waypoint densifier replaced — no `+0gfx` waypoints
  inserted (user requested capture-only plans)
- Default `--max` raised to 99999 (effectively unlimited; `--min-new`
  threshold stops the greedy when next map adds zero new clusters)

### Edge directionality + zone-vertex collapsing

Two important discoveries:
- **Edges are one-way** (`m_outgoingEdges`, not `m_edges`). Some Dofus
  transitions are unidirectional (event portals, jump-only transitions,
  one-way zaaps).
- **Each map has multiple Vertex** (one per `zoneId` — physically separated
  walking zones on the same map, e.g. divided by water). The game pathfinder
  treats them as one logical map; our BFS does too via `mapIdToAllUids`.

### Known limitations

- **Zaaps are NOT in the worldgraph dump.** They live in a separate
  catalog/network we haven't extracted. So a target marked "non-reachable"
  by our BFS may actually be reachable via zaap. The agent-side pre-check
  errs on the side of caution and may skip zaap-reachable targets. To get
  full coverage of zaap-reachable maps without bricking, we'd need to also
  dump the zaap network and add it as virtual edges in the BFS graph.
- **Only the worldgraph instance loaded at login is dumpable.** No
  programmatic re-load mid-session — Dofus restart remains the only way
  to refresh after structural changes (rare, only on patches).

### File summary

| File | Purpose |
|------|---------|
| `src/rpc-agent/sender.ts:dumpOutgoingEdges` | Dump worldgraph adjacency + uid→mapId |
| `src/rpc-agent/sender.ts:isReachableMapIds` | In-agent BFS, cached |
| `src/rpc-agent/sender.ts:autoTravelInstant` | Pre-check before bbd |
| `dofus-app/server.js: /api/worldgraph` | GET disk-cache / POST re-dump |
| `dofus-app/data/worldgraph-adjacency.json` | Persisted dump (~435KB) |
| `dofus-app/public/panels/map.ts` | Reachability checker UI |
| `dofus-app/public/panels/coverage.ts:travelAndCapture` | Skip-on-pre-check-fail |
| `dofus-app/scripts/build-coverage-plan.py` | Smart plan with reachability stats |
