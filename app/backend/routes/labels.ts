// app/backend/routes/labels.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import type { LabelKey } from "../core/types.js";

export interface LabelsDeps { session: Session; }

function ensureProfile(deps: LabelsDeps) {
    return deps.session.profile();
}

function buildKey(kind: "class" | "method" | "field", raw: any): LabelKey | null {
    if (!raw || typeof raw !== "object") return null;
    if (kind === "class") {
        if (typeof raw.className !== "string") return null;
        return { kind, className: raw.className };
    }
    if (kind === "method") {
        if (typeof raw.className !== "string" || typeof raw.methodName !== "string") return null;
        return { kind, className: raw.className, methodName: raw.methodName };
    }
    if (typeof raw.className !== "string" || typeof raw.fieldName !== "string") return null;
    return { kind, className: raw.className, fieldName: raw.fieldName };
}

export function mountLabels(app: Express, deps: LabelsDeps): void {
    app.get("/api/labels", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        res.json(p.labels.bulkExport());
    });

    for (const kind of ["class", "method", "field"] as const) {
        app.post(`/api/labels/${kind}`, async (req, res) => {
            const p = ensureProfile(deps);
            if (!p) { res.status(503).json({ error: "not attached" }); return; }
            const key = buildKey(kind, req.body?.key);
            if (!key) { res.status(400).json({ error: "invalid key" }); return; }
            if (req.body?.remove === true) {
                p.labels.remove(key);
            } else {
                if (typeof req.body?.label !== "string" || req.body.label.length === 0) {
                    res.status(400).json({ error: "label required" });
                    return;
                }
                // Capture a structural fingerprint at rename time so the
                // migration engine can re-link this label after a game update
                // even if the obfuscated name changes. Best-effort — failure
                // doesn't block the rename.
                let sig: { signature?: string; fingerprint?: string } | undefined;
                if (deps.session.fridaClient.isAttached()) {
                    try {
                        if (kind === "class") {
                            const r = await deps.session.fridaClient.call<{ cls: string; signature: string; fingerprint: string } | null>(
                                "extractProtobufSignature", [key.className, 3],
                            );
                            if (r && r.signature) sig = { signature: r.signature, fingerprint: r.fingerprint };
                        } else {
                            // For fields and methods we extract from the parent
                            // class dump. A field's signature is its typeName;
                            // a method's signature is "(paramTypes):returnType".
                            const dump = await deps.session.fridaClient.call<string>(
                                "dumpClassAsString", [(key as { className: string }).className],
                            );
                            if (kind === "field") {
                                // Field lines look like "- <type> <name>"
                                const target = (key as { fieldName: string }).fieldName;
                                const m = dump.match(new RegExp(`^[-*]\\s+(\\S.*?)\\s+${target}\\s*$`, "m"));
                                if (m) sig = { signature: m[1], fingerprint: m[1].slice(0, 32) };
                            } else {
                                // Method lines look like "- <return> <name>(<params>)" or "static ..."
                                const target = (key as { methodName: string }).methodName;
                                const re = new RegExp(`^[-*]\\s+(?:static\\s+)?(\\S.*?)\\s+${target}\\(([^)]*)\\)`, "m");
                                const m = dump.match(re);
                                if (m) {
                                    const signature = `(${m[2]}):${m[1]}`;
                                    sig = { signature, fingerprint: signature.slice(0, 32) };
                                }
                            }
                        }
                    } catch { /* signature capture is best-effort */ }
                }
                p.labels.set(key, req.body.label, sig);
            }
            p.labels.scheduleFlush();
            res.json({ ok: true });
        });
    }

    /**
     * Backfill: iterate every existing label that has no signature yet and
     * compute one from the live agent. Useful after enabling the
     * signature-on-rename feature on a profile that was renamed before.
     */
    app.post("/api/labels/backfill-signatures", async (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        if (!deps.session.fridaClient.isAttached()) {
            res.status(503).json({ error: "agent not attached — open the game and attach first" });
            return;
        }
        const dump = p.labels.bulkExport();
        const stats = { classes: { ok: 0, skipped: 0, failed: 0 },
                        fields:  { ok: 0, skipped: 0, failed: 0 },
                        methods: { ok: 0, skipped: 0, failed: 0 } };
        // Cache of class dumps so we only call the agent once per class.
        const dumpCache = new Map<string, string>();
        async function getDump(cn: string): Promise<string | null> {
            if (dumpCache.has(cn)) return dumpCache.get(cn)!;
            try {
                const s = await deps.session.fridaClient.call<string>("dumpClassAsString", [cn]);
                dumpCache.set(cn, s);
                return s;
            } catch { return null; }
        }

        for (const [className, entry] of Object.entries(dump.classes ?? {})) {
            if (entry.signature) { stats.classes.skipped++; continue; }
            try {
                const r = await deps.session.fridaClient.call<{ cls: string; signature: string; fingerprint: string } | null>(
                    "extractProtobufSignature", [className, 3],
                );
                if (r?.signature) {
                    p.labels.decorate({ kind: "class", className }, { signature: r.signature, fingerprint: r.fingerprint });
                    stats.classes.ok++;
                } else { stats.classes.failed++; }
            } catch { stats.classes.failed++; }
        }
        for (const [k, entry] of Object.entries(dump.fields ?? {})) {
            if (entry.signature) { stats.fields.skipped++; continue; }
            const dot = k.indexOf(".");
            if (dot < 0) { stats.fields.failed++; continue; }
            const className = k.slice(0, dot);
            const fieldName = k.slice(dot + 1);
            const cd = await getDump(className);
            if (!cd) { stats.fields.failed++; continue; }
            const m = cd.match(new RegExp(`^[-*]\\s+(\\S.*?)\\s+${fieldName}\\s*$`, "m"));
            if (m) {
                p.labels.decorate({ kind: "field", className, fieldName }, { signature: m[1], fingerprint: m[1].slice(0, 32) });
                stats.fields.ok++;
            } else { stats.fields.failed++; }
        }
        for (const [k, entry] of Object.entries(dump.methods ?? {})) {
            if (entry.signature) { stats.methods.skipped++; continue; }
            const dot = k.indexOf(".");
            if (dot < 0) { stats.methods.failed++; continue; }
            const className = k.slice(0, dot);
            const methodName = k.slice(dot + 1);
            const cd = await getDump(className);
            if (!cd) { stats.methods.failed++; continue; }
            const re = new RegExp(`^[-*]\\s+(?:static\\s+)?(\\S.*?)\\s+${methodName}\\(([^)]*)\\)`, "m");
            const m = cd.match(re);
            if (m) {
                const sig = `(${m[2]}):${m[1]}`;
                p.labels.decorate({ kind: "method", className, methodName }, { signature: sig, fingerprint: sig.slice(0, 32) });
                stats.methods.ok++;
            } else { stats.methods.failed++; }
        }
        p.labels.scheduleFlush();
        res.json({ ok: true, ...stats });
    });

    app.post("/api/labels/undo", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const ok = p.labels.undo();
        if (ok) p.labels.scheduleFlush();
        res.json({ ok });
    });

    app.post("/api/labels/redo", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const ok = p.labels.redo();
        if (ok) p.labels.scheduleFlush();
        res.json({ ok });
    });
}
