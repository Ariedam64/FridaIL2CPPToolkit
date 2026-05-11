// RPC methods for network capture: startNetworkCapture, stopNetworkCapture, resolveProtobufName, sampleResolvedProtobufs.
import "frida-il2cpp-bridge";
import { findClass, findClassExact, stringifyValue } from "../lib";
import { getSingleton } from "./singleton-cache";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

// Shared descriptor cache (built once on first capture, reused by all hooks).
let nameCache: Map<string, { name: string; fullName: string }> | null = null;

function resolveDescriptors(): number {
    if (nameCache) return nameCache.size;
    nameCache = new Map();
    const t0 = Date.now();
    let resolved = 0, errored = 0;
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                let getter = null as Il2Cpp.Method<any> | null;
                for (const m of k.methods) {
                    if (m.isStatic && m.parameters.length === 0 &&
                        m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") {
                        getter = m; break;
                    }
                }
                if (!getter) continue;
                try {
                    try { (k as any).initialize?.(); } catch {}
                    const desc = getter.invoke() as Il2Cpp.Object;
                    if (!desc) continue;
                    const name = stringifyValue(desc.method("get_Name").invoke()).replace(/^"|"$/g, "");
                    const fullName = stringifyValue(desc.method("get_FullName").invoke()).replace(/^"|"$/g, "");
                    nameCache.set(k.name, { name, fullName });
                    resolved++;
                } catch { errored++; }
            }
        } catch {}
    }
    console.log(`[net] resolved ${resolved} protobuf descriptors (${errored} errors) in ${Date.now() - t0}ms`);
    return resolved;
}

// Recursively summarize an Il2Cpp value for display. Depth-limited to avoid infinite
// recursion on self-referential / tree-shaped protobufs. Returns a compact one-line string.
function summarize(v: any, depth: number): string {
    if (depth < 0) return "…";
    if (v === null || v === undefined) return String(v);
    const t = typeof v;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "string") return JSON.stringify(v);

    try {
        if (v.handle && (v.handle.isNull?.() || String(v.handle) === "0x0")) return "null";
    } catch {}
    try {
        if (typeof v.content === "string") return JSON.stringify(v.content);
    } catch {}

    const clsName = v.class?.name;
    if (!clsName) { try { return String(v); } catch { return "<?>"; } }

    // List / RepeatedField → "[N] item1, item2, …"
    if (clsName.startsWith("RepeatedField") || clsName.startsWith("List")) {
        return previewRepeated(v, 10, depth - 1) ?? `${clsName}@${v.handle}`;
    }

    // Nested protobuf-looking object → dump its non-default fields, one level
    if (depth > 0 && v.class?.fields?.length) {
        const parts: string[] = [];
        for (const f of v.class.fields) {
            if (f.isStatic) continue;
            // skip protobuf internal UnknownFieldSet
            if (f.type.name === "Google.Protobuf.UnknownFieldSet") continue;
            try {
                const fv = v.field(f.name).value;
                const s = summarize(fv, depth - 1);
                if (s === "null" || s === "0" || s === "false" || s === "\"\"" || s === "") continue;
                parts.push(`${f.name}=${s}`);
            } catch {}
        }
        if (parts.length) {
            const cached = nameCache?.get(clsName);
            const prefix = cached?.name ? `${cached.name}(${clsName})` : clsName;
            return `${prefix}{ ${parts.join(", ").slice(0, 400)} }`;
        }
    }
    return `${clsName}@${v.handle}`;
}

function previewRepeated(obj: any, max = 20, itemDepth = 1): string | null {
    if (!obj || !obj.class) return null;
    const typeName = obj.class.name;
    if (!typeName.startsWith("RepeatedField") && !typeName.startsWith("List")) return null;
    try {
        let count = -1;
        try { count = obj.method("get_Count").invoke(); } catch {}
        if (count < 0) return null;
        if (count === 0) return "[] (empty)";
        let arr: any = null;
        for (const f of ["array", "_items", "items"]) {
            try { const v = obj.tryField?.(f)?.value; if (v && typeof v.length === "number") { arr = v; break; } } catch {}
        }
        const n = Math.min(count, max);
        const parts: string[] = [];
        for (let i = 0; i < n; i++) {
            try {
                const elem = arr ? arr.get(i) : obj.method("get_Item").invoke(i);
                parts.push(summarize(elem, itemDepth));
            } catch { parts.push("<err>"); }
        }
        const more = count > max ? `, … +${count - max}` : "";
        return `[${count}] ${parts.join(", ")}${more}`;
    } catch { return null; }
}

// -----------------------------------------------------------------------------
// Deep message capture — for field-by-field verification of guessed aliases.
// -----------------------------------------------------------------------------
// `extractMessageInfo` returns summaries only. When the user wants to confirm
// "does efkv really carry the list of interactive elements?", they need to see
// the STRUCTURED shape: type, count, scalar value, runtime subclass. That's
// what `deepDumpMessage` provides. Armed classes get snapshotted in the hook.

interface DeepFieldEntry {
    name: string;
    type: string;
    kind: "scalar" | "list" | "map" | "object" | "null" | "error";
    value?: string;        // for scalar
    count?: number;        // for list / map
    sampleItems?: string[];// for list, preview of first N stringified items
    classOfValue?: string; // runtime class of the object (when kind=object)
    error?: string;
}
interface DeepMessageDump {
    cls: string;
    name: string;
    fullName: string;
    ts: number;
    fields: DeepFieldEntry[];
}

const armedDumps = new Set<string>();
const capturedDumps = new Map<string, DeepMessageDump>();

// Per-iso snapshot of each actor's monster-group composition. Extracted inline
// at iso arrival because the protobuf message object is transient (freed after
// the receive hook completes). Key = Int64 actorId as string.
interface GroupInfo {
    actorId: string;
    ermu: number;
    ermw: number;
    ermz: number[];
    ernc: number[];
    ernf: number[];
    erni: Array<{ enuq: string; enus: number; inner: { ermu: number; ermw: number; ermz: number[]; ernc: number[]; ernf: number[] } | null }>;
    sum_ermz: number;
    sum_ernc: number;
    sum_ernf: number;
    // Additional probes into the two other payloads in khe.
    kcpTag2: { bonesLike: number; boolFlag: boolean; longVal: string; str: string; intA: number; ri32: number[]; intB: number } | null;
    kghEpiuClass: string;
    kghEpiuSummary: string;
}
const capturedGroups = new Map<string, GroupInfo>();

function readRepeatedInt32(rep: any): number[] {
    const out: number[] = [];
    if (!rep) return out;
    try {
        const n = Number(rep.method("get_Count").invoke());
        for (let i = 0; i < n; i++) {
            try { out.push(Number(rep.method("get_Item").invoke(i))); } catch {}
        }
    } catch {}
    return out;
}

