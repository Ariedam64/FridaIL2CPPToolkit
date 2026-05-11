// Label store: persistent CRUD over class/method/field renames.
// File-backed JSON, atomic writes, in-memory undo/redo ring (50 entries).
// Decoupled from vscode.* — uses a minimal Listener pattern.

import * as fs from "fs";
import * as path from "path";

import type { LabelChangeEvent, LabelEntry, LabelKey } from "./types";

interface LabelsFileV1 {
    schemaVersion: 1;
    classes: Record<string, LabelEntry>;
    methods: Record<string, LabelEntry>;
    fields: Record<string, LabelEntry>;
}

type Listener<T> = (event: T) => void;

const UNDO_BUFFER_SIZE = 50;

interface UndoFrame {
    apply: () => void;
    revert: () => void;
}

export class LabelStore {
    private classes = new Map<string, LabelEntry>();
    private methods = new Map<string, LabelEntry>();
    private fields = new Map<string, LabelEntry>();
    // Reverse indices: friendly label → obf key. Methods/fields are scoped per
    // class because the same friendly label (e.g. "id") can exist on multiple
    // classes. classObf is the *current* obf class name (post-migration).
    private classesByLabel = new Map<string, string>();
    private methodsByLabel = new Map<string, string>();   // key = `${classObf}.${label}`
    private fieldsByLabel = new Map<string, string>();    // key = `${classObf}.${label}`
    private listeners: Array<Listener<LabelChangeEvent>> = [];
    private filePath: string;
    private dirty = false;
    private flushPromise: Promise<void> = Promise.resolve();
    private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
    private undoStack: UndoFrame[] = [];
    private redoStack: UndoFrame[] = [];
    private onCorruption?: (backupPath: string) => void;

    constructor(filePath: string, onCorruption?: (backupPath: string) => void) {
        this.filePath = filePath;
        this.onCorruption = onCorruption;
        this.loadFromDisk();
    }

    get(key: LabelKey): string | null {
        const entry = this.lookup(key);
        return entry ? entry.label : null;
    }

    display(key: LabelKey): string {
        const label = this.get(key);
        if (label) return label;
        switch (key.kind) {
            case "class":  return key.className;
            case "method": return key.methodName;
            case "field":  return key.fieldName;
        }
    }

    /** Total number of labels across all kinds. Cheap. */
    totalCount(): number {
        return this.classes.size + this.methods.size + this.fields.size;
    }

    /** Reverse lookup: friendly label → current obf name. For class kind only
     *  the label is enough; for field/method kinds the parent class's obf
     *  name must be supplied (typically the result of a prior class lookup),
     *  because the same friendly label can exist on multiple classes. */
    resolveByLabel(kind: "class", label: string): string | null;
    resolveByLabel(kind: "method", label: string, classObf: string): string | null;
    resolveByLabel(kind: "field", label: string, classObf: string): string | null;
    resolveByLabel(kind: "class" | "method" | "field", label: string, classObf?: string): string | null {
        if (kind === "class") return this.classesByLabel.get(label) ?? null;
        if (!classObf) return null;
        const map = kind === "field" ? this.fieldsByLabel : this.methodsByLabel;
        return map.get(`${classObf}.${label}`) ?? null;
    }

    isObfuscated(key: LabelKey): boolean {
        const name = key.kind === "class" ? key.className
                   : key.kind === "method" ? key.methodName
                   : key.fieldName;
        return /^[a-z]{1,4}$/.test(name);
    }

    set(key: LabelKey, friendly: string, sig?: { signature?: string; fingerprint?: string }): void {
        const old = this.get(key);
        if (old === friendly && !sig) return;

        const apply = (): void => {
            const now = new Date().toISOString();
            const existing = this.lookup(key);
            const entry: LabelEntry = {
                label: friendly,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now,
                // Carry over existing sig if the new call didn't include one,
                // so a later non-class rename doesn't wipe the captured shape.
                signature:   sig?.signature   ?? existing?.signature,
                fingerprint: sig?.fingerprint ?? existing?.fingerprint,
            };
            this.put(key, entry);
            this.markDirty();
            this.emit({ key, oldLabel: existing ? existing.label : null, newLabel: friendly });
        };
        const revert = (): void => {
            if (old === null) {
                this.delete(key);
            } else {
                const now = new Date().toISOString();
                this.put(key, { label: old, createdAt: now, updatedAt: now });
            }
            this.markDirty();
            this.emit({ key, oldLabel: friendly, newLabel: old });
        };
        this.pushUndo({ apply, revert });
        apply();
    }

