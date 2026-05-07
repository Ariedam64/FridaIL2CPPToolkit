# Dofus 3 (Unity) — Reverse-Engineering Notes

Living document of what's been reverse-engineered about the Dofus 3 client to
support `dofus-app` (resources panel, world map, cell overlay, gfx-to-type mapping).
Update this file as new findings come in. Avoid duplicating exploration work.

Toolkit primer: classes are heavily obfuscated (`dd`, `dvi`, `ekd`, `khs`…).
Use `describeClass(name)` and `findClassesContaining([keywords])` RPCs to
introspect at runtime. The agent attaches via Frida; only one client at a time.

---

## 1. Data flow — how interactives end up on the screen

```
Server                              Client
══════                              ══════
StatedMapUpdateEvent
(protobuf)            ─────────►   khs (deserialized protobuf)
  - InteractiveElement[]                │
    - elementId (m_interactionId)       │  static dd.bcz(khs) → dd
    - elementTypeId (cutn)              ▼
    - skills[] (cuto/cutp)            dd  (runtime InteractiveAnimatedElement)
                                       cutm: Int32   ← typeId fallback
                                       cutn: Int32   ← typeId (the one we want)
                                       cuto: List<dc> ← skill catalog refs
                                       cutp: List<dc> ← extended skills
                                       cutq: Boolean  ← visible/disabled
                                       cutr: Int32    ← state
                                         │
                                         │ added to dvi[iid] = {element: dd, position: pos}
                                         ▼
                                       dvi  (Dictionary<Int64 iid, ddWrapper>)
                                       ─── singleton, session-lifetime
                                       ─── CLEARED on map change
```

**Takeaway**: the client never computes `gfxId → typeId`. The server pushes the
mapping per-map via the `StatedMapUpdateEvent` protobuf. There is no static
client-side table.

---

## 2. The id zoo