function captureIsoGroupData(cls: string, iso: any): void {
    if (cls !== "iso") return;
    if (!iso || !iso.class) return;
    // Walk iso.eflv (RepeatedField<khe>), extracting each actor's knl (group info).
    try {
        const eflv = iso.field("eflv").value as any;
        if (!eflv) return;
        const n = Number(eflv.method("get_Count").invoke());
        capturedGroups.clear();
        for (let i = 0; i < n; i++) {
            try {
                const khe = eflv.method("get_Item").invoke(i) as any;
                if (!khe) continue;
                const actorId = String(khe.field("eppb").value);
                const eppf = khe.field("eppf").value as any;
                // Also probe kcp.tag2 (the inner message) and kgh.epiu (polymorphic Object).
                const eppd = khe.field("eppd").value as any; // kcp
                let kcpTag2: GroupInfo["kcpTag2"] = null;
                try {
                    // kcp has fields eoki (tag1), then the m{} inner at tag2. Field names are
                    // obfuscated — iterate kcp fields to find the first `m{...}` non-null.
                    if (eppd && eppd.class) {
                        for (const f of eppd.class.fields) {
                            if (f.isStatic) continue;
                            const t = f.type.name;
                            if (t === "Google.Protobuf.UnknownFieldSet") continue;
                            // Heuristic: pick the first nested message-type field (not a scalar/enum/int).
                            const v = eppd.field(f.name).value as any;
                            if (!v || typeof v !== "object") continue;
                            if (!v.class) continue;
                            if (v.class.name === "UnknownFieldSet") continue;
                            // Scalars wrapped by Il2Cpp.Field won't have `class`; messages will.
                            // Walk inner fields to extract the 7-field pattern.
                            const innerFields = v.class.fields.filter((ff: any) => !ff.isStatic && ff.type.name !== "Google.Protobuf.UnknownFieldSet");
                            if (innerFields.length < 3) continue;
                            kcpTag2 = { bonesLike: 0, boolFlag: false, longVal: "0", str: "", intA: 0, ri32: [], intB: 0 };
                            for (const inf of innerFields) {
                                try {
                                    const iv = v.field(inf.name).value;
                                    const tn = inf.type.name;
                                    if (tn === "System.Int32" && kcpTag2.bonesLike === 0) kcpTag2.bonesLike = Number(iv);
                                    else if (tn === "System.Boolean" && !kcpTag2.boolFlag) kcpTag2.boolFlag = Boolean(iv);
                                    else if (tn === "System.Int64" && kcpTag2.longVal === "0") kcpTag2.longVal = String(iv);
                                    else if (tn === "System.String" && !kcpTag2.str) kcpTag2.str = String(iv).replace(/^"|"$/g, "").slice(0, 60);
                                    else if (tn.startsWith("Google.Protobuf.Collections.RepeatedField")) kcpTag2.ri32 = readRepeatedInt32(iv);
                                    else if (tn === "System.Int32" && kcpTag2.intA === 0) kcpTag2.intA = Number(iv);
                                    else if (tn === "System.Int32") kcpTag2.intB = Number(iv);
                                } catch {}
                            }
                            break;
                        }
                    }
                } catch {}

                let kghEpiuClass = "", kghEpiuSummary = "";
                try {
                    const epow = eppf.field("epow")?.value as any; // kgh
                    if (epow && epow.class) {
                        const epiu = epow.field("epiu").value as any;
                        if (epiu && epiu.class) {
                            kghEpiuClass = String(epiu.class.name);
                            // Try to stringify first few scalar fields of epiu for context.
                            try {
                                const summary = summarize(epiu, 2).slice(0, 300);
                                kghEpiuSummary = summary;
                            } catch {}
                        }
                    }
                } catch {}
                if (!eppf) { capturedGroups.set(actorId, { actorId, ermu: 0, ermw: 0, ermz: [], ernc: [], ernf: [], erni: [], sum_ermz: 0, sum_ernc: 0, sum_ernf: 0, kcpTag2: null, kghEpiuClass: "", kghEpiuSummary: "" }); continue; }
                const knl = eppf.field("epop").value as any;
                const empty: GroupInfo = { actorId, ermu: 0, ermw: 0, ermz: [], ernc: [], ernf: [], erni: [], sum_ermz: 0, sum_ernc: 0, sum_ernf: 0, kcpTag2, kghEpiuClass, kghEpiuSummary };
                if (!knl) { capturedGroups.set(actorId, empty); continue; }
                const ermu = Number(knl.field("ermu").value ?? 0);
                const ermw = Number(knl.field("ermw").value ?? 0);
                const ermz = readRepeatedInt32(knl.field("ermz").value);
                const ernc = readRepeatedInt32(knl.field("ernc").value);
                const ernf = readRepeatedInt32(knl.field("ernf").value);
                const erni: GroupInfo["erni"] = [];
                try {
                    const katList = knl.field("erni").value as any;
                    if (katList) {
                        const kn = Number(katList.method("get_Count").invoke());
                        for (let j = 0; j < kn; j++) {
                            try {
                                const kat = katList.method("get_Item").invoke(j) as any;
                                let enuq = "", enus = 0;
                                try { enuq = String(kat.field("enuq").value).replace(/^"|"$/g, ""); } catch {}
                                try { enus = Number(kat.field("enus").value); } catch {}
                                let inner: any = null;
                                try {
                                    const kknl = kat.field("enuu").value as any;
                                    if (kknl) inner = {
                                        ermu: Number(kknl.field("ermu").value ?? 0),
                                        ermw: Number(kknl.field("ermw").value ?? 0),
                                        ermz: readRepeatedInt32(kknl.field("ermz").value),
                                        ernc: readRepeatedInt32(kknl.field("ernc").value),
                                        ernf: readRepeatedInt32(kknl.field("ernf").value),
                                    };
                                } catch {}
                                erni.push({ enuq, enus, inner });
                            } catch {}
                        }
                    }
                } catch {}
                capturedGroups.set(actorId, {
                    actorId, ermu, ermw, ermz, ernc, ernf, erni,
                    sum_ermz: ermz.reduce((a, b) => a + b, 0),
                    sum_ernc: ernc.reduce((a, b) => a + b, 0),
                    sum_ernf: ernf.reduce((a, b) => a + b, 0),
                    kcpTag2, kghEpiuClass, kghEpiuSummary,
                });
            } catch {}
        }
        console.log(`[net] captured iso group data for ${capturedGroups.size} actors`);
    } catch {}
}

/** Return the per-actor group composition extracted from the last iso. */
export function getCapturedIsoGroups(): Promise<GroupInfo[]> {
    return inVm(() => [...capturedGroups.values()]);
}

