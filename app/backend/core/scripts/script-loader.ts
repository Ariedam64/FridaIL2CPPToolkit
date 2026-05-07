import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as esbuild from "esbuild";
import type { RegistryEntry, ScriptDefinition } from "./types";
import { defineScript } from "./types";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

export class ScriptLoader extends EventEmitter {
    private entries = new Map<string, RegistryEntry>();         // id → entry
    private definitions = new Map<string, ScriptDefinition>();  // id → live def (with run fn)

    constructor(private readonly dir: string) {
        super();
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

    async loadFile(filePath: string): Promise<RegistryEntry> {
        const id = path.basename(filePath, ".ts");
        const loadedAt = new Date().toISOString();

        let source: string;
        try {
            source = await fs.readFile(filePath, "utf8");
        } catch (err) {
            const entry: RegistryEntry = {
                id, filePath, status: "compile-error",
                error: `read failed: ${(err as Error).message}`,
                loadedAt,
            };
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
        }

        // 1. Compile TS → CJS JS with inline sourcemap.
        let compiled: { code: string };
        try {
            compiled = await esbuild.transform(source, {
                loader: "ts", format: "cjs", sourcemap: "inline",
                sourcefile: filePath, target: "es2022",
            });
        } catch (err) {
            const entry: RegistryEntry = {
                id, filePath, status: "compile-error",
                error: (err as Error).message, loadedAt,
            };
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
        }

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
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
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
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
        }

        const def = candidate as ScriptDefinition;
        this.definitions.set(id, def);
        const entry: RegistryEntry = {
            id, filePath, status: "loaded",
            definition: { name: def.name, description: def.description, params: def.params, timeoutMs: def.timeoutMs },
            loadedAt,
        };
        this.entries.set(id, entry);
        this.emit("change", entry);
        return entry;
    }

    /** Remove an entry (by id). Used on file unlink. */
    removeFile(filePath: string): void {
        const id = path.basename(filePath, ".ts");
        if (!this.entries.has(id)) return;
        this.entries.delete(id);
        this.definitions.delete(id);
        this.emit("remove", id);
    }

    dispose(): void {
        // Subclasses (T4) may override to stop chokidar.
        this.entries.clear();
        this.definitions.clear();
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
