// HTTP client for /api/* endpoints.
export async function rpcCall<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const res = await fetch("/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.result as T;
}

export async function listProcesses(filter?: string): Promise<Array<{ pid: number; name: string }>> {
    const url = filter ? `/api/processes?q=${encodeURIComponent(filter)}` : "/api/processes";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`processes: HTTP ${res.status}`);
    return res.json();
}

export async function attach(pid: number): Promise<{ pid: number; name: string }> {
    const res = await fetch("/api/attach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
}

export async function detach(): Promise<void> {
    const res = await fetch("/api/detach", { method: "POST" });
    if (!res.ok) throw new Error(`detach: HTTP ${res.status}`);
}

export async function reload(): Promise<{ pid: number; name: string }> {
    const res = await fetch("/api/reload", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
}

export async function status(): Promise<{ attached: boolean; info: { pid: number; name: string } | null }> {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
    return res.json();
}