// -----------------------------------------------------------------------------
// Full recursive dump — snapshot an entire protobuf message tree so we can
// iterate on the parser offline without asking the user to move again.
// -----------------------------------------------------------------------------

type WalkNode = {
    kind: "scalar" | "list" | "map" | "object" | "null" | "ref" | "error" | "depth-limit";
    // Present depending on kind:
    name?: string;        // when nested in an object, the field name
    type?: string;        // declared field type (when known)
    value?: string;       // scalar value or error message
    cls?: string;         // runtime class name (for object / list / map / ref)
    handle?: string;      // for object / ref
    count?: number;       // for list / map
    items?: WalkNode[];   // for list, or map-entries
    fields?: WalkNode[];  // for object
    keyValue?: { key: string; value: WalkNode }; // for map-entry variant
};

function walkValue(v: any, depth: number, visited: Set<string>): WalkNode {
    if (depth <= 0) return { kind: "depth-limit" };
    if (v === null || v === undefined) return { kind: "null" };
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
        return { kind: "scalar", value: String(v) };
    }
    const cls = v?.class?.name as string | undefined;
    const handle = (() => { try { return String(v.handle); } catch { return ""; } })();
    if (!cls) { try { return { kind: "scalar", value: String(v) }; } catch { return { kind: "error", value: "<unreadable>" }; } }

    // List-like — IL2CPP bridge reports short generic names like "RepeatedField`1".
    if (cls.startsWith("RepeatedField") || cls.startsWith("List")
        || cls.startsWith("Google.Protobuf.Collections.RepeatedField")) {
        try {
            const n = Number(v.method("get_Count").invoke());
            const items: WalkNode[] = [];
            for (let i = 0; i < n; i++) {
                try {
                    const elem = v.method("get_Item").invoke(i);
                    items.push(walkValue(elem, depth - 1, visited));
                } catch (e) { items.push({ kind: "error", value: String(e).slice(0, 100) }); }
            }
            return { kind: "list", cls, count: n, items };
        } catch { return { kind: "list", cls, count: 0, items: [] }; }
    }

    // Map-like — same short-name fallback.
    if (cls.startsWith("MapField") || cls.startsWith("Dictionary")
        || cls.startsWith("Google.Protobuf.Collections.MapField")) {
        const items: WalkNode[] = [];
        try {
            const total = Number(v.method("get_Count").invoke());
            let entries: any, count = 0;
            try { entries = v.field("_entries").value; count = Number(v.field("_count").value); } catch {}
            if (entries) {
                for (let i = 0; i < count; i++) {
                    try {
                        const e = entries.get(i);
                        let hc = 0; try { hc = Number(e.field("hashCode").value); } catch {}
                        if (hc < 0) continue;
                        const k = String(e.field("key").value).replace(/^"|"$/g, "");
                        const val = e.field("value").value;
                        items.push({ kind: "object", cls: "mapEntry", keyValue: { key: k, value: walkValue(val, depth - 1, visited) } });
                    } catch {}
                }
            }
            return { kind: "map", cls, count: total, items };
        } catch { return { kind: "map", cls, count: 0, items: [] }; }
    }

    // Cycle check on object handles. Allow diamond (same object seen in different branches).
    if (handle && visited.has(handle)) return { kind: "ref", cls, handle };
    if (handle) visited.add(handle);

    const fields: WalkNode[] = [];
    try {
        for (const f of v.class.fields) {
            if (f.isStatic) continue;
            if (f.type.name === "Google.Protobuf.UnknownFieldSet") continue;
            try {
                const fv = v.field(f.name).value;
                const sub = walkValue(fv, depth - 1, visited);
                sub.name = f.name;
                sub.type = f.type.name;
                fields.push(sub);
            } catch (e) {
                fields.push({ name: f.name, type: f.type.name, kind: "error", value: String(e).slice(0, 120) });
            }
        }
    } catch {}
    if (handle) visited.delete(handle);

    return { kind: "object", cls, handle, fields };
}

let lastFullDump: WalkNode | null = null;
let fullDumpMeta: { cls: string; ts: number } | null = null;

/**
 * Arm one-shot: on the next armed message that matches `classFilter` (e.g. "iso"),
 * take an exhaustive recursive dump of the whole message tree (depth-bounded)
 * and both cache it in-memory AND emit it via `send({type:'full-capture'})`
 * so the host can persist it to disk for offline parser iteration.
 */
let fullCaptureTarget: string | null = null;

export function armFullCapture(className: string, depth: number = 10): Promise<number> {
    return inVm(() => {
        fullCaptureTarget = className;
        lastFullDump = null;
        fullDumpMeta = null;
        armedDumps.add(className);
        console.log(`[net] armed FULL capture for '${className}' (depth ${depth})`);
        return 1;
    });
}

export function getLastFullDump(): Promise<{ cls: string; ts: number; tree: WalkNode } | null> {
    return inVm(() => {
        if (!lastFullDump || !fullDumpMeta) return null;
        return { cls: fullDumpMeta.cls, ts: fullDumpMeta.ts, tree: lastFullDump };
    });
}

// Per-map cache of fully-resolved monster groups. Populated at iso arrival
// by walking khe → eppf.epow.epiu (kgb) → epgt.eovd/eovl and resolving each
// klb's monster name via MonstersDataRoot. Lives across panel refreshes —
// cleared on the next map's iso so it only holds the current map state.
interface MonsterEntry {
    level: number;
    monsterId: number;
    monsterName: string;
    grade: number;
}
interface MonsterGroupInfo {
    actorId: string;
    cellId: number;
    leader: MonsterEntry | null;
    underlings: MonsterEntry[];
    totalLevel: number;
    totalCount: number;
    alignmentSide: number;
}
const monsterGroupsByActor = new Map<string, MonsterGroupInfo>();

// Cached MonstersDataRoot instance + getter method — lazy-initialized.
let _mdRoot: Il2Cpp.Object | null = null;
let _mdGet: Il2Cpp.Method<any> | null = null;
function getMonsterName(id: number): string {
    if (!_mdRoot) {
        try {
            const klass = findClass("MonstersDataRoot");
            if (klass) {
                _mdRoot = getSingleton(klass);
                _mdGet = klass.methods.find(m => m.name === "GetMonsterById" && m.parameters.length === 1) ?? null;
            }
        } catch {}
    }
    if (!_mdRoot || !_mdGet) return "";
    try {
        const md = (_mdRoot as any).method("GetMonsterById").invoke(id) as any;
        if (!md) return "";
        const name = md.field("m_name").value;
        return name ? String(name).replace(/^"|"$/g, "") : "";
    } catch { return ""; }
}

function readKlb(klb: any): MonsterEntry | null {
    if (!klb) return null;
    try {
        const level = Number(klb.field("equu").value);
        const monsterId = Number(klb.field("equw").value);
        const grade = Number(klb.field("eqva").value);
        const monsterName = getMonsterName(monsterId);
        return { level, monsterId, monsterName, grade };
    } catch { return null; }
}

