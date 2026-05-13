#!/usr/bin/env tsx
// Build the canonical Dofus static DB by joining datacenter dumps with i18n
// resolution from the live agent.
//
// Run: npm run dofus:build-static-db (from app/) — requires Dofus attached.
//
// Output: app/plugins/dofus/data/static-db.json
//   {
//     "interactives": { typeId: { name } },
//     "skills":       { skillId: { name, jobId, jobName, gatheredItem?, elementActionId, levelMin } },
//     "items":        { itemId: { name } },
//     "jobs":         { jobId: { name } }
//   }
//
// gfxIds and the skill→typeId binding are LEFT EMPTY here — the runtime patcher
// (phase B) fills them by cross-referencing live `itx.eftt` frames with each
// map's static `ie` triples. This script handles only the parts that can be
// derived purely from datacenter + i18n (no runtime sampling needed).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _DIR = path.dirname(fileURLToPath(import.meta.url));
const DC_DIR = path.resolve(_DIR, "../data/_build-inputs/datacenter");
const OUT_FILE = path.resolve(_DIR, "../data/static-db.json");

const TOOLKIT_API = process.env.TOOLKIT_API ?? "http://localhost:3001";
const I18N_CONCURRENCY = 16;

interface DcWrapper<T> {
    items: Array<{ id: number; fields: T }>;
}

interface InteractiveFields { id: number; nameId: number }
interface SkillFields {
    id: number; nameId: number; parentJobId: number; isForgemagus?: boolean;
    gatheredRessourceItem?: number; elementActionId?: number; levelMin?: number;
}
interface ItemFields { id: number; nameId: number; typeId?: number }
interface JobFields { id: number; nameId: number }

function readDc<T>(name: string): Array<{ id: number; fields: T }> {
    // JobsDataRoot doubles as runtime plugin data (loaded by CraftRankingStore
    // at server start), so its canonical home is data/jobs-data-root.json.
    // The other DataRoots are build-time intermediates under _build-inputs/.
    const file = name === "JobsDataRoot"
        ? path.resolve(_DIR, "../data/jobs-data-root.json")
        : path.join(DC_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`missing datacenter dump: ${file}\nRun the agent's datacenter dumper first.`);
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as DcWrapper<T>;
    return raw.items ?? [];
}

