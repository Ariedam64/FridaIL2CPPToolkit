# Dofus 3.0 — Runtime protocol observations

Captured by `installCodedInputSniffer` runtime hook on `Google.Protobuf.CodedInputStream.ReadMessage(IMessage)`. Each parse increments a counter for the runtime type of the builder.

**Why no .proto names** : Dofus does NOT use `Google.Protobuf.Reflection.FileDescriptor`. The static getters return null, and `FromGeneratedCode` is never called. Confirmed via 3 different sniffers — only `CodedInputStream.ReadMessage` fires. The protocol uses raw FieldCodec/MergeFrom paths, bypassing reflection.

## Stats

- **178** total parses observed
- **24** distinct obfuscated message classes captured
- **Session**: light gameplay (login + a few actions)

## Top messages by parse frequency

| Obf | Parse count | Inferred role | # handlers (static) |
|---|---|---|---|
| `gui` | 89 |  | 3 |
| `idw` | 30 |  | 3 |
| `irl` | 10 |  | 3 |
| `jtq` | 7 |  | 2 |
| `jnc` | 6 |  | 4 |
| `irx` | 4 |  | 2 |
| `irk` | 4 |  | 1 |
| `jrr` | 4 |  | 3 |
| `icy` | 3 |  | 1 |
| `isy` | 2 |  | 5 |
| `knz` | 2 |  | 1 |
| `knu` | 2 |  | 2 |
| `jlw` | 2 |  | 6 |
| `iso` | 2 | RoleplayIntroductionService | 9 |
| `ksj` | 2 |  | 1 |
| `isa` | 1 |  | 1 |
| `gzc` | 1 |  | 1 |
| `hfw` | 1 |  | 1 |
| `hvp` | 1 |  | 1 |
| `hwj` | 1 |  | 1 |
| `jcw` | 1 |  | 1 |
| `ibs` | 1 |  | 1 |
| `idn` | 1 |  | 1 |
| `jdk` | 1 |  | 2 |

## Key observation: `gui` is the envelope

`gui` is parsed **89 times** in this short session — by far the most. Its structure :
- 7 fields, 3 of which are message types (`gul`, `gug`, `guf`)
- Has a `gui.guh` nested type (likely a oneof case enum)
- Has a `System.Object` field (oneof storage)

This is the **top-level network envelope** that wraps every Dofus packet (a `oneof body { ... }` carrier). When you parse a Dofus packet, `gui` is parsed first, then its inner message.

`guf` (one of `gui`'s fields) has a `Google.Protobuf.WellKnownTypes.Any` field — this confirms `gui/guf` form a wrapper that carries arbitrary inner messages identified by their type URL.

## Cross-reference with static topology

Of the 24 captured messages, several already had clear-handler labels from the static analysis :

| Obf | Confirmed runtime hit | From clear handler |
|---|---|---|
| `iso` | 2 parses | RoleplayIntroductionService |

## How to extend

1. **Trigger more diverse actions** in-game (combat, trade, inventory swap, chat, dungeon entry...). Each unique action exposes new message types.
2. **Re-call** `getCollectedProtoData` to get the updated map.
3. **Cross-ref** new high-frequency messages with the static handler topology (`protocol-handlers.json`) to identify their domain.

## Recovering .proto names

Since Dofus disabled the descriptor system, the .proto names cannot be recovered at runtime via standard Protobuf reflection. Remaining options :

- **Il2CppDumper offline** — extract `global-metadata.dat` to get pre-rename names (where preserved by OPS Obfuscator metadata)
- **Public Dofus protocol docs** — community has reverse-engineered the wire format. Match obf message → public name by structure (field count, types, tags).
- **Sentry breadcrumbs** — Sentry might log method names with original strings (in-memory dump worth trying)