function captureMonsterGroupsFromIso(iso: any): void {
    if (!iso || !iso.class) return;
    try {
        const eflv = iso.field("eflv").value as any;
        if (!eflv) return;
        const n = Number(eflv.method("get_Count").invoke());
        monsterGroupsByActor.clear();
        for (let i = 0; i < n; i++) {
            try {
                const khe = eflv.method("get_Item").invoke(i) as any;
                if (!khe) continue;
                const actorId = String(khe.field("eppb").value);
                const eppd = khe.field("eppd").value as any;
                const cellId = eppd ? Number(eppd.field("eoks").value) : -1;

                const eppf = khe.field("eppf").value as any;
                if (!eppf) continue;
                const epow = eppf.field("epow").value as any;
                if (!epow) continue;
                const epiu = epow.field("epiu").value as any;
                if (!epiu || !epiu.class) continue;
                if (epiu.class.name !== "kgb") continue;   // only monster groups

                const epgt = epiu.field("epgt").value as any;
                if (!epgt) continue;
                const leader = readKlb(epgt.field("eovd").value);
                const underlings: MonsterEntry[] = [];
                try {
                    const list = epgt.field("eovl").value as any;
                    const un = Number(list.method("get_Count").invoke());
                    for (let j = 0; j < un; j++) {
                        const u = readKlb(list.method("get_Item").invoke(j));
                        if (u) underlings.push(u);
                    }
                } catch {}
                let alignmentSide = 0;
                try { alignmentSide = Number(epiu.field("epgx").value); } catch {}
                const totalLevel = (leader?.level ?? 0) + underlings.reduce((s, u) => s + u.level, 0);
                const totalCount = (leader ? 1 : 0) + underlings.length;
                monsterGroupsByActor.set(actorId, { actorId, cellId, leader, underlings, totalLevel, totalCount, alignmentSide });
            } catch {}
        }
        console.log(`[net] cached ${monsterGroupsByActor.size} monster groups from iso`);
    } catch {}
}

/** Return the monster-group compositions cached from the last iso, for every
 *  actorId on the current map. */
export function getMonsterGroupsOnMap(): Promise<MonsterGroupInfo[]> {
    return inVm(() => [...monsterGroupsByActor.values()]);
}

function maybeFullCapture(cls: string, msg: any): void {
    if (fullCaptureTarget !== cls) return;
    if (lastFullDump) return;  // one-shot, first wins
    try {
        const tree = walkValue(msg, 10, new Set());
        lastFullDump = tree;
        fullDumpMeta = { cls, ts: Date.now() };
        send({ type: "full-capture", cls, ts: fullDumpMeta.ts, tree });
        console.log(`[net] full-dump captured for '${cls}' (sent to host)`);
    } catch (e) {
        console.log(`[net] full-dump failed: ${e}`);
    }
}

interface DeepFieldEntry2 extends DeepFieldEntry {
    // When kind=object, recursively describe the nested object's fields one level deep.
    // Not used for scalars / lists / maps. Expressed as a flat stringified dump
    // because JSON round-tripping deep structures can blow up in size fast.
    subFields?: Array<{ name: string; type: string; kindShort: string; preview: string }>;
}

function deepDumpMessage(msg: any, drill: number = 1): DeepMessageDump {
    const out: DeepMessageDump = { cls: "?", name: "?", fullName: "?", ts: Date.now(), fields: [] };
    if (!msg) return out;
    try { if (msg.class) out.cls = msg.class.name; } catch {}
    const cached = nameCache?.get(out.cls);
    if (cached) { out.name = cached.name; out.fullName = cached.fullName; }
    try {
        if (!msg.class) return out;
        for (const f of msg.class.fields) {
            if (f.isStatic) continue;
            if (f.type.name === "Google.Protobuf.UnknownFieldSet") continue;
            const entry: DeepFieldEntry2 = { name: f.name, type: f.type.name, kind: "null" };
            try {
                const v = msg.field(f.name).value;
                if (v === null || v === undefined) {
                    entry.kind = "null";
                } else {
                    const t = typeof v;
                    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
                        entry.kind = "scalar";
                        entry.value = String(v);
                    } else {
                        const clsName = v.class?.name ?? "";
                        if (clsName.startsWith("RepeatedField") || clsName.startsWith("List")) {
                            entry.kind = "list";
                            try { entry.count = Number(v.method("get_Count").invoke()); } catch {}
                            if (entry.count && entry.count > 0) {
                                entry.sampleItems = [];
                                const n = Math.min(entry.count, 3);
                                for (let i = 0; i < n; i++) {
                                    try {
                                        const elem = v.method("get_Item").invoke(i);
                                        entry.sampleItems.push(summarize(elem, 2).slice(0, 200));
                                    } catch { entry.sampleItems.push("<err>"); }
                                }
                            }
                        } else if (clsName.startsWith("MapField") || clsName.startsWith("Dictionary")) {
                            entry.kind = "map";
                            try { entry.count = Number(v.method("get_Count").invoke()); } catch {}
                        } else if (clsName) {
                            entry.kind = "object";
                            entry.classOfValue = clsName;
                            try { entry.value = summarize(v, 2).slice(0, 300); } catch {}
                            // One-level descent: enumerate sub-fields by name/type/kind/preview.
                            // This is what lets the UI verify jrr.elsf, isa.efhn, and other nested payloads.
                            if (drill > 0 && v.class?.fields) {
                                entry.subFields = [];
                                for (const sf of v.class.fields) {
                                    if (sf.isStatic) continue;
                                    if (sf.type.name === "Google.Protobuf.UnknownFieldSet") continue;
                                    const sub: { name: string; type: string; kindShort: string; preview: string } = {
                                        name: sf.name, type: sf.type.name, kindShort: "?", preview: "",
                                    };
                                    try {
                                        const sv = v.field(sf.name).value;
                                        if (sv === null || sv === undefined) {
                                            sub.kindShort = "null"; sub.preview = "null";
                                        } else if (typeof sv === "string" || typeof sv === "number" || typeof sv === "boolean" || typeof sv === "bigint") {
                                            sub.kindShort = "scalar"; sub.preview = String(sv).slice(0, 100);
                                        } else {
                                            const svcls = sv.class?.name ?? "";
                                            if (svcls.startsWith("RepeatedField") || svcls.startsWith("List")) {
                                                sub.kindShort = "list";
                                                try { sub.preview = `count=${sv.method("get_Count").invoke()}`; } catch { sub.preview = "list"; }
                                            } else if (svcls) {
                                                sub.kindShort = "object";
                                                try { sub.preview = summarize(sv, 1).slice(0, 120); } catch { sub.preview = svcls; }
                                            } else {
                                                sub.kindShort = "scalar"; sub.preview = String(sv).slice(0, 100);
                                            }
                                        }
                                    } catch (e) { sub.kindShort = "error"; sub.preview = String(e).slice(0, 80); }
                                    entry.subFields.push(sub);
                                }
                            }
                        } else {
                            entry.kind = "scalar";
                            entry.value = String(v);
                        }
                    }
                }
            } catch (e) {
                entry.kind = "error";
                entry.error = String(e).slice(0, 120);
            }
            out.fields.push(entry);
        }
    } catch {}
    return out;
}

