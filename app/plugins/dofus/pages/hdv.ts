import type { PluginPageContext } from "../../../frontend/core/plugin-types";

interface CraftIngredient {
    id: number; qty: number; name: string; iconId: number; unitPrice: number;
}
interface RankedRecipe {
    resultId: number; resultName: string; iconId: number;
    level: number; jobId: number; jobName: string; typeId: number;
    sell: number; cost: number; profit: number; ratio: number;
    ingredients: CraftIngredient[];
}
interface RankingResponse {
    ranking: RankedRecipe[];
    lastUpdate: number | null;
}

const ROW_LIMIT = 250;
type SortCol = "name" | "level" | "job" | "sell" | "cost" | "profit" | "ratio";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortCol; label: string; align: "left" | "right"; width?: string }[] = [
    { key: "name",   label: "Item",   align: "left" },
    { key: "level",  label: "Lvl",    align: "left",  width: "60px" },
    { key: "job",    label: "Métier", align: "left",  width: "140px" },
    { key: "sell",   label: "Vente",  align: "right", width: "120px" },
    { key: "cost",   label: "Coût",   align: "right", width: "120px" },
    { key: "profit", label: "Profit", align: "right", width: "140px" },
    { key: "ratio",  label: "%",      align: "right", width: "70px" },
];

let state = {
    ranking: [] as RankedRecipe[],
    lastUpdate: null as number | null,
    search: "",
    job: "all" as string,
    sortCol: "profit" as SortCol,
    sortDir: "desc" as SortDir,
};

function sortValue(r: RankedRecipe, col: SortCol): number | string {
    switch (col) {
        case "name":   return r.resultName.toLowerCase();
        case "level":  return r.level;
        case "job":    return r.jobName.toLowerCase();
        case "sell":   return r.sell;
        case "cost":   return r.cost;
        case "profit": return r.profit;
        case "ratio":  return r.ratio;
    }
}

function sortRows(rows: RankedRecipe[], col: SortCol, dir: SortDir): RankedRecipe[] {
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
        const va = sortValue(a, col);
        const vb = sortValue(b, col);
        if (typeof va === "string" && typeof vb === "string") return sign * va.localeCompare(vb);
        return sign * ((va as number) - (vb as number));
    });
}

function fmt(n: number): string { return n.toLocaleString("fr-FR"); }
function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function fmtAge(ts: number | null): string {
    if (!ts) return "never";
    const ageS = Math.floor((Date.now() - ts) / 1000);
    if (ageS < 60) return `${ageS}s ago`;
    if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
    return new Date(ts).toLocaleTimeString("fr-FR");
}

function uniqueJobs(rows: RankedRecipe[]): { id: number; name: string }[] {
    const m = new Map<number, string>();
    for (const r of rows) m.set(r.jobId, r.jobName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ id, name }));
}

function applyFilters(rows: RankedRecipe[]): RankedRecipe[] {
    const q = state.search.trim().toLowerCase();
    const job = state.job;
    let out = rows;
    if (job !== "all") {
        const jid = parseInt(job, 10);
        out = out.filter((r) => r.jobId === jid);
    }
    if (q) {
        out = out.filter((r) => r.resultName.toLowerCase().includes(q));
    }
    return sortRows(out, state.sortCol, state.sortDir);
}

