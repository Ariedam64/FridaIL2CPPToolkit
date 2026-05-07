import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as esbuild from "esbuild";
import chokidar, { type FSWatcher } from "chokidar";
import type { RegistryEntry, ScriptDefinition } from "./types";
import { defineScript } from "./types";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

export class ScriptLoader extends EventEmitter {
    private entries = new Map<string, RegistryEntry>();         // id → entry
    private definitions = new Map<string, ScriptDefinition>();  // id → live def (with run fn)
    private compiledById = new Map<string, string>();           // id → compiled JS (with inline sourcemap)
    private watcher: FSWatcher | null = null;
    private _disposed = false;

    constructor(private readonly dir: string) {
        super();
    }

    /**
     * Atomically commit a completed loadFile result into state.
     * Skipped entirely if dispose() was called while the load was in-flight,
     * preventing zombie entries from re-populating cleared maps.
     */
    private commitEntry(entry: RegistryEntry, def: ScriptDefinition | null): RegistryEntry {
        if (this._disposed) return entry;
        this.entries.set(entry.id, entry);
        if (def) this.definitions.set(entry.id, def);
        else this.definitions.delete(entry.id);
        this.emit("change", entry);
        return entry;
    }

    list(): RegistryEntry[] {
        return Array.from(this.entries.values());
    }

    get(id: string): RegistryEntry | null {
        return this.entries.get(id) ?? null;
    }

    /** Returns the live ScriptDefinition (with `run`) for execution. */
    getDefinition(id: string): ScriptDefinition | null {
        return this.definitions.get(id) ?? null;
    }

    /** Returns the compiled JS (with inline sourcemap) for stack-trace remapping. */
    getCompiled(id: string): string | null {
        return this.compiledById.get(id) ?? null;
    }

    async loadFile(filePath: string): Promise<RegistryEntry> {
        const id = path.basename(filePath, ".ts");
        const loadedAt = new Date().toISOString();

        // Early disposal guard — loader was disposed before we even started.
        if (this._disposed) {
            return { id, filePath, status: "compile-error", error: "loader disposed", loadedAt };
        }

        let source: string;
        try {
            source = await fs.readFile(filePath, "utf8");
        } catch (err) {
            const entry: RegistryEntry = {
                id, filePath, status: "compile-error",
                error: `read failed: ${(err as Error).message}`,
                loadedAt,
            };
            return this.commitEntry(entry, null);
        }

        // 1. Compile TS → CJS JS with inline sourcemap.
        let compiled: { code: string };
        try {
            compiled = await esbuild.transform(source, {
                loader: "ts", format: "cjs", sourcemap: "inline",
                sourcefile: filePath, target: "es2022",
            });
        } catch (err) {
            this.compiledById.delete(id);
            const entry: RegistryEntry = {
                id, filePath, status: "compile-error",
                error: (err as Error).message, loadedAt,
            };
            return this.commitEntry(entry, null);
        }

        // Store compiled JS for source-map remapping (only on successful compile).
        this.compiledById.set(id, compiled.code);

        // 2. Execute the JS in a curated context (no real sandbox; defensive only).
        const moduleObj = { exports: {} as Record<string, unknown> };

        // require shim: allow ONLY "@toolkit/scripts" (resolved to { defineScript }), throw on everything else.
        // This is required because esbuild compiles `import { defineScript } from "@toolkit/scripts"` to
        // `require("@toolkit/scripts")` — without this special case, the very first valid script fails.
        const requireStub = (modId: string): { defineScript: typeof defineScript } => {
            if (modId === "@toolkit/scripts") return { defineScript };
            throw new Error(`require('${modId}') not allowed in scripts`);
        };

        try {
            const fn = new AsyncFunction("module", "exports", "require", compiled.code);
            await fn(moduleObj, moduleObj.exports, requireStub);
        } catch (err) {
            const entry: RegistryEntry = {
                id, filePath, status: "validation-error",
                error: (err as Error).message, loadedAt,
            };
            return this.commitEntry(entry, null);
        }

        // 3. Pull `default` export (from `export default …`) or fallback to module.exports.
        const candidate =
            (moduleObj.exports.default as ScriptDefinition | undefined)
            ?? (moduleObj.exports as unknown as ScriptDefinition);

        // 4. Validate shape.
        const validationError = validateShape(candidate);
        if (validationError) {
            const entry: RegistryEntry = {
                id, filePath, status: "validation-error",
                error: validationError, loadedAt,
            };
            return this.commitEntry(entry, null);
        }

        const def = candidate as ScriptDefinition;

        // Duplicate-name guard: another loaded entry with the same `name`?
        for (const existing of this.entries.values()) {
            if (existing.id === id) continue;
            if (existing.status === "loaded" && existing.definition?.name === def.name) {
                const dupEntry: RegistryEntry = {
                    id, filePath, status: "validation-error",
                    error: `duplicate name '${def.name}' (already used by ${existing.id})`,
                    loadedAt,
                };
                return this.commitEntry(dupEntry, null);
            }
        }

        const entry: RegistryEntry = {
            id, filePath, status: "loaded",
            definition: { name: def.name, description: def.description, params: def.params, timeoutMs: def.timeoutMs },
            loadedAt,
        };
        return this.commitEntry(entry, def);
    }