/**
 * Arm a list of class names for deep capture. When the incoming hook next
 * sees an instance of any armed class, it stashes a full field dump into
 * `capturedDumps[cls]`. Useful for verifying preset aliases against real
 * runtime values (e.g. "does iso.efkv.Count == the interactives I see?").
 * Call `getCapturedDumps` to retrieve.
 */
export function armMessageCapture(classNames: string[]): Promise<number> {
    return inVm(() => {
        armedDumps.clear();
        capturedDumps.clear();
        for (const n of classNames) armedDumps.add(n);
        console.log(`[net] armed capture for ${classNames.length} classes: ${classNames.join(", ")}`);
        return classNames.length;
    });
}

/** Return all dumps captured since `armMessageCapture`. */
export function getCapturedDumps(): Promise<Record<string, DeepMessageDump>> {
    return inVm(() => {
        const out: Record<string, DeepMessageDump> = {};
        for (const [k, v] of capturedDumps) out[k] = v;
        return out;
    });
}

function extractMessageInfo(msg: any): { cls: string; name: string; fullName: string; fields: Record<string, string> } {
    let cls = "?", name = "?", fullName = "?";
    const fields: Record<string, string> = {};
    if (!msg) return { cls, name, fullName, fields };
    try { if (msg.class) cls = msg.class.name; } catch {}
    const cached = nameCache?.get(cls);
    if (cached) { name = cached.name; fullName = cached.fullName; }
    try {
        if (msg.class) {
            for (const f of msg.class.fields) {
                if (f.isStatic) continue;
                if (f.type.name === "Google.Protobuf.UnknownFieldSet") continue;
                try {
                    const v = msg.field(f.name).value;
                    // For each non-default field, produce a rich summary (1-2 levels deep)
                    const s = summarize(v, 2);
                    if (s === "null" || s === "0" || s === "false" || s === "\"\"" || s === "") continue;
                    fields[f.name] = s.slice(0, 400);
                } catch {}
            }
        }
    } catch {}
    return { cls, name, fullName, fields };
}

/**
 * Generic hook installer for IMessage-taking methods. Extracts the Nth param as the
 * protobuf message, emits a {type:'socket', direction} event, then calls original.
 *
 * - direction: "out" (outgoing send) or "in" (incoming receive)
 * - argIndex: which parameter is the IMessage (usually 0)
 */
function installSocketHook(
    className: string,
    methodName: string,
    direction: "in" | "out",
    argIndex: number = 0,
): string {
    const klass = findClass(className);
    if (!klass) throw new Error(`class ${className} not found`);
    const method = klass.tryMethod(methodName);
    if (!method) throw new Error(`method ${methodName} not found on ${className}`);

    method.implementation = function (this: any, ...args: any[]): any {
        try {
            const msg = args[argIndex];
            if (msg) {
                const info = extractMessageInfo(msg);
                send({ type: "socket", direction, ...info, ts: Date.now() });
                // Always cache monster groups from iso so the map panel gets fresh data
                // without requiring any arming.
                if (info.cls === "iso") { try { captureMonsterGroupsFromIso(msg); } catch {} }
                if (armedDumps.has(info.cls) && !capturedDumps.has(info.cls)) {
                    try { capturedDumps.set(info.cls, deepDumpMessage(msg)); } catch {}
                    try { captureIsoGroupData(info.cls, msg); } catch {}
                    try { maybeFullCapture(info.cls, msg); } catch {}
                }
            }
        } catch { /* never let hook instrumentation break the call */ }
        // Call original (Frida re-entry detection handles this)
        const self = this as Il2Cpp.Object;
        if (method.isStatic) {
            return klass.method(methodName).invoke(...args);
        }
        return self.method(methodName).invoke(...args);
    };
    console.log(`[net] hook installed: ${className}.${methodName} (${direction})`);
    return `hooked ${className}.${methodName}`;
}

/**
 * Outgoing capture — hook the game's send path. Default for Dofus Unity: ecu.xbe(IMessage).
 */
export function startNetworkCapture(sendClass: string = "ecu", sendMethod: string = "xbe"): Promise<string> {
    return inVm(() => {
        const resolved = resolveDescriptors();
        const result = installSocketHook(sendClass, sendMethod, "out", 0);
        return `${result} · ${resolved} protobuf types mapped`;
    });
}

/**
 * Variant hook: runs the original method, then reads the last element added to a List<Object>
 * output parameter. Used for DotNetty decoders that APPEND the decoded IMessage to an output list.
 * Default for Dofus Unity: fzk.Decode(ctx, gui, output) — outputIndex=2.
 */
function installSocketOutputHook(
    className: string,
    methodName: string,
    outputIndex: number = 2,
): string {
    const klass = findClass(className);
    if (!klass) throw new Error(`class ${className} not found`);
    const method = klass.tryMethod(methodName);
    if (!method) throw new Error(`method ${methodName} not found on ${className}`);

    method.implementation = function (this: any, ...args: any[]): any {
        const self = this as Il2Cpp.Object;
        // Record output list size before
        const outputList = args[outputIndex];
        let beforeCount = -1;
        try { if (outputList) beforeCount = outputList.method("get_Count").invoke() as number; } catch {}
        // Call original
        const result = method.isStatic
            ? klass.method(methodName).invoke(...args)
            : self.method(methodName).invoke(...args);
        // After: read newly added elements from output
        try {
            if (outputList && beforeCount >= 0) {
                const afterCount = outputList.method("get_Count").invoke() as number;
                for (let i = beforeCount; i < afterCount; i++) {
                    try {
                        let elem = outputList.method("get_Item").invoke(i) as any;
                        if (!elem || !elem.class) continue;

                        // Auto-unwrap GameMessage / GameRequest: extract the inner IMessage
                        // from whichever <dqef>k__BackingField / <bibh>k__BackingField / etc.
                        // holds it. Heuristic: if this elem has a field whose value is another
                        // Il2Cpp.Object whose class belongs to a protobuf namespace, unwrap.
                        if (elem.class.name === "GameMessage" || elem.class.name === "GameRequest") {
                            for (const f of elem.class.fields) {
                                if (f.isStatic) continue;
                                if (f.type.name !== "Google.Protobuf.IMessage") continue;
                                try {
                                    const inner = elem.field(f.name).value;
                                    if (inner && inner.class) { elem = inner; break; }
                                } catch {}
                            }
                        }

                        const info = extractMessageInfo(elem);
                        send({ type: "socket", direction: "in", ...info, ts: Date.now() });
                        if (armedDumps.has(info.cls) && !capturedDumps.has(info.cls)) {
                            try { capturedDumps.set(info.cls, deepDumpMessage(elem)); } catch {}
                            try { captureIsoGroupData(info.cls, elem); } catch {}
                            try { maybeFullCapture(info.cls, elem); } catch {}
                        }
                        // Always cache monster groups from iso (irrespective of armed state).
                        if (info.cls === "iso") { try { captureMonsterGroupsFromIso(elem); } catch {} }
                    } catch {}
                }
            }
        } catch {}
        return result;
    };
    console.log(`[net] output-hook installed: ${className}.${methodName} (outputIndex=${outputIndex})`);
    return `hooked ${className}.${methodName}`;
}