function renderTable(host: HTMLElement, all: RankedRecipe[]): void {
    const filtered = applyFilters(all);
    const shown = filtered.slice(0, ROW_LIMIT);
    const totalCount = filtered.length;

    const headerCells = COLUMNS.map((c) => {
        const isActive = state.sortCol === c.key;
        const arrow = isActive ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
        const widthAttr = c.width ? `width:${c.width};` : "";
        const color = isActive ? "color:#fff" : "color:#aaa";
        return `<th data-sort="${c.key}" style="${widthAttr}padding:6px 8px;text-align:${c.align};cursor:pointer;user-select:none;${color}" title="Cliquer pour trier">${escapeHtml(c.label)}${arrow}</th>`;
    }).join("");

    host.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;color:#888;font-size:12px">
            <span>${shown.length} / ${totalCount} recettes${totalCount > ROW_LIMIT ? ` (limit ${ROW_LIMIT})` : ""}</span>
            <span style="margin-left:auto">total ${all.length}</span>
        </div>
        <div style="overflow:auto;flex:1;min-height:0;border:1px solid #333;border-radius:4px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead style="position:sticky;top:0;background:#181818;z-index:1">
                    <tr style="text-align:left">
                        <th style="padding:6px 8px;width:36px"></th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>
                    ${shown.map((r) => {
                        const ingTooltip = r.ingredients
                            .map((i) => `${i.qty}× ${i.name} @ ${fmt(i.unitPrice)}k`)
                            .join("\n");
                        const ratioPct = (r.ratio * 100).toFixed(0);
                        const profitColor = r.profit >= 0 ? "#4ade80" : "#f87171";
                        return `
                        <tr style="border-top:1px solid #222" title="${escapeHtml(ingTooltip)}">
                            <td style="padding:4px 8px"><img src="/api/dofus/items/icon/${r.iconId}.png" width="32" height="32" loading="lazy" style="display:block;background:#0a0a0a;border-radius:4px" onerror="this.style.visibility='hidden'"></td>
                            <td style="padding:4px 8px">${escapeHtml(r.resultName)}</td>
                            <td style="padding:4px 8px;color:#888">${r.level}</td>
                            <td style="padding:4px 8px;color:#aaa">${escapeHtml(r.jobName)}</td>
                            <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">${fmt(r.sell)}</td>
                            <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:#888">${fmt(r.cost)}</td>
                            <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;color:${profitColor}">${r.profit >= 0 ? "+" : ""}${fmt(r.profit)}</td>
                            <td style="padding:4px 8px;text-align:right;color:${profitColor}">${ratioPct}%</td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
        </div>
    `;
}

async function fetchRanking(): Promise<RankingResponse> {
    const r = await fetch("/api/dofus/craft/ranking");
    return r.json();
}

async function refreshRanking(): Promise<RankingResponse> {
    const r = await fetch("/api/dofus/craft/refresh", { method: "POST" });
    if (!r.ok) {
        const body = await r.text();
        throw new Error(`refresh failed (${r.status}): ${body.slice(0, 200)}`);
    }
    return r.json();
}

export async function mountHdvCraft(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    host.style.flex = "1";
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.minHeight = "0";

    host.innerHTML = `
        <div style="display:flex;flex-direction:column;flex:1;min-height:0;padding:12px;gap:10px">
            <div data-testid="hdv-toolbar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <input data-testid="hdv-search" type="search" placeholder="Rechercher un item craftable…" style="flex:1;min-width:240px;padding:6px 10px;background:#0a0a0a;border:1px solid #333;border-radius:4px;color:#eee;font-size:13px">
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#888">
                    Métier
                    <select data-testid="hdv-job" style="padding:4px 8px;background:#181818;border:1px solid #333;color:#eee;border-radius:4px"></select>
                </label>
                <button data-testid="hdv-refresh" style="padding:6px 12px;background:#1e3a8a;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:13px">Refresh</button>
                <span data-testid="hdv-meta" style="font-size:12px;color:#888"></span>
            </div>
            <div data-testid="hdv-table" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>
        </div>
    `;

    const tableHost = host.querySelector<HTMLElement>("[data-testid='hdv-table']")!;
    const meta = host.querySelector<HTMLElement>("[data-testid='hdv-meta']")!;
    const search = host.querySelector<HTMLInputElement>("[data-testid='hdv-search']")!;
    const jobSel = host.querySelector<HTMLSelectElement>("[data-testid='hdv-job']")!;
    const refreshBtn = host.querySelector<HTMLButtonElement>("[data-testid='hdv-refresh']")!;

    function renderAll(): void {
        meta.textContent = state.lastUpdate ? `mis à jour ${fmtAge(state.lastUpdate)} • ${state.ranking.length} recettes` : "jamais rafraîchi";
        renderTable(tableHost, state.ranking);
    }

    function renderJobOptions(): void {
        const jobs = uniqueJobs(state.ranking);
        jobSel.innerHTML = `<option value="all">Tous</option>` + jobs.map((j) => `<option value="${j.id}">${escapeHtml(j.name)}</option>`).join("");
        jobSel.value = state.job;
    }

    async function load(force: boolean): Promise<void> {
        try {
            const data = force ? await refreshRanking() : await fetchRanking();
            state.ranking = data.ranking ?? [];
            state.lastUpdate = data.lastUpdate;
            renderJobOptions();
            renderAll();
        } catch (e) {
            tableHost.innerHTML = `<div style="color:#f87171;padding:12px">${escapeHtml(String(e))}</div>`;
        }
    }

    search.addEventListener("input", () => { state.search = search.value; renderAll(); });
    jobSel.addEventListener("change", () => { state.job = jobSel.value; renderAll(); });

    // Header click → sort. Same column toggles asc/desc; new column resets
    // direction to a sensible default (desc for numbers, asc for text).
    tableHost.addEventListener("click", (e) => {
        const th = (e.target as HTMLElement).closest<HTMLElement>("[data-sort]");
        if (!th || !tableHost.contains(th)) return;
        const col = th.dataset.sort as SortCol;
        if (state.sortCol === col) {
            state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
            state.sortCol = col;
            state.sortDir = (col === "name" || col === "job") ? "asc" : "desc";
        }
        renderAll();
    });
    refreshBtn.addEventListener("click", async () => {
        const orig = refreshBtn.textContent;
        refreshBtn.disabled = true;
        refreshBtn.textContent = "Refresh… (10-15s)";
        await load(true);
        refreshBtn.textContent = orig;
        refreshBtn.disabled = false;
    });

    await load(false);
    if (state.ranking.length === 0 && state.lastUpdate === null) {
        meta.textContent = "Cliquer Refresh pour charger les recettes (premier scrape ~10s).";
    }
}
