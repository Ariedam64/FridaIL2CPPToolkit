// Dofus passive scrapers — read game memory without sending anything to the
// server. Used by the Trade Center craft profitability page.
//
//   scrapeRecipes()    → all RecipeData entries from RecipesDataRoot
//   scrapeAvgPrices()  → the full itemId → avgPrice map from the price service
//
// Both walk a Dictionary's `_entries` array directly to avoid per-entry RPC
// round-trips (the alternative would be ~20k calls).

import "frida-il2cpp-bridge";
import { findClass } from "../../../lib";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function readPrimitiveList(list: any): number[] {
    if (!list) return [];
    const out: number[] = [];

    // List<T>._items is T[] of capacity, List<T>._size is the real count.
    // Reading the backing array directly avoids the boxing that get_Item
    // does for primitive types like UInt32.
    let items: any = null;
    let size = -1;
    try {
        const sz = list.tryField?.("_size")?.value;
        if (typeof sz === "number") size = sz;
    } catch {}
    try {
        const arr = list.tryField?.("_items")?.value;
        if (arr && typeof arr.length === "number") items = arr;
    } catch {}

    if (size < 0) {
        try { size = Number(list.method("get_Count").invoke()); } catch { return out; }
    }

    if (items) {
        for (let i = 0; i < size; i++) {
            try { out.push(Number(items.get(i))); } catch { out.push(0); }
        }
    } else {
        try {
            const get = list.method("get_Item");
            for (let i = 0; i < size; i++) {
                try { out.push(Number(get.invoke(i))); } catch { out.push(0); }
            }
        } catch {}
    }
    return out;
}

interface RecipeDump {
    resultId: number;
    resultLevel: number;
    resultTypeId: number;
    jobId: number;
    skillId: number;
    ingredients: { id: number; qty: number }[];
}

interface ItemMeta {
    name: string;
    iconId: number;
}

interface ScrapeRecipesResult {
    count: number;
    recipes: RecipeDump[];
    /** itemId → { name, iconId } for every id referenced as result or ingredient. */
    itemMeta: Record<string, ItemMeta>;
    error?: string;
}

export function scrapeRecipes(): Promise<ScrapeRecipesResult> {
    return inVm(() => {
        const klass = findClass("Core.DataCenter.Metadata.Job.RecipesDataRoot");
        if (!klass) return { count: 0, recipes: [], itemMeta: {}, error: "RecipesDataRoot class not found" };

        const live = Il2Cpp.gc.choose(klass);
        if (!live.length) return { count: 0, recipes: [], itemMeta: {}, error: "no live RecipesDataRoot instance" };
        const root = live[0]!;

        const dict = (root as any).field("objectsById").value;
        if (!dict || (dict.handle as any)?.isNull?.()) {
            return { count: 0, recipes: [], itemMeta: {}, error: "objectsById is null" };
        }

        const entries = (dict as any).tryField?.("_entries")?.value
            ?? (dict as any).field("_entries").value;
        if (!entries) return { count: 0, recipes: [], itemMeta: {}, error: "no _entries on objectsById" };
        const entriesLen: number = entries.length;

        const recipes: RecipeDump[] = [];
        for (let i = 0; i < entriesLen; i++) {
            let entry: any;
            try { entry = entries.get(i); } catch { continue; }
            if (!entry) continue;

            let value: any;
            try { value = entry.field("value").value; } catch { continue; }
            if (!value || (value.handle as any)?.isNull?.()) continue;

            let resultId = 0;
            try { resultId = Number(value.field("resultId").value); } catch { continue; }
            if (!resultId) continue;

            let ingIdsList: any = null;
            let qtysList:   any = null;
            try { ingIdsList = value.field("ingredientIds").value; } catch {}
            try { qtysList   = value.field("quantities").value; } catch {}

            const ingIds = readPrimitiveList(ingIdsList);
            const qtys   = readPrimitiveList(qtysList);
            const ingredients: { id: number; qty: number }[] = [];
            for (let k = 0; k < ingIds.length; k++) {
                ingredients.push({ id: ingIds[k], qty: qtys[k] ?? 1 });
            }

            const safeIntField = (name: string): number => {
                try { return Number(value.field(name).value) || 0; } catch { return 0; }
            };

            recipes.push({
                resultId,
                resultLevel:  safeIntField("resultLevel"),
                resultTypeId: safeIntField("resultTypeId"),
                jobId:        safeIntField("jobId"),
                skillId:      safeIntField("skillId"),
                ingredients,
            });
        }

        // Resolve { name, iconId } for every id mentioned (result or ingredient).
        // ItemData.GetItemById is static, get_name() returns the localized string,
        // iconId is a direct field.
        const itemMeta: Record<string, ItemMeta> = {};
        const ids = new Set<number>();
        for (const r of recipes) {
            ids.add(r.resultId);
            for (const ing of r.ingredients) ids.add(ing.id);
        }
        const itemKlass = findClass("Core.DataCenter.Metadata.Item.ItemData");
        if (itemKlass) {
            try {
                const getById = (itemKlass as any).method("GetItemById") as Il2Cpp.Method<any>;
                for (const id of ids) {
                    try {
                        const item = getById.invoke(id);
                        if (!item || (item.handle as any)?.isNull?.()) continue;
                        let name = "";
                        try {
                            const raw = (item as any).method("get_name").invoke();
                            if (raw && typeof (raw as any).content === "string") {
                                name = (raw as any).content;
                            }
                        } catch {}
                        let iconId = 0;
                        try { iconId = Number((item as any).field("iconId").value) || 0; } catch {}
                        itemMeta[String(id)] = { name, iconId };
                    } catch { /* skip unknown id */ }
                }
            } catch {}
        }

        return { count: recipes.length, recipes, itemMeta };
    });
}

interface ScrapeAvgPricesResult {
    count: number;
    /** itemId (string keys for JSON portability) → avgPrice in kamas. */
    prices: Record<string, number>;
    error?: string;
}

export function scrapeAvgPrices(): Promise<ScrapeAvgPricesResult> {
    return inVm(() => {
        const klass = findClass("elx");
        if (!klass) return { count: 0, prices: {}, error: "elx class not found (price service may have been renamed)" };

        const live = Il2Cpp.gc.choose(klass);
        if (!live.length) return { count: 0, prices: {}, error: "no live elx instance (not connected to a server?)" };
        const svc = live[0]!;

        const dict = (svc as any).field("<dkmh>k__BackingField").value;
        if (!dict || (dict.handle as any)?.isNull?.()) {
            return { count: 0, prices: {}, error: "<dkmh>k__BackingField is null" };
        }

        const entries = (dict as any).tryField?.("_entries")?.value
            ?? (dict as any).field("_entries").value;
        if (!entries) return { count: 0, prices: {}, error: "no _entries on backing dict" };
        const entriesLen: number = entries.length;

        const prices: Record<string, number> = {};
        let count = 0;
        for (let i = 0; i < entriesLen; i++) {
            let entry: any;
            try { entry = entries.get(i); } catch { continue; }
            if (!entry) continue;

            let key: any, value: any;
            try { key   = entry.field("key").value; }   catch { continue; }
            try { value = entry.field("value").value; } catch { continue; }

            const k = Number(key);
            const v = Number(value);
            // Free hash slots have key==0 with a negative `next` chain. Rather
            // than checking that, we keep only entries with a valid avgPrice (>0).
            if (!Number.isFinite(v) || v <= 0) continue;
            prices[String(k)] = v;
            count++;
        }
        return { count, prices };
    });
}