    /** Attach a signature/fingerprint to an existing entry without changing
     *  the label or producing an undo frame. Used by the backfill endpoint
     *  to retro-fit signatures on labels created before the feature existed. */
    decorate(key: LabelKey, sig: { signature?: string; fingerprint?: string }): boolean {
        const entry = this.lookup(key);
        if (!entry) return false;
        let changed = false;
        if (sig.signature && entry.signature !== sig.signature) {
            entry.signature = sig.signature;
            changed = true;
        }
        if (sig.fingerprint && entry.fingerprint !== sig.fingerprint) {
            entry.fingerprint = sig.fingerprint;
            changed = true;
        }
        if (changed) {
            entry.updatedAt = new Date().toISOString();
            this.markDirty();
        }
        return changed;
    }

    remove(key: LabelKey): void {
        const old = this.get(key);
        if (old === null) return;

        const apply = (): void => {
            this.delete(key);
            this.markDirty();
            this.emit({ key, oldLabel: old, newLabel: null });
        };
        const revert = (): void => {
            const now = new Date().toISOString();
            this.put(key, { label: old, createdAt: now, updatedAt: now });
            this.markDirty();
            this.emit({ key, oldLabel: null, newLabel: old });
        };
        this.pushUndo({ apply, revert });
        apply();
    }

    undo(): boolean {
        const frame = this.undoStack.pop();
        if (!frame) return false;
        frame.revert();
        this.redoStack.push(frame);
        return true;
    }

    redo(): boolean {
        const frame = this.redoStack.pop();
        if (!frame) return false;
        frame.apply();
        this.undoStack.push(frame);
        return true;
    }

    private pushUndo(frame: UndoFrame): void {
        this.undoStack.push(frame);
        if (this.undoStack.length > UNDO_BUFFER_SIZE) this.undoStack.shift();
        this.redoStack.length = 0;
    }

    bulkImport(json: unknown): { imported: number; skipped: number } {
        const data = json as LabelsFileV1;
        if (!data || data.schemaVersion !== 1) return { imported: 0, skipped: 0 };
        let imported = 0;
        let skipped = 0;
        for (const [k, v] of Object.entries(data.classes ?? {})) {
            if (this.classes.has(k)) { skipped++; continue; }
            this.classes.set(k, v);
            imported++;
        }
        for (const [k, v] of Object.entries(data.methods ?? {})) {
            if (this.methods.has(k)) { skipped++; continue; }
            this.methods.set(k, v);
            imported++;
        }
        for (const [k, v] of Object.entries(data.fields ?? {})) {
            if (this.fields.has(k)) { skipped++; continue; }
            this.fields.set(k, v);
            imported++;
        }
        if (imported > 0) {
            this.rebuildReverseIndices();
            this.markDirty();
        }
        return { imported, skipped };
    }

    bulkExport(): LabelsFileV1 {
        return {
            schemaVersion: 1,
            classes: Object.fromEntries(this.classes),
            methods: Object.fromEntries(this.methods),
            fields: Object.fromEntries(this.fields),
        };
    }

    onChange(listener: Listener<LabelChangeEvent>): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(event: LabelChangeEvent): void {
        for (const l of this.listeners) {
            try { l(event); } catch { /* listener errors must not break the store */ }
        }
    }

    async flush(): Promise<void> {
        if (this.scheduledTimer) {
            clearTimeout(this.scheduledTimer);
            this.scheduledTimer = null;
        }
        if (!this.dirty) return this.flushPromise;
        this.dirty = false;
        const data = JSON.stringify(this.bulkExport(), null, 2);
        const tmp = this.filePath + ".tmp";
        this.flushPromise = (async () => {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.promises.writeFile(tmp, data, "utf-8");
            await fs.promises.rename(tmp, this.filePath);
        })();
        return this.flushPromise;
    }