/**
 * Incoming capture — hook a method whose output list receives decoded IMessages.
 * Default for Dofus Unity: fzk.Decode(ctx, gui, List<Object> output) with outputIndex=2.
 *
 * Also works if you prefer a direct IMessage-param hook (e.g. GameMessage.biau) — pass
 * a smaller outputIndex and the code will still try to extract via args[outputIndex].
 * But beware: obfuscated simple setters may have shared code paths and fire for unrelated types.
 */
export function startIncomingCapture(
    recvClass: string = "fzk",
    recvMethod: string = "Decode",
    outputIndex: number = 2,
): Promise<string> {
    return inVm(() => {
        const resolved = resolveDescriptors();
        const result = installSocketOutputHook(recvClass, recvMethod, outputIndex);
        return `${result} · ${resolved} protobuf types mapped`;
    });
}

export function stopIncomingCapture(
    recvClass: string = "fzk",
    recvMethod: string = "Decode",
): Promise<string> {
    return inVm(() => {
        const klass = findClass(recvClass);
        if (!klass) throw new Error(`class ${recvClass} not found`);
        const method = klass.tryMethod(recvMethod);
        if (!method) throw new Error(`method not found`);
        method.revert();
        console.log(`[net] incoming hook reverted on ${recvClass}.${recvMethod}`);
        return "reverted";
    });
}

/** Test: resolve descriptor for a single class by name. Returns { found, name, fullName, reason } */
export function resolveProtobufName(className: string): Promise<any> {
    return inVm(() => {
        const k = findClass(className);
        if (!k) return { found: false, reason: "class not found" };
        // List all MessageDescriptor-returning methods
        const candidates: Array<{ name: string; isStatic: boolean; paramCount: number }> = [];
        for (const m of k.methods) {
            if (m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") {
                candidates.push({ name: m.name, isStatic: m.isStatic, paramCount: m.parameters.length });
            }
        }
        if (candidates.length === 0) return { found: false, reason: "no MessageDescriptor-returning method", methodCount: k.methods.length };
        // Try the first static no-arg one
        const staticGetter = k.methods.find(m => m.isStatic && m.parameters.length === 0 && m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor");
        if (!staticGetter) return { found: false, reason: "no static no-arg getter", candidates };
        try {
            const desc = staticGetter.invoke() as Il2Cpp.Object;
            if (!desc) return { found: false, reason: "getter returned null", candidates };
            const name = stringifyValue(desc.method("get_Name").invoke()).replace(/^"|"$/g, "");
            const fullName = stringifyValue(desc.method("get_FullName").invoke()).replace(/^"|"$/g, "");
            return { found: true, name, fullName, candidates };
        } catch (e) {
            return { found: false, reason: `invoke err: ${e}`, candidates };
        }
    });
}

/** Sample the descriptor cache (for debugging): which protobuf types resolved successfully */
export function sampleResolvedProtobufs(): Promise<string[]> {
    return inVm(() => {
        const out: string[] = [];
        let count = 0;
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    const staticGetter = k.methods.find(m => m.isStatic && m.parameters.length === 0 && m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor");
                    if (!staticGetter) continue;
                    try {
                        const desc = staticGetter.invoke() as Il2Cpp.Object;
                        if (!desc) continue;
                        const fullName = stringifyValue(desc.method("get_FullName").invoke()).replace(/^"|"$/g, "");
                        out.push(`${k.name} → ${fullName}`);
                        count++;
                        if (count >= 30) return out;
                    } catch {}
                }
            } catch {}
        }
        return out;
    });
}

export function stopNetworkCapture(sendClass: string = "ecu", sendMethod: string = "xbe"): Promise<string> {
    return inVm(() => {
        const klass = findClass(sendClass);
        if (!klass) throw new Error(`class ${sendClass} not found`);
        const method = klass.tryMethod(sendMethod);
        if (!method) throw new Error(`method not found`);
        method.revert();
        console.log(`[net] capture reverted on ${sendClass}.${sendMethod}`);
        return "reverted";
    });
}

// -----------------------------------------------------------------------------
// Protobuf signature extraction — survives Dofus renames.
// -----------------------------------------------------------------------------
// A signature is a canonical, recursive description of a protobuf message built
// purely from the wire-protocol reflection data (Google.Protobuf.Reflection):
//   - tag numbers (immutable — part of the wire format)
//   - scalar field types (bool, int64, …)
//   - repeated / map wrappers
//   - enum *value counts* (stable within a build)
//   - recursively: nested message types (as their own signatures, up to depth N)
//
// Two classes with identical signatures describe the same proto schema — so
// even when Ankama rotates obfuscated class names, we can re-match
// readable→current-cls by computing signatures of all protobuf classes and
// looking them up in the preset.

// Map common .NET type names to compact proto-style abbreviations.
const SCALAR_ABBR: Record<string, string> = {
    "System.Boolean": "b",
    "System.Byte":    "u8",
    "System.SByte":   "i8",
    "System.Int16":   "i16",
    "System.UInt16":  "u16",
    "System.Int32":   "i32",
    "System.UInt32":  "u32",
    "System.Int64":   "i64",
    "System.UInt64":  "u64",
    "System.Single":  "f32",
    "System.Double":  "f64",
    "System.String":  "s",
    "System.Byte[]":  "by",
    "Google.Protobuf.ByteString": "by",
};

