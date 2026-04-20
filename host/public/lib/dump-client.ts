// Client-side helper: POST markdown content to /api/dumps and log the result.
import { logRpcLine } from "../panels/logs.js";

export async function saveDumpToFile(content: string, meta: { name?: string; ext?: string } = {}): Promise<void> {
    const res = await fetch("/api/dumps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, meta }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`/api/dumps ${res.status}: ${text}`);
    }
    const data = await res.json() as { path: string; size: number; name: string };
    logRpcLine(`[dump] saved → ${data.path} (${data.size} bytes)`);
}