| ID | Range | Source | Meaning | Where to find it |
|----|-------|--------|---------|------------------|
| `mapId` | 64-bit signed (~1e8) | static + server | Unique per map | `data/catalog/maps.json` |
| `gfxId` | 32-bit (1..700k) | static (mapdata bundle) | Sprite asset id (one per visual variant) | `data/maps/<mid>.json` `ie:[[cell, iid, gfxId], ...]` |
| `iid` (`m_interactionId`) | 32-bit (~5e5) | static (mapdata bundle) | Map-instance interactive id (matches network packet's `elementId`) | same as above |
| `typeId` (`cutn`) | 1..428 | runtime/server only | Interactive type catalog id (Fer=17, Frêne=1, …) | `data/catalog/interactives.json` (id+name only) |
| `m_id` (mapelement) | sequential | static (mapelements bundle) | Internal "graphical element" id (NOT typeId) | `mapelements_assets_.bundle/m_elementsMap` |
| `cutm` | 32-bit | runtime | typeId fallback. Often equals `cutn` for "skill" interactives like Zaap | runtime only |
| `m_type` | 0/1/2/3/6 | static (mapelements bundle) | Coarse element kind (graphic / interactive-prop / sound) — NOT a typeId | mapelements bundle |

The `iid` is the bridge: bundles give `iid → gfxId`, packets give `iid → typeId`.
Once you have a runtime capture for an iid, you know `gfxId → typeId` for that map.

---

## 3. Static data — what's in the bundles

### 3.1 mapdata bundles (`Content/Map/Data/mapdata_assets_world_*.bundle`)

≈900 bundles, one per "world chunk". Each bundle holds many maps as
MonoBehaviours named `map_<mapId>`. The map's `mapData` field has:

```
backgroundElements, sortableElements, foregroundElements, animatedElements,
refractionElements, interactiveElements, particlesParameters,
{topNeighbour, bottomNeighbour, leftNeighbour, rightNeighbour}Id,
{top, bottom, left, right}ArrowCellList, cellsData, …
```

Each `interactiveElements[i]` is a `SerializeReference` (rid pointer) into
`tree.references.RefIds[]`, resolving to a `ClientInteractiveAnimatedElementTransform`:

```
{
  gfxId: Int32,                       ← graphic asset id
  m_interactionId: Int32,             ← THIS is iid (matches packet's elementId)
  cellId: Int32,
  transform: { m11, m12, m21, m22, m31, m32 },  ← affine; m31/m32 = sprite pivot world coords
  materialIndex, displayBehaviour, innerCellRenderOrder, color, shaderOutlineParameters
}
```

`extract-mapdata-bundles.py` writes `data/maps/<mapId>.json` with:
```
{"mapId", "n":[N,S,W,E], "a":[arrowCells×4], "ie":[[cell,iid,gfx],...], "c":[[cellFlags,...],...]}
```

**No typeId field exists in this serialized data.**

### 3.2 mapelements bundle (`Content/Map/Data/mapelements_assets_.bundle`)

Single MonoBehaviour `elements` with `m_elementsMap`: 86477 entries. Each:
```
{m_id, m_type, m_gfxId, m_height, m_horizontalSymmetry, m_origin:{x,y}, m_size:{x,y}}
```
- 60156 unique gfxIds, 35 of the 71 runtime-known gfxIds are **absent** here
  (in particular all surface ore types: 4918 Fer, 4920 Cuivre, 4921 Bronze…).
- `m_type` is a 5-value enum, not a typeId.
- The (`m_size`, `m_origin`, `m_horizontalSymmetry`) tuple clusters visual
  variants of the same physical sprite together — useful for fan-out
  propagation once you have one runtime hit (cave iron 63846-63856 cluster
  together cleanly), but useless for surface anchors (they're not in the bundle).

### 3.3 mapgfx bundles (`Content/Map/Textures/1x/mapgfx_1x_*.bundle`)

Sprite + Texture2D objects only, named by their gfxId (e.g. `"63849"`).
Zero metadata. Ruled out as a typeId source.

### 3.4 InteractivesDataRoot (`data_assets_interactivesdataroot.asset.bundle`)

`objectsById` keyed by typeId, 428 entries:
```
{id: 17, nameId: 2667}    // 2667 → "Fer" via NameData
```
That's it. No gfxId list, no skill list. Just typeId → display name.

### 3.5 Other dataroot bundles (197 total)

Agent-investigated. Classes containing both `gfxId` and `typeId`:
- `CollectableData` (150 entries) — bestiary, all gfxId=0, dead end
- `HavenbagFurnitureData` (4083 entries) — housing furniture, typeId range 1.05M+
  doesn't match InteractiveData (1..428)
- `MonsterData`, `HouseData`, `GuildRankData`, `SmileyData`, `HintData`,
  `NpcDialogSkinData` — all unrelated

**Conclusion: no static dataroot bundle contains the interactive `gfxId → typeId` mapping.**

### 3.6 Addressables catalogs (`catalog_1.0.bin`)

Three catalogs exist (`Content/Data/`, `Content/Map/Data/`, `Content/Map/Textures/1x/`).
All contain only bundle filenames, MD5 hashes, provider class names. Zero
resource/type metadata. Ruled out.

### 3.7 IL2CPP global-metadata.dat

425017 strings extracted. Searches for `typeByGfx`, `gfxToType`, `interactiveRegistry`,
etc. → 0 hits. The `s_interactivesDataRootCached` and `MapElementsMetadata`
strings exist but they refer to bundles already inspected.

---

## 4. IL2CPP runtime classes (obfuscated → meaning)

> ⚠️ **CRITICAL READ FIRST** (2026-04-27): `autoTravelInstant` and any
> Frida-driven autopilot trigger is **NOT reliable** for actual travel
> execution. See §4.5.1 for the fundamental Frida `runtime_invoke` vs
> Unity SynchronizationContext issue. Hooks via `m.implementation = wrapper`
> also poison the natural game cascade — install for observation only,
> uninstall before running anything that depends on autopilot working.

### 4.0 Glossary — quick alias lookup

When you see an obfuscated class name in the agent code, this table tells you
what it does. Keep it in sync as you reverse new things. Format:

| Obfuscated | Alias / role | Notes |
|-----------|--------------|-------|
| **Interactive elements (server-pushed map state)** | | |
| `dd` | `InteractiveAnimatedElement` | Runtime element with `cutm/cutn` typeIds. Constructed by static `bcz(khs)` from server packet. |
| `dd.dc` | `InteractiveSkillRef` | Sub-record of `dd.cuto/cutp` — has `cutk` (skill catalog id) used by zaap teleport. |
| `dvi` | `InteractiveElementCache` | Live `Dictionary<iid, {element:dd, position:pos}>` — current map's interactives. Cleared on map change. Singleton. |
| `ekd` | `EntityRenderingBase` | Parent of `dvi`. Manages player/npc/monster/interactive entity rendering. Not the map loader. |
| `khs` | `InteractiveElementProto` | Protobuf message from server. Parsed via `dd.bcz(khs) → dd`. |
| **Map data + rendering** | | |
| `MapRenderer` | `MapRenderer` | Singleton. `cywa:Int64` = currentMapId. `cywh:mapInfo`, `cywo`/`cyvz:mapMeta`. |
| `MapMetadata` | `MapMetadata` | ScriptableObject per loaded map. `blpi(int64) → UniTask` loads geometry but NOT dvi. |
| `MapInformationData` | `MapInformationData` | Static catalog entry. Static `GetMapInformationById(mapId)`. |
| **AutoPilot stack** | | |
| `dtt` | `AutoTravelService` | Orchestrator. 102 methods, 25 fields. **Entry** = `bbd(dch)`. **Cancel** = `fob(dck)`. **Completion callback** = `tkl(bool, bool)`. See §4.3. |
| `dch` | `AutoTravelRequest` | `{dbkk:Int64 mapId, dbkl:Bool autoConfirm}` — arg to `bbd`. **`dbkl` semantics (re-confirmed 2026-04-26)**: `true` = "auto-confirm, just go" (engages immediately, no UI dialog — matches the in-game UI which `hookAutopilot` showed firing `tkh(target, true)` right after `bbd`). `false` = "compute path then ASK user" (shows the "Voyage automatique" dialog with OK/ANNULER). **Programmatic use ALWAYS sets `dbkl=true`.** Common gotcha: missing optional bool args arrive as JS `null` (not `undefined`) through the RPC layer, so the function-default `= true` is bypassed; we set the field unconditionally to avoid the IL2CPP null→false coercion. |
| `dck` | `CancelRequest` | Empty class — arg to `fob`. Just instantiate via `(dckKlass).new()`. |
| `dci` | `MapArrivalEvent` | `{dbkm:Int64 mapId}`. Used by event-handler methods (`tkg/icm/npm/kwd/gnp`). |
| `dcl` | `MapChangeEvent` | `{dbkn:Int64 mapId}`. Used by `jgx/tkd/cct/lff`. |
| `dcm` | `PathChangeEvent` | Empty. Used by `bsz/hv/olp/ouj`. |
| `dcn` | `StateUpdateEvent` | Empty. Used by `mjv/tle`. |
| `dtt.bbd` | `StartAutoTravel(dch)` | Returns Bool. Always throws "system error" cosmetically when called from agent — ignore the throw, observe `<deiy>` instead. |
| `dtt.fob` | `CancelAutoTravel(dck)` | Replicates UI click-on-place. Cascades to `tkj(false) → tlc() → baof()`. |
| `dtt.tkl(true,false)` | `OnAutoTravelComplete` | Fires once at journey end after server ack. Hooked by `hookAutopilotDone`. |
| `dtt.<deiy>k__BackingField` | `IsAutoTravelActive` | Bool. The ONLY reliably-readable dtt field. TRUE = walking, FALSE = idle. |
| `dtt.deiz` | `_lastTravelFailed` / `_hasFailedRoute` | Bool. **Set by `bbd` on silent-reject** (unreachable target — confirmed runtime 2026-04-27). Stays `true` until cleared. `autoTravelInstant` clears it before each `bbd` to avoid carrying residue. See §4.3.9. |
| `elg` | `WorldPathfindingService` | `baoi(mapId, cb, instant)` solves world-graph path. `baof(...)` computes local-map walk. |
| `eli` | `PathfindingVertexBuilder` | `baos(mapId, kind)` sets start/end vertex. `baot(true)` applies. |
| `foz` | `WorldGraphSolver` | `bgtq(Vertex, Vertex, cb, true)` solves the graph. `bgts/bgtu/bgtz` extract result. **Field index in §4.4.** |
| **Network / protobuf** | | |
| `ecu` | `NetworkSocket` | `xbe(IMessage)` — outgoing packet send method. Hooked by `startNetworkCapture`. |
| `fzk` | `IncomingPacketDecoder` | `Decode(ctx, gui, output)` — appends decoded IMessages to output list. Hooked by `startIncomingCapture`. |
| `iee` | `UseInteractiveRequest` | Outgoing packet: opens server-side interaction state (e.g. zaap menu). |
| `gyr` | `TeleportRequest` | Outgoing packet: picks destination after `iee` opens the menu. |
| `jmw` | `MapInformationsResponse` | Incoming packet: server confirms current map. Field `ekry` = mapId. Used by `waitArrival` for arrival detection. |
| **Singletons / services** | | |
| `dun` | `(unknown — pre-warmed for zaap)` | Cached as `cachedLiveDun`. Likely interactive-services bus. |
| `eax` | `(static singleton)` | Referenced by `dtt.dejt`. |

### 4.1 zaapTeleport mechanics (already implemented)

`sender.ts:zaapTeleport(mapId)` sends two packets:
- `iee` (UseInteractive) — needs `eckt`/`eckv` from current map's `dvi[zaap]`
- `gyr` (TeleportRequest) — picks the destination

Player must be near a zaap. Server validates everything. Reuses cached `dvi`,
`ecu`, `dun` singletons. See `findCurrentMapZaap()` for catalog-id lookup.

### 4.2 AutoTravelService (`dtt`) — method index

102 methods, 25 fields. The full lifecycle + canonical orchestrator pattern
is in §4.3. This subsection is a method-pattern reference for when you need
to identify what a `dttX` call does in a trace.

**Method pattern → suspected role**:

| Pattern | Suspected role | Examples |
|---------|---------------|----------|
| `(dch) → Bool` | Entry point | `bbd` only |
| `(dck) → Bool` | Cancellation entry | `fob` only |
| `(int64, bool) → Void` | Map target setter | `tkh, hhk, dbt, ctf` |
| `(int64, int32) → Void` | Per-step "go to map" | `dlv, kpa, kdj, tkv` |
| `(int64) → Void` | Mark current map | `tkk, fbp, dcy, bagd…` |
| `(List<Edge>, bool) → Void` | Path setters (writes `dejp`) | `cwi, dwu, btn, tkn, hny` |
| `(bool, bool) → Void` | Completion / arrival callbacks | `tkl, bve, egp` |
| `(bool) → Void` | State toggles | `tkj, tka, ier, tkr, mum` |
| `(dci) → Bool` | Arrival event predicates | `kwd, npm, tkg, icm, gnp` |
| `(dcl) → Bool` | Map-change predicates | `jgx, tkd, cct, lff` |
| `(dcm) → Bool` | Path-change predicates | `ouj, bsz, hv, olp` |
| `(eoh.eog, dzl) → Void` | Path-segment dispatcher | `fky, tld, bfu, kix` |
| `() → Void` | State transitions / cleanup | `esm, hbx, cia, jwz, tkb, tks, tkt, tky, tla, tlb, tlc, tlg, tlh, ikl, eti, dkj, mhj, iaa, bkr` |

**Service field references** (`dejX` slots, populated at game startup):
- `dejn:MapsInformationDataRoot` — static map catalog
- `dejt:eax` (static) — singleton service hub
- `deja..dejm` — various Dofus services (datacenter, network, pathfinding…)
- `deju:gbn` — current navigation context

**Ephemeral path state** (written by bbd, cleared on tkl — read as `<access violation>` when idle):
- `dejo:MapInformationData` — `TargetMap` (final destination map info)
- `dejp:List<Edge>` — `CurrentPath` (resolved hop list, written by `cwi`/`dwu`/`btn`/`tkn`/`hny`). **Mirrors `foz.dpgs` 1-to-1 in count** — both store the same solved path; `cwi` is the transfer point. See §4.4.
- `dejr:gav` — game-state snapshot
- `dejv/dejw:dzl` — parallel state machines

**Active flag** (always safe to read):
- `<deiy>k__BackingField:Bool` — `IsAutoTravelActive` — `true` while autopilot is running

**Failure flag** (set by silent-rejects — see §4.3.9):
- `deiz:Bool` — `_lastTravelFailed` / `_hasFailedRoute` — flips to `true` when `bbd` rejects an unreachable target. Cleared defensively by `autoTravelInstant` before each engagement to avoid residue.

### 4.3 AutoTravel lifecycle — the canonical reference

This section is the single source of truth on how `dtt`'s autopilot works.
Read this once before touching any autopilot code.

#### 4.3.1 The chain (decoded from `hookAutopilot` traces)

When ANY caller (UI button or our `autoTravelInstant` RPC) starts an autopilot:

```
[ 0] dtt.bbd(dch)                    ← entry point (dch = {mapId, instant})
[ 1] dtt.tkh(mapId, instant)         ← unwraps dch and calls tkh
[ 2] dtt.tkr(true)                   ← state setup
[ 3] dtt.tlc()                       ← state setup
[ 4] dtt.tkq()                       ← state setup
[ 5] elg.baoi(mapId, callback, true) ← invoke pathfinder service
[ 6] eli.baos(currentMapId, 1)       ← set start vertex
[ 7] eli.baot(true)                  ← apply
[ 8] eli.baos(targetMapId, 1)        ← set end vertex
[ 9] foz.bgtq(Vertex, Vertex, cb, true)  ← solve path
[10] foz.bgts()/bgtu(true)/bgtz(fpb) ← extract result
[13] dtt.cwi(List<Edge>[N], false)   ← write dejp = computed path

  per-step loop (N hops):
    dtt.tks()/tky()/tlc()            ← per-step state
    dtt.tkz(handler, mapId, dglc)    ← step dispatcher
    dtt.tkk(currentMapId)            ← mark current
    dtt.tkv(nextMapId, cellId)       ← set next destination + cell
    elg.baof(...)                    ← compute local-map walk
    dtt.tla()                        ← start walking
    dtt.kwd(dci)                     ← arrival event handler (~1-3s)

dtt.tkl(true, false)                 ← ★ FINAL completion (fires our WS event)
dtt.tlc()                            ← final cleanup
```

Cancellation chain (when UI clicks-on-place to stop walking):
```
dtt.fob(dck)                         ← ★ cancellation entry — empty dck instance
  → dtt.tkj(false)                   ← auto-cascade: SetActive(false)
  → dtt.tlc()                        ← auto-cascade: cleanup
  → elg.baof(...)                    ← auto-cascade: reset local walk
```

#### 4.3.2 dtt state — what to read, what NOT to read

`dtt` has 25 fields (`dejX`). Most are service refs or path data. The only
field you should rely on from JS is the active flag:

| Field | Recovered name | Type | Meaning | Notes |
|-------|----------------|------|---------|-------|
| `<deiy>k__BackingField` | `IsAutoTravelActive` | Bool | autopilot engaged | **Always safe to read.** TRUE while walking, FALSE when idle. |
| `deiz` | `_lastTravelFailed` / `_hasFailedRoute` | Bool | bbd silent-reject flag | **Set by `bbd` when it silent-rejects an unreachable target** (confirmed 2026-04-27). Stays `true` until next `autoTravelInstant` clears it. See §4.3.9. |
| `dejn` | `(MapsInformationDataRoot ref)` | `MapsInformationDataRoot` | Static catalog ref | Stable after game init. |
| `dejo` | `TargetMap` | `MapInformationData` | Current target map info | **Ephemeral** — written by bbd, cleared on tkl. Reads return `<access violation>` when idle. |
| `dejp` | `CurrentPath` / `PlannedPath` | `List<Edge>` | Planned path (hop list) | Same — ephemeral. Written by `cwi`/`dwu`/`btn`/`tkn`/`hny`. |
| `dejr` | `(game-state snapshot)` | `gav` | Game-state snapshot | Same — ephemeral. |
| `dejv/dejw` | `(parallel state machines)` | `dzl` | Two parallel state machines | Same — ephemeral. |

**`<access violation>` ≠ broken!** It just means the field is currently null
(or freed). Do NOT panic — only `<deiy>k__BackingField` reflects autopilot
liveness reliably.

#### 4.3.3 The bbd "system error" — what it is and isn't

**Symptom**: `dtt.bbd(dch).invoke()` throws `Error: system error` on its
return path.

**Cause**: Frida-il2cpp-bridge marshaling artifact. The IL2CPP method actually
completes its work (path computed, walk scheduled) BEFORE the throw fires on
the return-value handoff. We've seen the same cosmetic throw on `dtt.fob(dck)`
(the cancellation method) — same Boolean-return signature, same artifact.

**Diagnostics history**:
- We installed `Interceptor.attach(virtualAddress)` on bbd — captured 0 hits.
  The bridge's `il2cpp_runtime_invoke` path bypasses JIT-entry interceptors.
- We installed `m.implementation = wrapper` on bbd — STILL 0 hits when called
  from our agent (but does fire for game-internal calls). bbd specifically
  is doubly-bypassed by Frida's invoke path.
- Methods CALLED BY bbd (kwd, tkv, tla, tkl…) DO get hooked normally because
  they're invoked by native code, not by us.

**Bottom line**: ignore bbd's reported error. Always observe side effects
(`<deiy>k__BackingField` becoming TRUE = autopilot started, currentMapId
changing = walking) instead of trusting the wrapper's return.

#### 4.3.4 Engage probe — distinguishing reachable vs unreachable

When bbd is called on a target the pathfinder can't reach (e.g. cross-zone
without an intermediate path), the chain silently aborts. No exception, no
visible error — but `dtt.<deiy>k__BackingField` STAYS FALSE.

**Detection**: 1.5s after bbd, read `<deiy>`:
- `true` → autopilot engaged, walking. Continue with `waitArrival`.
- `false` → unreachable, dtt didn't engage. Skip the target. **No abort needed**
  (dtt is already idle).

This is the "1.5s engage probe" used by `processOneMap` in the orchestrator.

#### 4.3.5 Sync barrier — why and how

After arrival on the final map, dtt has cleanup work that takes ~1-2s
(server ack of position, state machine reset). The completion is signaled by
`dtt.tkl(true, false)`. `hookAutopilotDone` installs a wrapper on tkl that
broadcasts a `send({type:"autopilot-done"})` event reaching the host WS.

**Critical race condition**: tkl can fire WITHIN MILLISECONDS of the player's
final-map arrival — usually BEFORE our polling detects the new mapId. If we
arm the WS listener AFTER detecting arrival, we miss the event 100% of the
time.

**Solution**: arm the listener BEFORE bbd. The barrier captures the event
whenever it fires, and `barrier.wait()` returns immediately if it already
fired by the time we await. See `armCleanIdleBarrier` in `world.ts`.

**WS payload path**: `ev.message.payload.type === "autopilot-done"` (NOT
`ev.message.type`). Frida wraps user payloads inside a `{type:"send", payload}`
envelope. Easy bug to make.

#### 4.3.6 Cancellation — the `fob(dck)` API

To cancel an in-flight autopilot from the agent:
1. Get the `dck` class (empty struct).
2. Instantiate via `(dckKlass).new()`.
3. Call `dtt.fob(dck)`.

The cascade `tkj(false) → tlc() → baof(...)` runs automatically. After fob
returns, `<deiy>` is `false` and the next bbd is safe to fire. fob can throw
"system error" cosmetically (same as bbd) but the cancel still succeeds —
re-read `<deiy>` to confirm.

**RPC**: `abortAutoTravel()` in `sender.ts` — returns `{ok, deiyBefore, deiyAfter}`.
Reports `ok:true reason:"already idle"` when called on idle dtt (pathfinder
self-rejected an unreachable target).

#### 4.3.7 Orchestrator pattern (canonical implementation)

The `world.ts:processOneMap` flow, distilled:

```typescript
async function runOneAutoTravel(targetMapId) {
    const cleanBarrier = armCleanIdleBarrier();      // ARM BEFORE bbd
    await rpcCall("autoTravelInstant", [targetMapId]); // ignore "system error"
    await sleep(1500);
    if (!await isAutopilotActive())                   // <deiy> probe
        return "unreachable";                          // skip, no abort needed
    if (!await waitArrival(targetMapId)) {            // poll + jmw event
        await rpcCall("abortAutoTravel", []);          // stuck → cancel
        return "timeout";
    }
    await cleanBarrier.wait(8000);                     // tkl WS barrier
    return "ok";
}
```

Per-map cost: ~2s for unreachable, 5-30s for reachable (depending on hop count).
No accumulated state between maps — the cleanBarrier ensures the next bbd
starts on a fully idle dtt.

### 4.3.8 Map filtering — which targets the autopilot can reach

Not every map is autopilot-reachable. Three categories to be aware of:

**1. Special / instance maps (always unreachable, hard-filterable offline)**

Subareas with `level == 0` are instances/admin maps — **25 subareas, ~1009 maps on wm=1**.
Autopilot bbd silently rejects them (deiy stays false). Hard filter by
`subarea.level > 0` in the plan generator (already wired in `build-coverage-plan.py`).

| subarea.id | name | type |
|---|---|---|
| 34 | Prison de Madrestam | jail |
| 751 | Prison des MJs | jail |
| 775 | Enclos Instance | combat instance |
| 812 | Base des Justiciers | admin map |
| 851 | Havres-Sacs | havenbag (player portable base) |
| 859 | Maelström de Shariva | event |
| 885, 1033, 1121-1124 | Kolizéum (×6) | PvP arena |
| 895, 1036 | Mode tactique / Cartes de combat | combat instance |
| 983, 984 | Résidence brékmarienne / bontarienne | player housing |
| 1048 | Fouilles sufokiennes | special quest |
| 1113-1118 | Halls de guilde (×6, one per nation) | guild hall instances |
| 1120 | Quelque part | special location |
| 1125 | Dofus Games | event |

These maps share coords with regular outdoor maps — e.g. coords `(0, 0)` on
wm=1 has 30+ maps but ALL are level=0 instances. Picking "the map at (0, 0)"
is wrong; picking "the level>0 outdoor map at coord X" is correct.

**2. Walking-isolated subgraphs (genuinely unreachable from current position)**

Some valid level>0 maps are not connected by a continuous walking path from
the player's current position — they require a zaap or some other transition
the autopilot doesn't take. Detection is runtime-only via the engage probe
(see §4.3.4).

Example observed: `(-21, -17)` and `(-21, -18)` Routes Rocailleuses are 1 cell
apart, both level=60 outdoor — yet (-21,-18) is autopilot-reachable from
Astrub and (-21,-17) is not. There's a discontinuity in the worldmap walking
graph.

**3. Cache-poisoned (transient, requires Dofus restart)**

Heavy bbd cycling pollutes some pathfinder cache that lives session-long.
After ~30 failed bbds, even normally-reachable maps start failing. Walking
manually one map sometimes helps (resets a per-map cache slot?), but only a
full Dofus restart guarantees a clean slate. **No client-side reset
discovered.** See `autopilot-investigation.md` for the open thread.

### 4.3.9 The `deiz` flag — bbd silent-reject indicator

**Confirmed runtime 2026-04-27** via live panel polling.

**Behavior** (verified):
- During a normal UI-triggered autopilot cycle (engage → walk → arrival → tkl
  → cleanup), `deiz` stays `false` the entire time.
- When the agent fires `bbd` on an unreachable target (silent reject —
  `<deiy>` stays `false`), **`deiz` flips to `true`** at the moment of the
  rejection.
- `deiz` then stays `true` until cleared. `autoTravelInstant` writes `false`
  to `deiz` before each new `bbd` (`sender.ts` ~L866-877) to clear residue
  from any prior silent-reject.

**Recovered semantic**: a flag the game sets when `bbd` cannot find a route.
Best name candidates (no `<>k__BackingField` mangling → plain field, not an
auto-property):
- `_lastTravelFailed` — describes the state
- `_hasFailedRoute` / `_hasNoRoute` — describes the cause
- `_lastBbdRejected` — describes the trigger

**Confirmed root cause (2026-04-27, late evening)**: the symptom of "bbd
silent-rejecting reachable targets after a failed unreachable bbd" is caused
by `foz`'s static graph dictionaries (`dpgn`/`dpgp`/`dpgo`) **bloating** during
the exhaustive search. They never shrink back. See §4.3.10 for the full
investigation and §4.4 for the dict semantics.

**`deiz=true` alone does NOT block bbd.** Test 2026-04-27 with manual
primitives (`BBD RAW` + `deiz=true` set explicitly) showed `bbd` succeeding
and `cwi` clearing `deiz` internally on a reachable target. So our previous
"defensive `deiz=false` write" before each bbd was solving a non-problem.
The actual blocker is the bloated foz dicts — clearing them via RESET FOZ
makes them re-bloat on the next bbd because they're lazy-populated by `bgtq`.

#### Setter identification (2026-04-27, via `hookDeizWatcher`)

Hooked all `dtt` instance methods, traced two unsticking cycles:

```
[deiz] *** FLIP true → false via dtt.cwi   (after agent TRAVEL BY ID succeeded)
[deiz] *** FLIP true → false via dtt.cwi   (after manual ingame action that sent iri ↑)
```

**`dtt.cwi(List<Edge>, false)` is THE method that clears `deiz`.** It's the
"path-setter" already documented at step [13] of §4.3.1 — it writes
`dejp = computed path`. The deiz-clear is a side effect: receiving a valid
path means "we have a route", which is the logical inverse of `deiz` ("no
valid route"). Confirms the recovered name `_lastTravelFailed` /
`_hasFailedRoute`.

**Recovery implication**: writing `deiz=false` directly is insufficient
because the field's "true" semantic is "no path was found". Only a successful
path-resolve through `cwi` semantically clears it. The other path-setters
listed in §4.2 (`dwu, btn, tkn, hny`) might also clear it — not yet tested.

**Resolved (2026-04-27 late evening)**: `clearDeizViaCwi` works to flip `deiz`
to `false`, but doesn't fix the cascading-failure symptom — see §4.3.10. The
real fix is to stop adding defensive cleanup before `bbd` and just let
`bbd` run raw. `bbd` itself recovers `deiz` correctly via the natural `cwi`
call path when a route exists.

### 4.3.10 The actual root cause: foz dictionary bloat

**Confirmed runtime 2026-04-27** via manual primitive testing (`dttBbdRaw`,
`writeDeiz`, `writeDpglState` RPCs).

**Symptom**: after a single `bbd` on an unreachable target, subsequent `bbd`
calls to reachable targets sometimes also silent-reject. Restart Dofus
recovers; clearing `deiz` does not; `RESET FOZ` does not (the dicts re-bloat).

**Discovery**: snapshot the foz dict sizes before vs after a failed bbd:

| Field | Cold start | After 1 unreachable bbd | Ratio |
|-------|-----------|------------------------|-------|
| `dpgn` (vertices) | 1248 | **9414** | ×7.5 |
| `dpgp` (edges)    | 1584 | **10192** | ×6.4 |
| `dpgo` (subAreas) | 335  | **490**  | ×1.5 |

The "static" graph dictionaries are NOT static — they're **lazy-populated**
by `bgtq`. When the solver expands a search to an unreachable region, it
adds new vertices/edges/subareas to these dicts. They are never trimmed back
when the search fails.

**Why RESET FOZ doesn't help**: it Clear()s the dicts, but the very next
`bgtq` re-populates them from scratch. If that next solve also explores
heavily (e.g. another long search to a far target), the dicts bloat again.

**Why the bloat causes silent-rejects**: hypothesis — the bloated dicts
contain orphan/duplicate vertices that confuse the start/end vertex matching
in `eli.baos`. The solver receives Vertex objects that don't belong to the
canonical graph, so `bgtq` can't find a connection between them and returns
"no path".

**Implication for `autoTravelInstant`**: the previous "defensive cleanup"
(`deiz=false` + `dpgl._state=0` + conditional `fob`) addressed the wrong
problem. With those defenses removed and just a raw `bbd`, success rate is
higher AND the game stops freezing (the defenses were the freeze trigger).

**Next investigation steps** (open thread §11):
- Find what code adds entries to `dpgn`/`dpgp`/`dpgo` during `bgtq`
- Find a trim/prune method or static-graph reload method
- Snapshot the dicts at clean-start and restore them on stuck states
- OR find why the in-game UI's bbd path doesn't bloat them (does it use a
  different solver call?)

### 4.4 WorldGraphSolver (`foz`) — field index

7 fields recovered 2026-04-27 (parallel-agent static analysis + runtime
observations 2026-04-27). Three groups:

#### Async control (per-solve lifecycle)

| Field | Recovered name | Type | Role |
|-------|----------------|------|------|
| `dpgl` | `_completionSource` / `_solveTaskSource` *(provisional)* | likely `UniTaskCompletionSource<List<Edge>>` (NOT a .NET CTS — see note) | Async completion source for the in-flight `bgtq` solve. **`_state=1` is observed as the normal "all-good" state after a successful solve** (not a "stuck" CTS NotifyingCallbacks). UniTaskCompletionSource state enum fits: `0=Pending, 1=Succeeded, 2=Faulted, 3=Canceled` — `1=Succeeded` matches "ran fine". The `resetPathfinderState` write of `_state=0` resets it back to Pending. |
| `dpgq` | `_pendingCallback` / `_currentCallback` | `Action<List<Edge>, bool>` | Completion callback installed by `bgtq(from, to, cb, true)`. Held for the duration of the solve, nulled on completion. **Used as the foz-instance liveness probe** (single safe-to-read object slot — see `getAutopilotDebugState`). |

#### Per-solve exploration cache (NOT static — repopulated each `bgtq`)

**Corrected 2026-04-27 late evening**: previously assumed to be static graph
data loaded at boot, but runtime inspection shows these counts vary per solve
(8638 vertices for a long reachable, 1806 for a short failed search). They
grow with how far the solver expanded but do NOT carry the full Dofus map
graph. `foz.ctor()` resets them to 0 cleanly.

| Field | Recovered name | Type | Role |
|-------|----------------|------|------|
| `dpgn` | `_visitedVertices` | `Dictionary<Vertex, fpb>` | Vertices reached during the current/last solve. `fpb` value class is the per-vertex search node (probably parent-edge + g-score). Reset to 0 by `foz.ctor()`. |
| `dpgp` | `_pendingExpansion` / `_frontier` | `Dictionary<Vertex, ?>` | Companion to `dpgn` — likely the open-set or duplicate-detection structure. Reset to 0 by `foz.ctor()`. |
| `dpgo` | (transient list) | **`List<?>`** (NOT a Dict) | A per-solve list. Not cleared by `foz.ctor()`. Must be Clear()ed manually. |

#### Per-solve result + working lists

| Field | Observed behavior | Recovered name | Type | Role |
|-------|------------------|----------------|------|------|
| `dpgs` | **count == number of hops in resolved path** (e.g. `[84]` for an 84-hop trip). `dpgs.count ≡ dejp.count` always. | `_resolvedPath` (★★★) | **`List<Edge>`** | The solved path output. Populated by `bgts/bgtu/bgtz` after `bgtq` succeeds. Then copied into `dtt.dejp` by `dtt.cwi(List<Edge>, false)`. |
| `dpgr` | Often `76` between solves; non-empty after long unreachable searches blocks further long-distance solves. | `_searchWorkingState` *(provisional)* | **`List<?>`** | A per-solve working list. NOT cleared by `foz.ctor()` — survives across solves. Empirically blocks long-distance bbds when stuck non-empty after a failed search. **Must be Clear()ed manually for full recovery.** |

**Recovery hierarchy** (try in order — each step is more invasive than the previous):

1. **`autoTravelInstant` / `dttBbdRaw`** alone — works if the foz state is clean. After failed unreachable bbds it stops working.
2. **`callFozCtor`** — invokes `.ctor()` on the live foz. Resets `dpgn/dpgp` Dictionaries to 0 BUT leaves `dpgo/dpgr/dpgs` Lists intact (so `dpgr` can still be carrying stuck state). Works for short bbds after a block; insufficient for long bbds.
3. **`fullFozReset`** — `.ctor()` + `Clear()` on the 3 Lists + `deiz=false`. Maximum agent-side recovery short of a Dofus restart. Should fix even long-distance bbds after a block. Use this between bbds that risk silent-rejecting.
4. **Dofus restart** — last resort. Only needed if `fullFozReset` fails.

**Important caveats**:
- Running `dttBbdRaw` repeatedly in fast succession **freezes the game cumulatively** — each call locks the main thread for the duration of the search (synchronous bgtq). Many failed searches in a row → unplayable. Always wait for engagement (deiy) or rejection (~1.5s) before the next bbd.
- `dpgr` being non-empty after a previous failed search is the working hypothesis for "I can travel to nearby maps but not Frigost" symptom. `fullFozReset` clears it.

### 4.5.1 ⚠️ THE FUNDAMENTAL FRIDA INVOKE LIMIT (2026-04-27 final)

After ~6 hours of debugging, the conclusion: **`autoTravelInstant` via Frida
`runtime_invoke` is fundamentally unreliable for triggering an actual travel.**

**The smoking-gun experiment**: when stuck, both manual UI click AND agent
bbd were failing. Removing all `m.implementation` wrappers (including
`hookAutopilot` itself) made manual UI clicks work again — but the agent's
Frida bbd still failed. So:

1. Even an "innocent" wrapper that does nothing but log+re-invoke poisons the
   natural game cascade. The wrapper intercepts the call, runs the original
   via `self.method(name).invoke(...)`, but **the UniTask continuation
   registered inside the original gets associated with the wrapper's stack
   frame instead of the natural caller's**. When foz's async solve later tries
   to invoke its callback, the continuation context is already unwound → no
   walk phase fires → silent stuck.
2. Independently, **`il2cpp_runtime_invoke` (what Frida uses to invoke
   methods) loses Unity's SynchronizationContext.** Natural Unity calls run
   on the main thread with the proper context, which UniTask uses to schedule
   continuations. runtime_invoke executes the function body but the registered
   continuations dispatch to a context that no longer exists. So the FIRST
   level of bbd runs (kwd, tkr, elg.baoi, eli.baos, foz.bgtq are all called),
   but the foz solver result emission (`bgtz`) never propagates back through
   the `Action\`2` chain because the continuation registration was orphaned.

**Result**: `dtt.bbd(dch)` from Frida is essentially a write-only operation
that side-effects state (`eli.djzg`, `eli.djzh=2`, `dtt.deiz`, `foz.dpgs`)
but never actually moves the character.

**Implications for the project**:
- `hookAutopilot`, `hookFozWatcher`, `hookEliWatcher`, `hookDeizWatcher`
  must be **observation-only**: install → trigger → capture → uninstall.
  Leaving them installed during a coverage run breaks the coverage's own
  travels.
- `installOutgoingHook` is FINE — it only intercepts WS sends, doesn't wrap
  any async cascade.
- `autoTravelInstant` cannot be the orchestration backbone. Coverage runner
  needs a different approach.

**Possible alternative orchestration** (to investigate next session):
1. **Inject a UI mouse click** into Unity's input system. Coordinates of the
   target on the world-map UI can be computed from `(posX, posY)`. The click
   would go through Unity's natural input handler → UI handler → dtt.bbd on
   the main thread with proper context.
2. **NativeFunction direct call** — instead of `il2cpp_runtime_invoke`, call
   the method's `virtualAddress` directly via `new NativeFunction(addr,
   returnType, [argTypes])(thisPtr, ...args)`. This bypasses the reflection
   marshaling and might preserve the Unity context. Untested.
3. **Send raw click via WS** — find the outgoing packet equivalent of "user
   clicked map at (x,y)" and send it via `ecu.xbe(...)`. Requires identifying
   the packet (probably `iri` MovementRequest or similar).

### 4.5.2 The two-tier lock model (CONFIRMED 2026-04-27 night)

The "Une recherche d'itinéraire est déjà en cours" chat message check is on
**`dtt.deiz`**. Setting `dtt.deiz=false` makes the popup open normally — but
that's just dismissing the front-door check.

The actual stuck state is two-tiered:

| Layer | Indicator | Effect |
|---|---|---|
| Front-door check | `dtt.deiz=true` | Popup-mode bbd shows "déjà en cours" message instead of opening dialog |
| Hung continuation | `eli.djzh=2` + `eli.djze=Action\`2` set + `dtt.dejp/dejr=access violation` | Even after deiz cleared, the bbd cascade dispatches but the walk phase never starts. UniTask continuation orphaned. |

**Recovery primitives status**:

| Primitive | Releases what | Outcome |
|---|---|---|
| `writeDeiz(false)` | Front-door message | Popup opens normally on next bbd, but VOYAGER click still doesn't move |
| `eli.baot(true)` (when djzh==2) | Front-door + advances state machine 2→3 | Same — popup OK, walk doesn't start |
| `replaceEliInstance()` | Both — fresh eli with djzh=0 | Same — popup OK, walk doesn't start |
| `triggerKwd(currentMapId)` | Nothing meaningful | No-op for the game (no real map change) |
| `enterHavreSac(id)` (sends `igd` packet) | Forces real map change | Server confirms, currentMapId updates, BUT the in-flight UniTask continuation is still orphaned in agent process — popup's VOYAGER click still doesn't trigger walk |
| Manual H key (real keyboard) | Forces real map change | Same as enterHavreSac result-wise — but if user follows up with a manual UI click on a map, THAT new natural click works (because eli's previous solve was cancelled by kwd, freeing the lock for fresh attempts) |

**Critical realization**: the agent CAN release locks but CANNOT trigger an
actual walk after recovery. Only a natural UI click (or some other input
that goes through Unity's natural call cascade) can.

### 4.5.3 The havre-sac trigger packet (`igd`)

`igd` is the outgoing packet sent when player presses H to enter/exit
havre-sac. Captured signature:
- 1 field: `ecxt:Int64` = the player's havreSacId (e.g., `72182268199`)
- Sent via `ecu.xbe(igd)` — same socket as any other outgoing message
- Caller in normal flow: `dvl.uag(cvk)` (returns Boolean — success indicator)

The `igd` packet TOGGLES: pressing H from outside enters; pressing H from
inside exits. Same packet, server tracks state. Implemented as
`enterHavreSac(havreSacId)` RPC in `sender.ts`.

### 4.5 Current state of `autoTravelInstant` (2026-04-27 evolution)

**Final form (2026-04-27 evening) — minimalist, no foz manipulation**:
```typescript
const dch = (dchKlass).new();
dch.field("dbkk").value = mid;
dch.field("dbkl").value = dbkl;   // dbkl=true (instant) for programmatic
dtt.method("bbd").invoke(dch);     // game orchestrates everything
```

**Why we stripped all the foz pre-prep we tried before**: Every variant of
`foz.ctor()` / `foz.bgtt()` / `Clear()` / `eli.baot(true)` either:
- Wiped `foz.dpgq` (the `Action\`2` callback eli uses to notify foz back),
  breaking the `bbd → eli → foz` dispatch cascade, or
- Pre-flipped `eli.djzh` to a state that bbd's internal guard reads as
  "already done", causing bbd to early-return without firing `elg.baoi(...)`.

The autopilotHits trace of a working manual click (2026-04-27) showed bbd
itself orchestrates the entire setup internally:
```
dtt.bbd → tkh → tkr → elg.baoh/baoj/baok → foz.bgtt → eli.baot → eli.baos
        → dtt.cwi → tlc → tkm → elg.baok → foz.bgtt → tlc → tkq
        → elg.baoi(target, Action`2, true)   ← actual pathfind launcher
        → eli.baos × 2 → foz.bgtq → bgts → bgtu → bgtz → dtt.cwi(path) → tks → tky → tlc
        → dtt.tkz → tkk → tkt → tkv → elg.baof → tla   ← walk request
```
Replicating this exactly via Frida is impossible; the only correct answer is
to call bbd raw and trust the game to do its own setup.

**ROOT CAUSE of the "stuck" silent-reject (CONFIRMED 2026-04-27 evening)** —
when an agent-fired bbd is stuck, the in-game chat displays:

> [HH:MM] Une recherche d'itinéraire est déjà en cours.

This is the game's natural error message for a duplicate pathfind request.
The game thinks a previous solve is **still in flight** and refuses to
launch a new one. The state that corresponds to this lock is:
- `eli.djzh = 2` (state machine = "solving")
- `eli.djze = Action\`2` (callback registered, awaiting completion)
- `dtt.deiz = true` (latch from the previous failure that never cleared properly)

**The lock is application-level, not state-corruption.** The previous solve
WAS dispatched, but the agent-side runtime_invoke path bypassed some of
the natural call-cascade hooks, so the completion callback never fired
back into eli to advance `djzh` from 2 to 3. From the game's perspective,
the previous request is still pending.

**Why manual UI clicks unblock**: a manual click goes through the natural
call cascade. The UI handler invokes `dtt.bbd(dch)` on Unity's main thread,
which fires the entire chain (including `eli.baot(true)` mid-cascade) —
all wrappers fire, all callbacks resolve, `djzh` advances to 3, the lock
is released. Our agent's `dtt.method("bbd").invoke(dch)` from
`pendingMainWork` goes through `il2cpp_runtime_invoke` which appears to
short-circuit virtual dispatch in a way that loses some of the wrapper
firings — eli's state machine never advances past 2.

**Diagnostic primitive**: call `autoTravelInstant(mapId, false)` (popup
mode, dbkl=false). If the game shows "Une recherche d'itinéraire est déjà
en cours" in chat instead of the popup, you're stuck. If the popup opens
normally, you're not.

**Recovery primitives validated for the soft case (lock without memory corruption)**:
- `eli.baot(true)` (manual `callInstance("eli", "baot", [true])`) — advances
  djzh 2→3, clears djze callback, clears dtt.deiz. Confirmed releases the
  "Une recherche d'itinéraire est déjà en cours" lock.
- `replaceEliInstance()` — allocates a fresh `eli` via `(eliKlass).new()` and
  swaps `elg.djyz` to point to it. Old eli is orphaned. Even more aggressive
  reset than baot. Combined with `writeDeiz(false)` it releases the "déjà en
  cours" message.

**Hard-stuck recovery primitive — havre-sac round-trip (CONFIRMED 2026-04-27)**:

The "hard stuck" state where bbd via Frida fires the cascade up to `foz.bgtq`
but never completes (no `bgts/bgtu/bgtz`, no path received) **CAN be recovered
without restarting Dofus** by triggering a server-pushed map change. The
`dtt.kwd(dci)` handler that fires on map arrival forces the previous async
solve to resolve/cancel and clears the lock.

**The user-tested recovery sequence**:
1. Warp to a havre-sac (or any other separate-map context — zaap, dungeon entry)
2. Come back to the original map
3. Both transitions fire `dtt.kwd(dci)` which unsticks the cascade
4. Next bbd works normally — full cascade fires through `foz.bgtz → cwi → tla`

**Trace evidence (post-recovery, working bbd)**:
```
bbd → tkh → tkr → elg.baoh/baoj/baok → foz.bgtt → eli.baot → eli.baos
    → dtt.cwi → tlc → tkm → elg.baok → foz.bgtt → tlc → tkq
    → elg.baoi → eli.baos × 2 → foz.bgtq → bgts → bgtu → bgtz(fpb)
    → dtt.cwi(List`1[5], false)   ← PATH RECEIVED, walk phase begins
    → tks → tky → tlc → tkz × 2 → tkk → tkt → tkv → elg.baof → tla
    → 5× (kwd(dci) → tkk → tkt → tkv → elg.baof → tla)   ← multi-hop
    → kwd → tkk → tkl(true,false) → tlc   ← arrival
```

**Why a manual click on the SAME map doesn't recover**: clicking the world
map / popup VOYAGER on the stuck character doesn't trigger `kwd(dci)` because
the player hasn't actually changed map. The async solve stays hung. Only a
real map change (server-pushed) does it.

**Programmatic implementation** (TODO): add a `recoverFromStuck()` RPC that:
- Calls `zaapTeleport(currentMapHavreSac)` if player has one configured
- Waits for arrival
- Calls `zaapTeleport(playerLastZaap)` to come back
- Optionally followed by `eli.baot(true) + writeDeiz(false)` for full clean state
- Coverage runner could call this when stall-retry detects the hard-stuck signature

**Hard-stuck case (BEFORE we knew about havre-sac recovery — kept for history)**:
After ~15min of stuck-and-retry cycles, signs to look for:
- `dtt.dejp` / `dejr` show `access violation` in snapshots → path/cursor freed
- `foz.dpgj` / `dpgk` / `dpgm` show `access violation` → solver context freed
- After `eli.baot` + `writeDeiz(false)`: popup opens normally **but** clicking
  VOYAGER does nothing. Even instant-mode bbd doesn't move the character.
- Manual UI click (right-click → "Voyager…", or world-map click) also fails.

In this state, the Action\`2 callbacks point into freed memory. The path is
computed and stored in `dtt.dejp`, but `dejp` itself is corrupted. The walk
phase never starts because the cursor is invalid. There's no agent-side
recovery — Dofus must be restarted.

**Why this state is reached**: agent-fired bbds via `il2cpp_runtime_invoke`
fail to register their Action\`2 continuations on Unity's actual call frame.
The first bbd may even succeed and complete the journey, but each subsequent
bbd progressively poisons more callbacks. Eventually the dtt/foz cursors
become stale references and crashes are inevitable.

**MAJOR REVISION (2026-04-27 final)** — see §4.5.1 above. The "next-session
work" planned here is invalidated by the discovery that Frida `runtime_invoke`
fundamentally cannot reliably trigger autopilot. Even fixing the stall-retry
race wouldn't help — every Frida-fired bbd is unreliable. The real fix needs
a different orchestration approach (UI click injection, NativeFunction direct
call, or raw WS packet — see §4.5.1 alternatives).

**Original next-session plan (kept for history):**


- **Coverage runner stall-retry** ([`coverage.ts:623`](../public/panels/coverage.ts))
  re-fires `autoTravelInstant` after 10s of no movement WITHOUT awaiting
  the previous bbd's completion. The first bbd may still be in flight
  (multi-hop journeys take 30s+). The retry stomps on the running state
  → "already in progress" lock → permanent stuck. Fix: gate the retry
  on `<deiy>=false` (autopilot idle) via `waitIdleAndStable(800, 5000)`.
- **Side effect**: a manual UI click that the user attempts during this
  stuck window also collides with the in-flight bbd → manual click also
  fails. This explains the "sometimes my click works, sometimes not"
  pattern the user observed. Once the agent's stall-retry stops stomping,
  the manual click should always work too.
- **Recovery primitive when stuck**: agent needs a way to forcibly clear
  `eli.djze` to release the application lock. Direct write fails (IL2CPP
  rejects null on Action\`2 fields). The known-working alternative is
  `eli.baot(true)` when `djzh==2` — but only when called via the natural
  cascade, NOT pre-bbd from our code (where it pollutes state). Possibly
  the right place is from a separate "recovery" RPC that fires baot
  outside of any bbd context, lets it complete, then a fresh bbd works.

### 4.6 Coverage runner — current behaviour

`dofus-app/public/panels/coverage.ts` orchestrates per-map travel + capture.
Two modes:

- **Scored mode** (default, loads `resource-plan.json`): dynamic per-map
  scoring + proximity-first pickNext (within 5 cells preferred). At each
  capture, `pruneCapturedMaps()` removes from queue any non-waypoint map
  whose entire gfxIds set is now in `captured`.
- **Ordered mode** (loads `coverage-plan*.json`): static walk by `order`
  field. Skips waypoint capture (transit only). Same pruning logic. 3
  variants selectable via UI dropdown:
  - `coverage-plan.json` — full coverage
  - `coverage-plan-no-wabbit.json` — excludes subareas 25/537/538
  - `coverage-plan-wabbit.json` — only those (only 2 maps with capturable gfx)

**Per-travel flow**:
1. Install outgoing hook + autopilot-done hook (once at run start)
2. ARM `cleanBarrier` (listens autopilot-done WS event)
3. ARM `engagementWait` (listens iri/isu/isp WS event for 5s)
4. Call `autoTravelInstant(mapId)` (which does its own pre-bbd full reset)
5. If no engagement packet within 5s → fail (silent reject)
6. Else: loop with stall detection (10s no movement → retry bbd, max 3 retries)
7. On `cleanBarrier.wait → "event"` (autopilot-done fired) → arrived
8. Sleep 2s for map to load interactives (server pushes StatedMapUpdateEvent)
9. `captureCurrentMap()` extracts gfxIds → merge into captured set
10. `pruneCapturedMaps()` cleans queue
11. `cleanBarrier.cancel()` to tear down listener (was leaking before fix)

**Build scripts** (`dofus-app/scripts/`):
- `build-gfx-registry.py` — updates `gfx-to-type.json` from runtime captures
- `build-coverage-plan.py [--max N] [--max-hop N] [--exclude-wabbit] [--wabbit-only] [--out NAME]`

**Re-build cycle** when more gfx are captured:
```
python dofus-app/scripts/build-gfx-registry.py
python dofus-app/scripts/build-coverage-plan.py --max 10000
python dofus-app/scripts/build-coverage-plan.py --max 10000 --exclude-wabbit --out coverage-plan-no-wabbit.json
python dofus-app/scripts/build-coverage-plan.py --max 10000 --wabbit-only --include-captured --out coverage-plan-wabbit.json
```

---

## 5. Methods tested for "force load arbitrary mapId" (option 3)

All tested with target mapId 88083215 (wm=1, (6,8), 35 unmapped gfxIds) or
192413706 (cave wm=-1). Current map at test time: 126091776.

| Class.method | Signature | Result |
|--------------|-----------|--------|
| `MapRenderer.osl` | `(int64) → Void` | No-op (clean run, no state change) |
| `MapRenderer.osm` | `(int64) → UniTask` | **Throws "breakpoint triggered"** for any mapId ≠ currentMapId. Works fine when called with currentMapId (= reload). Confirmed: this is "ReloadCurrentMap", not "GoToMap". |
| `MapRenderer.osg` | `(MapMetadata) → Boolean` | Not tested — needs MapMetadata instance |
| `dvi.txz` | `(int32) → Void` | No-op |
| `dvi.tyk` | `(int64) → Boolean` | No-op (probably `IsLoaded(iid)`) |
| `dvi.tym` | `(int64) → dvf` | **Throws "system error"** (probably `GetByElementId`, throws on missing key) |
| `MapMetadata.blpi` | `(int64) → UniTask` | Clean run, async ~2s, no dvi change. Probably loads its OWN MapMetadata instance's geometry/materials but does NOT touch dvi. |
| `MapMetadata.blpk` | `(HashSet<int>, HashSet<int>, int64) → UniTask` | Not tested |

**Conclusion**: no single int64-arg method on MapRenderer/dvi triggers the
full map-load pipeline. The pipeline requires server cooperation
(server pushes `StatedMapUpdateEvent`).

---

## 6. Approaches tried, ranked by feasibility

| # | Approach | Feasible? | Why |
|---|----------|-----------|-----|
| 1 | Static `gfxId → typeId` lookup in any client bundle | **No** | Verified across all 197 dataroots, mapelements, mapgfx, addressables catalogs, IL2CPP metadata |
| 2 | Visual clustering of mapelements `(m_size, m_origin)` | **Partial** | LOOSE_A scheme yields 67 plausible mappings (mostly trees), 3% conflict. STRICT yields 0 (everything singleton). Cave iron variants cluster together but no surface-iron anchor in bundle. |
| 3 | Force-load arbitrary mapId via `MapRenderer.<method>(mapId)` | **No** | Server-authoritative; tested all promising methods, none populate dvi |
| 4 | Force-load via `MapMetadata.blpi(mapId)` | **No** | Loads geometry only, doesn't push to dvi; the typeIds come from the server packet not the bundle |
| 5 | Hook `dd.bcz(khs)` or `InteractiveElementWrapper.<ctor>` | **Yes** | Captures every server-pushed interactive packet. Auto-grows during play. **Recommended.** |
| 6 | Send fake `MapInformationsRequest` packet | **Maybe** | Worth investigating: if Dofus 3 has a client→server "request map info" packet that the server validates loosely, we could request arbitrary mapIds. Risky (server may flag). |
| 7 | Heap-walk all live `dd` instances after long play session | **Maybe** | `Il2Cpp.gc.choose("dd")` returns all live dd. But dd has no iid field, so re-linking iid→gfxId after dvi clears is hard |

---

## 7. Useful RPCs (from `src/rpc-agent/`)

| RPC | Module | Use |
|-----|--------|-----|
| `getCurrentMapId()` | mapstate | Fast (<1ms) current mapId read |
| `getMapState()` | mapstate | Full current map (cells, neighbors, arrowCells) |
| `getInteractivesOnMap()` | mapstate | Read dvi → [{elementId, cell, typeId, name}] for current map |
| `getMapInfo(mapId)` | mapstate | Static catalog lookup |
| `findMapLoaderCandidates()` | mapstate | Lists ranked methods on MapRenderer + dvi (option-3 helper) |
| `probeMapLoadOn(class.method, mapId)` | mapstate | Safe-invoke a method, snapshot dvi before/after, reports new entries |
| `describeClass(name)` | sender | Full class dump: methods + fields with signatures |
| `findClassesContaining([kw], limit)` | sender | Keyword search for class names |
| `extractAllCatalogs()` | catalog | Bulk-pull catalogs from runtime → host saves to `data/catalog/*.json` |
| `zaapTeleport(mapId)` | sender | Native teleport via `iee` + `gyr` packets. Server-validated. Player must be near a zaap. |
| `autoTravelInstant(mapId)` | sender | Fire `dtt.bbd(dch{mapId, true})`. Returns `ok=false reason="system error"` cosmetically very often — ignore the return, observe side effects (see §4.3.3). |
| `abortAutoTravel()` | sender | Cancel in-flight autopilot via `dtt.fob(dck)` (UI click-on-place equivalent). Returns `{ok, deiyBefore, deiyAfter}`. |
| `hookAutopilotDone()` | sender | Wrap `dtt.tkl(bool,bool)` via `m.implementation` → broadcasts `send({type:"autopilot-done"})` at journey completion. Idempotent. |
| `snapshotDttState()` | sender | Dump every field of the live `dtt`. Several fields legitimately read as `<access violation>` when idle — only `<deiy>k__BackingField` is reliably readable. |
| `listAllDttInstances()` | sender | Returns count + healthiness of all `dtt` instances in the heap. Diagnostic — there's always exactly 1 instance. |
| `startNetworkCapture()` | network | Hook `ecu.xbe(IMessage)` → all outgoing packets emitted as WS events. |
| `startIncomingCapture()` | network | Hook `fzk.Decode(...)` → all incoming packets emitted. Required for `waitArrival` to receive `jmw` arrival events. |
| `armMessageCapture([cls...])` | network | Mark a packet class for deep dump on next occurrence. Get via `getCapturedDumps()`. |

---

## 8. Files & where to look next

### Bundles
- `F:/Jeux/Dofus-dofus3/Dofus_Data/StreamingAssets/Content/Map/Data/mapdata_assets_world_*.bundle` — per-map data
- `F:/Jeux/Dofus-dofus3/Dofus_Data/StreamingAssets/Content/Map/Data/mapelements_assets_.bundle` — visual element catalog (clustering source)
- `F:/Jeux/Dofus-dofus3/Dofus_Data/StreamingAssets/Content/Data/data_assets_interactivesdataroot.asset.bundle` — typeId → name only

### Per-map runtime captures
- `dofus-app/data/maps/<mapId>.json` — bundle-extracted ie/c + runtime interactives (when player has visited)
- `dofus-app/data/gfx-to-type.json` — runtime-learned `gfxId → {typeId, name}` (~71 entries today)
- `dofus-app/data/gfx-to-type-proposed.json` — clustering-derived candidates (Frêne/Châtaignier fan-out, ~67 entries)

### Scripts
- `scripts/build-resources.py` — joins interactives → items → skills → jobs
- `scripts/build-gfx-registry.py` — aggregates runtime captures into gfx-to-type.json
- `scripts/cluster-gfx-by-visual.py` — visual clustering (LOOSE_A produces 67 mappings)
- `scripts/find-map-loader.js` — RPC orchestrator for option-3 probing

---

## 9. Recommended path forward

1. **Hook `InteractiveElementWrapper` constructor** (or `dd.bcz`) to capture
   server-pushed (iid, cutn, gfxId-via-current-map-bundle-data) tuples on
   every server map update. Persist to `data/gfx-to-type-runtime.json`,
   merge with build-time `gfx-to-type.json` via `build-gfx-registry.py`.
2. As you play, the mapping grows. After a few cave/dungeon visits, most
   resource variants are covered.
3. **(Maybe)** investigate `MapInformationsRequest`-style packets to remotely
   request server map info without moving the player. If found and accepted
   by the server, this enables full automation.
4. Re-run `build-resources.py` to regenerate `resources.json` + `resource-maps.json`.
   The world panel resource picker auto-picks up new bubbles.

---

## 10. Lessons learned

- **Don't trust class names** — Dofus 3 IL2CPP is heavily obfuscated. Use
  `findClassesContaining([keywords])` with namespace filters. The `Core.*`
  namespace generally has cleaner names than the obfuscated globals.
- **Don't trust runtime-only data** — single-session captures cover ≈70 gfxIds,
  hundreds remain. Static + runtime + clustering combined still misses
  cave/dungeon variants.
- **Server-authoritative architecture** — anything that touches game state
  (map load, teleport, interactive resolution) is gated by server. The
  client deserializes protobufs; it doesn't compute the type table.
- **Use snapshot-diff probing** — `probeMapLoadOn` snapshots `dvi` before
  and after invoking a candidate method. If dvi count/contents don't change,
  the method is a no-op or getter.
- **Don't probe with crash-prone args** — `MapRenderer.osm` throws "breakpoint
  triggered" for non-current mapIds. Repeated crashes can detach the agent.
  Always check `getCurrentMapId` after a probe to verify Dofus is still alive.
- **`<access violation>` ≠ broken — it's a clue.** When `snapshotDttState`
  reports a field as access-violation, it means the synthetic instance was
  built without the init path that normally writes that field. Find the
  init path and call it before the broken method.
- **Method return ≠ method effect.** `dtt.bbd` throws on its return path
  but the actual scheduling work happens before the throw. Always observe the
  side effect (`getCurrentMapId`, `dvi` count) rather than trusting the wrapper's
  ok/err verdict.
- **Build the alias glossary as you go.** Every time a new obfuscated class
  is identified, add an entry to §4.0. Future-you will burn hours otherwise
  re-learning that `dtt`=AutoTravelService, `dvi`=InteractiveCache, `ecu`=NetworkSocket.
- **Pattern-grep method names** — when a class has 100+ obfuscated methods,
  group them by signature (`(int64) → Bool` = predicates, `(List<Edge>, bool)
  → Void` = path setters, `() → Void` = state transitions) to triangulate purpose
  without having to inspect each.

---

## 11. Open investigation threads

Things that would unlock further capability if reversed:

1. **`InteractiveElementWrapper` deep-dive** — agent 2 flagged this as the
   "best hook target" for capturing `khs → dd` conversion with full context.
   Not yet introspected. Would let us harvest `gfxId → typeId` from server
   packets directly, no need to walk through every map.
2. **Sub-asset hunt in `mapdata` bundles** — every `MonoBehaviour` we
   inspected is the map prefab. Are there embedded ScriptableObjects we
   missed that hold gfxId→typeId hints (e.g. per-bundle "interactives table")?
3. **Identify `dejv/dejw: dzl`** — two parallel state machines on `dtt`.
   Possibly: outdoor pathfinding state vs zaap-warp state. Inspecting `dzl`
   would clarify but the autopilot works without this knowledge.
4. **The pathfinder cache poison reset** — heavy bbd cycling pollutes a
   session-long cache (§4.3.8 case 3). Only `Dofus restart` clears it. There
   must be a method that `MapInformations` (server packet on map-load)
   internally calls to invalidate / rebuild the worldmap walking graph.
   Finding it = automate the reset, no need to restart Dofus during long
   coverage runs. Candidates to investigate: `foz.bgtw()` and `foz.bgtv()`
   (excluded from hookAutopilot — likely cache management?), or the
   per-map-load callback chain triggered by jmw arrival.
5. **Confirm `deiz` causality** (§4.3.9). The setter is now identified:
   `bbd` flips `deiz=true` on silent-reject. Open question: does `deiz=true`
   actively gate the next `bbd` (passive flag vs. blocking guard)? Test plan
   in §4.3.9.
6. **`dpgr` / `dpgs` open-vs-closed disambiguation** — the recovered names
   `_openSet` / `_cameFrom` (§4.4) are best-guess from sizes (76/79). Need to
   trace counts during a single solve to confirm: open-set should grow then
   shrink to ~0; cameFrom should monotonically grow until the path is found.

### Resolved (kept for reference)

- ~~Find the live `dtt` instance~~ → there's only ONE dtt at session start,
  always live. We don't need to synthesize. (§4.3.2)
- ~~Map the `tkX(...)` family~~ → enough decoded for the orchestrator to work
  (`tkh`=set target, `tkj(false)`=disable, `tkl`=completion, `tla`=walk, `tlc`=cleanup).
  (§4.3.1)
- ~~Find a way to cancel an in-flight autopilot~~ → `dtt.fob(dck)` does it
  cleanly. Wired as the `abortAutoTravel` RPC. (§4.3.6)
- ~~bbd "system error" mystery~~ → cosmetic Frida marshaling artifact, ignore
  the throw and observe `<deiy>`. (§4.3.3)
- ~~Decode `dch.dbkl` semantics~~ → **`true` = instant / no dialog**
  (what programmatic `autoTravelInstant` calls use). **`false` = show the
  "Voyage automatique" popup with OK/ANNULER**. Re-re-confirmed live
  2026-04-27 evening with both modes. The §4.0 entry (line 168) is the
  authoritative one. Note: when stuck, `dbkl=false` does NOT show the
  popup — instead the chat says "Une recherche d'itinéraire est déjà
  en cours", which is the game's diagnostic for a duplicate-pathfind
  silent-reject. Useful for testing whether you're actually stuck. (§4.5)
- ~~Identify which maps are autopilot-reachable~~ → filter by `subarea.level > 0`
  excludes 25 instance/admin subareas (Prisons, Halls de guilde, Havres-Sacs,
  Mode tactique, Kolizéum, Base des Justiciers, etc. — ~1009 maps on wm=1
  alone). Walking-isolated subgraphs require runtime probe (engage check
  on `<deiy>` after 1.5s). (§4.3.8)
