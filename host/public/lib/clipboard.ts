// Copy-for-Claude helpers. Produces compact markdown that fits the chat well.
export async function copyMarkdown(md: string, flash?: HTMLElement): Promise<void> {
    try {
        await navigator.clipboard.writeText(md);
        if (flash) {
            const prev = flash.textContent;
            flash.textContent = "✓ copied";
            setTimeout(() => { flash.textContent = prev; }, 1200);
        }
    } catch (e) {
        console.error("[clipboard] failed", e);
        alert("clipboard write failed: " + String(e));
    }
}

export function formatLogSession(entries: Array<{ ts: string; cls: string; text: string }>, limit = 50): string {
    const tail = entries.slice(-limit);
    const lines: string[] = [];
    lines.push("# Toolkit session log (tail)");
    lines.push("");
    lines.push("```text");
    for (const e of tail) lines.push(`[${e.ts}] [${e.cls}] ${e.text}`);
    lines.push("```");
    return lines.join("\n");
}

export function formatWatchlist(readouts: Array<{ label: string; value: string; delta?: string }>): string {
    const lines: string[] = [];
    lines.push("# Watchlist snapshot");
    lines.push("");
    lines.push("| field | value | Δ |");
    lines.push("|---|---|---|");
    for (const r of readouts) lines.push(`| \`${r.label}\` | \`${r.value}\` | ${r.delta ?? ""} |`);
    return lines.join("\n");
}