    /** Remove an entry (by id). Used on file unlink. */
    removeFile(filePath: string): void {
        const id = path.basename(filePath, ".ts");
        if (!this.entries.has(id)) return;
        this.entries.delete(id);
        this.definitions.delete(id);
        this.compiledById.delete(id);
        this.emit("remove", id);
    }

    async start(): Promise<void> {
        if (this.watcher) return;
        // Ensure dir exists; chokidar may throw on missing path with awaitWriteFinish.
        await fs.mkdir(this.dir, { recursive: true });

        // Track in-flight loadFile promises so we can await them in start().
        const pending: Promise<RegistryEntry>[] = [];

        // Watch the directory directly (glob patterns do not work reliably on Windows with
        // chokidar v4). We filter for top-level *.ts files in the event handlers instead.
        this.watcher = chokidar.watch(this.dir, {
            ignoreInitial: false,
            depth: 0,
            awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
            ignored: (p: string) => {
                if (p === this.dir) return false;  // never ignore the root itself
                const base = path.basename(p);
                return base.startsWith("_") || base.startsWith(".");
            },
        });

        const isWatchedTs = (p: string) =>
            p.endsWith(".ts") && path.dirname(p) === this.dir;

        // During initial scan (before "ready"), collect promises so start() can await them.
        let initialScanDone = false;
        this.watcher.on("add", (p) => {
            if (!isWatchedTs(p)) return;
            const promise = this.loadFile(p);
            if (!initialScanDone) pending.push(promise);
            else void promise;
        });
        this.watcher.on("change", (p) => {
            if (!isWatchedTs(p)) return;
            void this.loadFile(p);
        });
        this.watcher.on("unlink", (p) => {
            if (!isWatchedTs(p)) return;
            this.removeFile(p);
        });

        // Wait until chokidar has emitted the initial scan, then await all initial loads.
        await new Promise<void>((resolve) => this.watcher!.once("ready", resolve));
        initialScanDone = true;
        await Promise.all(pending);
    }

    async dispose(): Promise<void> {
        this._disposed = true;  // set first so any in-flight loadFile() calls skip commitEntry
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
        this.entries.clear();
        this.definitions.clear();
        this.compiledById.clear();
        this.removeAllListeners();
    }
}

function validateShape(d: unknown): string | null {
    if (!d || typeof d !== "object") return "default export missing or not an object";
    const def = d as Record<string, unknown>;
    if (typeof def.name !== "string" || def.name.length === 0) {
        return "name must be a non-empty string";
    }
    if (typeof def.params !== "object" || def.params === null) {
        return "params must be an object";
    }
    if (typeof def.run !== "function") return "run must be an async function";
    if (def.timeoutMs !== undefined) {
        if (typeof def.timeoutMs !== "number" || def.timeoutMs <= 0) {
            return "timeoutMs must be > 0";
        }
    }
    return null;
}
