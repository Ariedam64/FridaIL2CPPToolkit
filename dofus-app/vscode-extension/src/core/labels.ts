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
    private listeners: Array<Listener<LabelChangeEvent>> = [];
    private filePath: string;
    private dirty = false;
    private flushPromise: Promise<void> = Promise.resolve();
    private undoStack: UndoFrame[] = [];
    private redoStack: UndoFrame[] = [];

    constructor(filePath: string) {
        this.filePath = filePath;
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

    isObfuscated(key: LabelKey): boolean {
        const name = key.kind === "class" ? key.className
                   : key.kind === "method" ? key.methodName
                   : key.fieldName;
        return /^[a-z]{1,4}$/.test(name);
    }

    set(key: LabelKey, friendly: string): void {
        const old = this.get(key);
        if (old === friendly) return;

        const apply = (): void => {
            const now = new Date().toISOString();
            const existing = this.lookup(key);
            const entry: LabelEntry = {
                label: friendly,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now,
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
        if (imported > 0) this.markDirty();
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

    private markDirty(): void {
        this.dirty = true;
    }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as LabelsFileV1;
            for (const [k, v] of Object.entries(data.classes ?? {})) this.classes.set(k, v);
            for (const [k, v] of Object.entries(data.methods ?? {})) this.methods.set(k, v);
            for (const [k, v] of Object.entries(data.fields ?? {})) this.fields.set(k, v);
        } catch {
            throw new Error(`labels.json invalid at ${this.filePath}`);
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
        switch (key.kind) {
            case "class":  this.classes.set(key.className, entry); break;
            case "method": this.methods.set(`${key.className}.${key.methodName}`, entry); break;
            case "field":  this.fields.set(`${key.className}.${key.fieldName}`, entry); break;
        }
    }

    private delete(key: LabelKey): void {
        switch (key.kind) {
            case "class":  this.classes.delete(key.className); break;
            case "method": this.methods.delete(`${key.className}.${key.methodName}`); break;
            case "field":  this.fields.delete(`${key.className}.${key.fieldName}`); break;
        }
    }
}