async function callRpc<T>(method: string, args: unknown[]): Promise<T> {
    const r = await fetch(`${TOOLKIT_API}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`RPC ${method} failed: HTTP ${r.status} ${body}`);
    }
    const json = await r.json() as { result?: T; error?: string };
    if (json.error) throw new Error(`RPC ${method} error: ${json.error}`);
    return json.result as T;
}

/** Strip the surrounding quotes the agent adds around C# string returns. */
function unquote(s: string): string {
    return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** Resolve a single nameId via the live agent. Returns the empty string on
 *  failure so the caller can decide how to render missing names. */
async function resolveName(nameId: number): Promise<string> {
    try {
        const r = await callRpc<string>("callStaticOverload", [
            "Core.Localization.LocalizedStringUtilities",
            "GetLocalized",
            ["System.Int32"],
            [nameId],
        ]);
        return unquote(typeof r === "string" ? r : String(r));
    } catch {
        return "";
    }
}

/** Resolve many nameIds in parallel, capped at I18N_CONCURRENCY in flight. */
async function resolveAll(nameIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const queue = [...new Set(nameIds)];
    let inFlight = 0;
    let done = 0;
    const total = queue.length;
    return new Promise<Map<number, string>>((resolve, reject) => {
        const next = () => {
            if (queue.length === 0 && inFlight === 0) {
                resolve(out);
                return;
            }
            while (inFlight < I18N_CONCURRENCY && queue.length > 0) {
                const id = queue.shift()!;
                inFlight++;
                resolveName(id)
                    .then((name) => { out.set(id, name); })
                    .catch((e) => reject(e))
                    .finally(() => {
                        inFlight--;
                        done++;
                        if (done % 100 === 0 || done === total) {
                            process.stdout.write(`\r  resolved ${done}/${total} names`);
                        }
                        next();
                    });
            }
        };
        next();
    });
}

async function main(): Promise<void> {
    console.log("Reading datacenter dumps from", DC_DIR);
    const interactives = readDc<InteractiveFields>("InteractivesDataRoot");
    const skills = readDc<SkillFields>("SkillsDataRoot");
    const items = readDc<ItemFields>("ItemsDataRoot");
    const jobs = readDc<JobFields>("JobsDataRoot");
    console.log(`  ${interactives.length} interactives, ${skills.length} skills, ${items.length} items, ${jobs.length} jobs`);

    // Collect every nameId we'll need. Items only matter when referenced as
    // a skill's gatheredRessourceItem — full 17k items would resolve a lot of
    // unused names.
    const referencedItemIds = new Set<number>();
    for (const s of skills) {
        const it = s.fields.gatheredRessourceItem;
        if (typeof it === "number" && it > 0) referencedItemIds.add(it);
    }
    const itemById = new Map<number, ItemFields>();
    for (const it of items) itemById.set(it.id, it.fields);

    const nameIdsToResolve: number[] = [];
    for (const i of interactives) nameIdsToResolve.push(i.fields.nameId);
    for (const s of skills) nameIdsToResolve.push(s.fields.nameId);
    for (const j of jobs) nameIdsToResolve.push(j.fields.nameId);
    for (const itemId of referencedItemIds) {
        const it = itemById.get(itemId);
        if (it) nameIdsToResolve.push(it.nameId);
    }

    console.log(`Resolving ${new Set(nameIdsToResolve).size} unique nameIds via ${TOOLKIT_API}...`);
    const names = await resolveAll(nameIdsToResolve);
    process.stdout.write("\n");

    const lookupName = (nameId: number, fallbackId: number, kind: string): string => {
        const n = names.get(nameId);
        return n && n.length > 0 ? n : `<${kind} #${fallbackId}>`;
    };

    // -- Build job lookup first, so we can attach jobName on each skill.
    const jobOut: Record<string, { name: string }> = {};
    const jobName = new Map<number, string>();
    for (const j of jobs) {
        const nm = lookupName(j.fields.nameId, j.id, "job");
        jobOut[String(j.id)] = { name: nm };
        jobName.set(j.id, nm);
    }

    // -- Items (only those referenced by skills).
    const itemOut: Record<string, { name: string }> = {};
    for (const itemId of referencedItemIds) {
        const it = itemById.get(itemId);
        if (!it) continue;
        itemOut[String(itemId)] = { name: lookupName(it.nameId, itemId, "item") };
    }

    // -- Skills.
    interface SkillEntry {
        name: string;
        jobId: number;
        jobName: string;
        gatheredItem?: { id: number; name: string };
        elementActionId?: number;
        levelMin?: number;
    }
    const skillOut: Record<string, SkillEntry> = {};
    for (const s of skills) {
        const f = s.fields;
        const entry: SkillEntry = {
            name: lookupName(f.nameId, s.id, "skill"),
            jobId: f.parentJobId,
            jobName: jobName.get(f.parentJobId) ?? `<job #${f.parentJobId}>`,
            elementActionId: f.elementActionId,
            levelMin: f.levelMin,
        };
        const it = f.gatheredRessourceItem;
        if (typeof it === "number" && it > 0 && itemOut[String(it)]) {
            entry.gatheredItem = { id: it, name: itemOut[String(it)].name };
        }
        skillOut[String(s.id)] = entry;
    }

    // -- Interactives.
    const interactiveOut: Record<string, { name: string }> = {};
    for (const i of interactives) {
        interactiveOut[String(i.id)] = {
            name: lookupName(i.fields.nameId, i.id, "interactive"),
        };
    }

    const db = {
        version: 1,
        generatedAt: new Date().toISOString(),
        source: { datacenter: DC_DIR, i18n: TOOLKIT_API },
        interactives: interactiveOut,
        skills: skillOut,
        items: itemOut,
        jobs: jobOut,
    };

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(db, null, 2), "utf-8");
    const resolvedCount = [...names.values()].filter((s) => s.length > 0).length;
    console.log(`\n→ Wrote ${OUT_FILE}`);
    console.log(`   ${Object.keys(interactiveOut).length} interactives, ${Object.keys(skillOut).length} skills, ${Object.keys(itemOut).length} items, ${Object.keys(jobOut).length} jobs`);
    console.log(`   ${resolvedCount}/${names.size} names successfully resolved (${names.size - resolvedCount} fell back to placeholders)`);
}

main().catch((e) => {
    console.error("\nFAILED:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
});