function hasDescriptorGetter(k: Il2Cpp.Class): boolean {
    for (const m of k.methods) {
        if (m.isStatic && m.parameters.length === 0 &&
            m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") return true;
    }
    return false;
}

function extractGenericInner(typeName: string): string | null {
    // Frida surfaces generics in two shapes depending on the bridge version:
    //   "Google.Protobuf.Collections.RepeatedField`1<System.Int32>"
    //   "Google.Protobuf.Collections.RepeatedField<System.Int32>"
    const a = typeName.indexOf("<");
    const b = typeName.lastIndexOf(">");
    if (a === -1 || b === -1 || b <= a) return null;
    return typeName.slice(a + 1, b);
}

/**
 * Compute the canonical signature of a protobuf class via pure IL2CPP
 * introspection (no Descriptor.invoke required — Ankama's Game protocol
 * descriptors throw when invoked, so we can't rely on them).
 *
 * Signature shape: `t[<sorted tags>]f[<type1>,<type2>,…]` where types are in
 * instance-field declaration order (which matches proto tag order for
 * Google.Protobuf-generated code).
 *
 *   tags  come from static System.Int32 constants (the `XxxFieldNumber` or
 *         obfuscated single-name statics — their *values* are the .proto
 *         wire tags and are immutable per build).
 *   types describe each instance field's wire shape, recursing into nested
 *         protobuf messages up to `depth` levels (cycles emit `{cyc}`).
 */
function signatureFor(klass: Il2Cpp.Class, depth: number, visited: Set<string>): string {
    if (!klass) return "";
    if (visited.has(klass.name)) return "{cyc}";
    visited = new Set(visited);
    visited.add(klass.name);

    if (!hasDescriptorGetter(klass)) return "";

    // Collect tag values from static Int32 constants. Filter to plausible
    // proto tag range (1 .. 2^29-1).
    const tags: number[] = [];
    try { (klass as any).initialize?.(); } catch {}
    for (const f of klass.fields) {
        if (!f.isStatic) continue;
        if (f.type.name !== "System.Int32") continue;
        try {
            const v = f.value as number;
            if (typeof v === "number" && v > 0 && v < (1 << 29)) tags.push(v);
        } catch {}
    }
    tags.sort((a, b) => a - b);

    // Iterate instance fields in declaration order.
    const parts: string[] = [];
    for (const f of klass.fields) {
        if (f.isStatic) continue;
        if (f.type.name === "Google.Protobuf.UnknownFieldSet") continue;
        parts.push(encodeFieldType(f.type, depth, visited));
    }

    return `t[${tags.join(",")}]f[${parts.join(",")}]`;
}

function encodeFieldType(type: Il2Cpp.Type, depth: number, visited: Set<string>): string {
    const name = type.name;
    const scalar = SCALAR_ABBR[name];
    if (scalar) return scalar;

    if (name.startsWith("Google.Protobuf.Collections.RepeatedField")) {
        const inner = extractGenericInner(name);
        if (!inner) return "R?";
        return `R${encodeFieldTypeByName(inner, depth, visited)}`;
    }
    if (name.startsWith("Google.Protobuf.Collections.MapField")) {
        const inner = extractGenericInner(name);
        if (!inner) return "M?";
        // MapField<K,V> — split top-level comma
        const parts = splitTopLevelComma(inner);
        if (parts.length !== 2) return "M?";
        return `M(${encodeFieldTypeByName(parts[0], depth, visited)},${encodeFieldTypeByName(parts[1], depth, visited)})`;
    }

    // Likely an enum or a nested protobuf message — resolve via its class.
    return encodeFieldTypeByName(name, depth, visited);
}

function encodeFieldTypeByName(name: string, depth: number, visited: Set<string>): string {
    const scalar = SCALAR_ABBR[name];
    if (scalar) return scalar;

    // Short-name lookup (class registry keys by class.name).
    const shortName = name.split(".").pop()!.replace(/`\d+$/, "");
    const k = findClass(shortName);
    if (!k) return "?";

    // Protobuf-shaped message — inline or opaque "m" based on depth.
    if (hasDescriptorGetter(k)) {
        if (depth <= 0) return "m";
        return `m{${signatureFor(k, depth - 1, visited)}}`;
    }

    // Enum: parent class is System.Enum; count static value fields.
    try {
        const parentName = k.parent?.name ?? "";
        if (parentName === "Enum") {
            let ecount = 0;
            for (const f of k.fields) if (f.isStatic) ecount++;
            return `e[${ecount}]`;
        }
    } catch {}

    return "?";
}

function splitTopLevelComma(s: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "<") depth++;
        else if (c === ">") depth--;
        else if (c === "," && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out;
}

/**
 * Stable 16-char FNV-1a hex fingerprint of a signature string. Used to give
 * compact, comparable identifiers in presets.
 */
function fingerprint(sig: string): string {
    // 64-bit FNV-1a (via two 32-bit halves) for slightly better collision
    // resistance than plain 32-bit, still cheap to compute.
    let h1 = 0x811c9dc5 | 0, h2 = 0x1000193 | 0;
    for (let i = 0; i < sig.length; i++) {
        const c = sig.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 16777619) | 0;
        h2 ^= (c * 31) | 0;
        h2 = Math.imul(h2, 2166136261) | 0;
    }
    const u1 = (h1 >>> 0).toString(16).padStart(8, "0");
    const u2 = (h2 >>> 0).toString(16).padStart(8, "0");
    return u1 + u2;
}

/**
 * Compute the signature of a single protobuf class by name. Mostly for
 * debugging / preset-building from the UI.
 */
export function extractProtobufSignature(className: string, depth: number = 3): Promise<{ cls: string; signature: string; fingerprint: string } | null> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) return null;
        const sig = signatureFor(klass, depth, new Set());
        if (!sig) return null;
        return { cls: className, signature: sig, fingerprint: fingerprint(sig) };
    });
}

/**
 * Walk every class that looks like a protobuf message, compute its signature,
 * and return a list of entries. Used once (typically by the preset updater) to
 * produce signatures for every known readable name.
 */
export function dumpAllSignatures(depth: number = 3): Promise<Array<{ cls: string; name: string; fullName: string; signature: string; fingerprint: string }>> {
    return inVm(() => {
        resolveDescriptors();
        const out: Array<{ cls: string; name: string; fullName: string; signature: string; fingerprint: string }> = [];
        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    let hasGetter = false;
                    for (const m of k.methods) {
                        if (m.isStatic && m.parameters.length === 0 &&
                            m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") {
                            hasGetter = true; break;
                        }
                    }
                    if (!hasGetter) continue;
                    try {
                        const sig = signatureFor(k, depth, new Set());
                        if (!sig) continue;
                        const cached = nameCache?.get(k.name);
                        out.push({
                            cls: k.name,
                            name: cached?.name ?? "?",
                            fullName: cached?.fullName ?? "?",
                            signature: sig,
                            fingerprint: fingerprint(sig),
                        });
                    } catch {}
                }
            } catch {}
        }
        console.log(`[net] dumped ${out.length} protobuf signatures`);
        return out;
    });
}

/**
 * Given a preset-style mapping `{ readable: signature }`, walk the current
 * runtime, compute each class's signature, and return the fresh reverse map
 * `{ currentObfCls: { readable, signature, fingerprint, ambiguous? } }`.
 *
 * When multiple classes share the same signature (rare), every candidate is
 * returned with `ambiguous: true` so the UI can flag manually.
 */
// -----------------------------------------------------------------------------
// Runtime-class field signatures — survive Dofus field-name rotation.
// -----------------------------------------------------------------------------
// Unlike protobuf (where the wire layout is immutable), non-protobuf classes
// only have the class NAME as a stable anchor (when the game is debug-free).
// The obfuscated FIELD NAMES inside rotate across Ankama builds.
//
// Our mitigation: snapshot the full field list of key runtime classes into
// the preset (name, type, static-flag, declaration index). When the obf names
// rotate, a future refresh can compare the snapshot to the fresh class dump
// and rebind name→readable by matching on (type, neighbor-types, index).

export interface RuntimeFieldEntry {
    name: string;
    type: string;
    isStatic: boolean;
    index: number;
}

export interface RuntimeClassSnapshot {
    cls: string;
    classFingerprint: string;
    fields: RuntimeFieldEntry[];
}

/**
 * Dump the full field list of a class (stable or obfuscated) into a form we
 * can persist and later match against a fresh dump. The `classFingerprint` is
 * a FNV-1a hash of the ordered `<static?>:<typeName>` list — if it matches on
 * a future build, the class shape is identical and field indexes are trusted.
 */
export function extractClassFields(className: string): Promise<RuntimeClassSnapshot | null> {
    return inVm(() => {
        const k = findClass(className);
        if (!k) return null;
        const fields: RuntimeFieldEntry[] = [];
        try {
            const list = k.fields as unknown as Il2Cpp.Field[];
            for (let i = 0; i < list.length; i++) {
                const f = list[i];
                fields.push({
                    name: f.name,
                    type: f.type.name,
                    isStatic: f.isStatic,
                    index: i,
                });
            }
        } catch {}
        const sig = fields.map(f => `${f.isStatic ? "s" : "i"}:${f.type}`).join(";");
        return { cls: className, classFingerprint: fingerprint(sig), fields };
    });
}

/**
 * Compute a "structural" fingerprint for a non-protobuf class — UI controllers,
 * wrappers, services. Used as a migration fallback when `extractProtobufSignature`
 * returns null (= class has no MessageDescriptor getter).
 *
 * Stability strategy: only features that survive an obf-name rotation are
 * counted. Specifically we keep types whose name contains a namespace dot
 * (`Core.*`, `System.*`, `Google.*`, `UnityEngine.*`, …) because those names
 * are baked into managed metadata and don't rotate. The class's role (and
 * thus the set of stable types it references) tends to be invariant between
 * patches even when its private fields/methods get shuffled.
 *
 * Format `S2:fc=N;mc=M;ft=[<typeHistogram>];ms=[<methodShapes>]`:
 *  - fc/mc : total field / method counts (any visibility)
 *  - ft    : sorted `Type*count` of stable-typed fields
 *  - ms    : sorted unique `i|s(p1,p2,…):ret` for methods touching ≥1 stable type
 *
 * Returns null if the class has zero stable types referenced (degenerate —
 * would collide too easily to be useful).
 */
export function extractStructuralSignature(className: string): Promise<{ cls: string; signature: string; fingerprint: string } | null> {
    return inVm(() => {
        const klass = findClassExact(className) ?? findClass(className);
        if (!klass) return null;

        const isStable = (t: string | undefined): boolean => !!t && t.includes(".");

        const ftCounts = new Map<string, number>();
        let fc = 0;
        for (const f of klass.fields) {
            fc++;
            try {
                const t = f.type.name;
                if (isStable(t)) ftCounts.set(t, (ftCounts.get(t) ?? 0) + 1);
            } catch {}
        }

        const methodShapes = new Set<string>();
        let mc = 0;
        for (const m of klass.methods) {
            mc++;
            try {
                const rt = m.returnType?.name ?? "?";
                const params = (m.parameters as Il2Cpp.Parameter[]).map((p) => p.type?.name ?? "?");
                const tokens = [rt, ...params];
                if (tokens.some(isStable)) {
                    methodShapes.add(`${m.isStatic ? "s" : "i"}(${params.join(",")}):${rt}`);
                }
            } catch {}
        }

        if (ftCounts.size === 0 && methodShapes.size === 0) return null;

        const ftStr = [...ftCounts.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([t, n]) => `${t}*${n}`).join("|");
        const msStr = [...methodShapes].sort().join("|");
        const sig = `S2:fc=${fc};mc=${mc};ft=[${ftStr}];ms=[${msStr}]`;
        return { cls: klass.name, signature: sig, fingerprint: fingerprint(sig) };
    });
}

export function matchSignatures(signatures: Record<string, string>, depth: number = 3): Promise<Record<string, { readable: string; signature: string; fingerprint: string; ambiguous?: true }>> {
    return inVm(() => {
        // Invert: signature → list of readable names that want it.
        const wantedBySig = new Map<string, string[]>();
        for (const [readable, sig] of Object.entries(signatures)) {
            if (!sig) continue;
            const arr = wantedBySig.get(sig) ?? [];
            arr.push(readable);
            wantedBySig.set(sig, arr);
        }
        const result: Record<string, { readable: string; signature: string; fingerprint: string; ambiguous?: true }> = {};
        // Also track how many classes match each signature to flag ambiguity.
        const classesBySig = new Map<string, string[]>();

        for (const asm of Il2Cpp.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    let hasGetter = false;
                    for (const m of k.methods) {
                        if (m.isStatic && m.parameters.length === 0 &&
                            m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") {
                            hasGetter = true; break;
                        }
                    }
                    if (!hasGetter) continue;
                    try {
                        const sig = signatureFor(k, depth, new Set());
                        if (!sig || !wantedBySig.has(sig)) continue;
                        const arr = classesBySig.get(sig) ?? [];
                        arr.push(k.name);
                        classesBySig.set(sig, arr);
                    } catch {}
                }
            } catch {}
        }

        for (const [sig, readables] of wantedBySig.entries()) {
            const clsList = classesBySig.get(sig) ?? [];
            const ambiguous = clsList.length > 1 || readables.length > 1;
            for (const cls of clsList) {
                // If multiple readables wanted the same sig, prefer the first.
                result[cls] = {
                    readable: readables[0],
                    signature: sig,
                    fingerprint: fingerprint(sig),
                    ...(ambiguous ? { ambiguous: true as const } : {}),
                };
            }
        }

        console.log(`[net] matched ${Object.keys(result).length}/${Object.keys(signatures).length} signatures`);
        return result;
    });
}