    /**
     * Coalesce multiple in-flight changes into a single disk write. Call after
     * each mutation when the user is actively editing — replaces the previous
     * scheduled flush. Explicit `flush()` drains immediately.
     */
    scheduleFlush(delayMs: number = 500): void {
        if (this.scheduledTimer) clearTimeout(this.scheduledTimer);
        this.scheduledTimer = setTimeout(() => {
            this.scheduledTimer = null;
            void this.flush().catch((err) => {
                console.warn("LabelStore scheduled flush failed:", err);
            });
        }, delayMs);
    }

    private markDirty(): void {
        this.dirty = true;
    }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) return;
        let raw: string;
        try {
            raw = fs.readFileSync(this.filePath, "utf-8");
        } catch {
            // Unreadable — leave store empty, file will be overwritten on next flush
            return;
        }
        try {
            const data = JSON.parse(raw) as LabelsFileV1;
            for (const [k, v] of Object.entries(data.classes ?? {})) this.classes.set(k, v);
            for (const [k, v] of Object.entries(data.methods ?? {})) this.methods.set(k, v);
            for (const [k, v] of Object.entries(data.fields ?? {})) this.fields.set(k, v);
            this.rebuildReverseIndices();
        } catch {
            // Corrupted JSON — back up the file and start fresh
            const backup = `${this.filePath}.corrupted.${Date.now()}.json`;
            try {
                fs.renameSync(this.filePath, backup);
            } catch {
                // Couldn't rename; nothing we can do, leave the corrupted file as-is
                return;
            }
            this.classes.clear();
            this.methods.clear();
            this.fields.clear();
            if (this.onCorruption) {
                try { this.onCorruption(backup); } catch { /* ignore */ }
            }
        }
    }

    private lookup(key: LabelKey): LabelEntry | undefined {
        switch (key.kind) {
            case "class":  return this.classes.get(key.className);
            case "method": return this.methods.get(`${key.className}.${key.methodName}`);
            case "field":  return this.fields.get(`${key.className}.${key.fieldName}`);
        }
    }

    private put(key: LabelKey, entry: LabelEntry): void {
        // Drop any prior reverse entry first — a re-set may carry a different
        // label and we don't want a stale friendly→obf mapping lingering.
        this.dropReverse(key);
        switch (key.kind) {
            case "class":
                this.classes.set(key.className, entry);
                this.classesByLabel.set(entry.label, key.className);
                break;
            case "method":
                this.methods.set(`${key.className}.${key.methodName}`, entry);
                this.methodsByLabel.set(`${key.className}.${entry.label}`, key.methodName);
                break;
            case "field":
                this.fields.set(`${key.className}.${key.fieldName}`, entry);
                this.fieldsByLabel.set(`${key.className}.${entry.label}`, key.fieldName);
                break;
        }
    }

    private delete(key: LabelKey): void {
        this.dropReverse(key);
        switch (key.kind) {
            case "class":  this.classes.delete(key.className); break;
            case "method": this.methods.delete(`${key.className}.${key.methodName}`); break;
            case "field":  this.fields.delete(`${key.className}.${key.fieldName}`); break;
        }
    }

    private dropReverse(key: LabelKey): void {
        const existing = this.lookup(key);
        if (!existing) return;
        switch (key.kind) {
            case "class":  this.classesByLabel.delete(existing.label); break;
            case "method": this.methodsByLabel.delete(`${key.className}.${existing.label}`); break;
            case "field":  this.fieldsByLabel.delete(`${key.className}.${existing.label}`); break;
        }
    }

    private rebuildReverseIndices(): void {
        this.classesByLabel.clear();
        this.methodsByLabel.clear();
        this.fieldsByLabel.clear();
        for (const [k, v] of this.classes) this.classesByLabel.set(v.label, k);
        for (const [k, v] of this.methods) {
            const dot = k.indexOf(".");
            if (dot < 0) continue;
            this.methodsByLabel.set(`${k.slice(0, dot)}.${v.label}`, k.slice(dot + 1));
        }
        for (const [k, v] of this.fields) {
            const dot = k.indexOf(".");
            if (dot < 0) continue;
            this.fieldsByLabel.set(`${k.slice(0, dot)}.${v.label}`, k.slice(dot + 1));
        }
    }
}
