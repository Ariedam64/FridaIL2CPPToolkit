import * as fs from "node:fs";
import * as path from "node:path";

export interface CraftIngredient {
    id: number;
    qty: number;
    name: string;
    iconId: number;
    unitPrice: number;
}

export interface RankedRecipe {
    resultId: number;
    resultName: string;
    iconId: number;
    level: number;
    jobId: number;
    jobName: string;
    typeId: number;
    sell: number;
    cost: number;
    profit: number;
    ratio: number;
    ingredients: CraftIngredient[];
}

interface AgentRecipe {
    resultId: number;
    resultLevel: number;
    resultTypeId: number;
    jobId: number;
    skillId: number;
    ingredients: { id: number; qty: number }[];
}
interface ScrapeRecipesResult {
    count: number;
    recipes: AgentRecipe[];
    itemMeta: Record<string, { name: string; iconId: number }>;
    error?: string;
}
interface ScrapeAvgPricesResult {
    count: number;
    prices: Record<string, number>;
    error?: string;
}

interface FridaCallable {
    call<T>(method: string, args?: unknown[]): Promise<T>;
}

/** Loaded once at construction from the bundled JobsDataRoot static dump. */
function loadJobNames(jobsFilePath: string): Record<number, string> {
    const out: Record<number, string> = {};
    try {
        const raw = JSON.parse(fs.readFileSync(jobsFilePath, "utf-8")) as {
            items: Array<{ id: number; fields: { m_name?: string; nameId?: number } }>;
        };
        for (const it of raw.items ?? []) {
            const nm = it.fields?.m_name;
            if (typeof nm === "string" && nm.length > 0) out[it.id] = nm;
        }
    } catch { /* file missing or malformed → empty map */ }
    return out;
}

export class CraftRankingStore {
    private cache: { ranking: RankedRecipe[]; lastUpdate: number } | null = null;
    private inFlight: Promise<RankedRecipe[]> | null = null;
    private readonly jobNames: Record<number, string>;

    constructor(jobsFilePath: string) {
        this.jobNames = loadJobNames(jobsFilePath);
    }

    snapshot(): { ranking: RankedRecipe[]; lastUpdate: number } | null {
        return this.cache;
    }

    /** Refresh the cache. Concurrent calls share the same in-flight promise. */
    async refresh(client: FridaCallable): Promise<RankedRecipe[]> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.doRefresh(client).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    private async doRefresh(client: FridaCallable): Promise<RankedRecipe[]> {
        // The agent calls can take several seconds each — run sequentially to
        // avoid hammering Frida's RPC channel.
        const recipesResp = await client.call<ScrapeRecipesResult>("scrapeRecipes");
        if (recipesResp.error) throw new Error(`scrapeRecipes: ${recipesResp.error}`);
        const pricesResp = await client.call<ScrapeAvgPricesResult>("scrapeAvgPrices");
        if (pricesResp.error) throw new Error(`scrapeAvgPrices: ${pricesResp.error}`);

        const meta = recipesResp.itemMeta ?? {};
        const prices = new Map<number, number>();
        for (const [k, v] of Object.entries(pricesResp.prices)) {
            prices.set(parseInt(k, 10), v);
        }

        const ranking: RankedRecipe[] = [];
        for (const r of recipesResp.recipes) {
            const sell = prices.get(r.resultId);
            if (sell === undefined) continue;
            let cost = 0;
            let allPriced = true;
            for (const ing of r.ingredients) {
                const p = prices.get(ing.id);
                if (p === undefined) { allPriced = false; break; }
                cost += ing.qty * p;
            }
            if (!allPriced || cost <= 0) continue;
            const m = meta[String(r.resultId)] ?? { name: "?", iconId: 0 };
            ranking.push({
                resultId: r.resultId,
                resultName: m.name,
                iconId: m.iconId,
                level: r.resultLevel,
                jobId: r.jobId,
                jobName: this.jobNames[r.jobId] ?? `Métier ${r.jobId}`,
                typeId: r.resultTypeId,
                sell, cost,
                profit: sell - cost,
                ratio: (sell - cost) / cost,
                ingredients: r.ingredients.map((ing) => {
                    const im = meta[String(ing.id)] ?? { name: "?", iconId: 0 };
                    return {
                        id: ing.id, qty: ing.qty,
                        name: im.name, iconId: im.iconId,
                        unitPrice: prices.get(ing.id) ?? 0,
                    };
                }),
            });
        }
        ranking.sort((a, b) => b.profit - a.profit);
        this.cache = { ranking, lastUpdate: Date.now() };
        return ranking;
    }
}

/** Default location of the static jobs dump (used by tests + production). */
export function defaultJobsFilePath(): string {
    return path.resolve(process.cwd(), "..", ".toolkit-data", "datacenter", "JobsDataRoot.json");
}
