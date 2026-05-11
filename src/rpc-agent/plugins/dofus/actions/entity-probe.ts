// One-shot diagnostic: list every live `Core.Rendering.Entity.Entity`
// with its id (pil), cellId (pis) and the 4 boolean getters (pig/pih/pik/piq).
// Used once during reverse-engineering to identify which bool flag marks the
// local player's entity — the result feeds a stable read path in PlayerStore.

import { inVm } from "./_runtime";

export interface EntityProbeRow {
    handle: string;
    entityId: string;       // Int64 returned as string to avoid bridge truncation
    cellId: number | null;
    pig: boolean | null;
    pih: boolean | null;
    pik: boolean | null;
    piq: boolean | null;
}

export function probeAllEntities(): Promise<{ count: number; rows: EntityProbeRow[] }> {
    return inVm(() => {
        const Il2Cpp_ = Il2Cpp;  // local alias for type narrowing inside the perform callback
        let klass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp_.domain.assemblies) {
            try {
                for (const k of asm.image.classes) {
                    if (k.name === "Entity") {
                        const full = `${k.namespace ?? ""}.${k.name}`;
                        if (full === "Core.Rendering.Entity.Entity") { klass = k; break; }
                    }
                }
            } catch {}
            if (klass) break;
        }
        if (!klass) return { count: 0, rows: [] };

        const callInt = (inst: any, name: string): number | null => {
            try { return Number(inst.method(name).invoke()); } catch { return null; }
        };
        const callLong = (inst: any, name: string): string | null => {
            try { return String(inst.method(name).invoke()); } catch { return null; }
        };
        const callBool = (inst: any, name: string): boolean | null => {
            try { return Boolean(inst.method(name).invoke()); } catch { return null; }
        };

        const live = Il2Cpp_.gc.choose(klass);
        const rows: EntityProbeRow[] = [];
        for (const inst of live) {
            rows.push({
                handle: String((inst as any).handle),
                entityId: callLong(inst, "pil") ?? "?",
                cellId: callInt(inst, "pis"),
                pig: callBool(inst, "pig"),
                pih: callBool(inst, "pih"),
                pik: callBool(inst, "pik"),
                piq: callBool(inst, "piq"),
            });
        }
        return { count: rows.length, rows };
    });
}
