// Annotation store: bookmarks + notes per class/method/field.
// File-backed JSON. Same Listener pattern as labels.ts.

import * as fs from "fs";
import * as path from "path";

import type {
    AnnotationChangeEvent,
    BookmarkEntry,
    LabelKey,
    NoteEntry,
} from "./types";

interface AnnotationsFileV1 {
    schemaVersion: 1;
    bookmarks: Record<string, BookmarkEntry>;
    notes: Record<string, NoteEntry>;
}

type Listener<T> = (event: T) => void;

function keyId(key: LabelKey): string {
    switch (key.kind) {
        case "class":  return `class:${key.className}`;
        case "method": return `method:${key.className}.${key.methodName}`;
        case "field":  return `field:${key.className}.${key.fieldName}`;
    }
}

function parseKeyId(id: string): LabelKey | null {
    const m = /^(class|method|field):(.+)$/.exec(id);
    if (!m) return null;
    const kind = m[1] as "class" | "method" | "field";
    const rest = m[2];
    if (kind === "class") return { kind, className: rest };
    const dot = rest.indexOf(".");
    if (dot < 0) return null;
    const className = rest.slice(0, dot);
    const member = rest.slice(dot + 1);
    return kind === "method"
        ? { kind, className, methodName: member }
        : { kind, className, fieldName: member };
}

export class AnnotationStore {
    private bookmarks = new Map<string, BookmarkEntry>();
    private notes = new Map<string, NoteEntry>();
    private listeners: Array<Listener<AnnotationChangeEvent>> = [];
    private filePath: string;
    private dirty = false;
    private onCorruption?: (backupPath: string) => void;

    constructor(filePath: string, onCorruption?: (backupPath: string) => void) {
        this.filePath = filePath;
        this.onCorruption = onCorruption;
        this.loadFromDisk();
    }

    isBookmarked(key: LabelKey): boolean {
        return this.bookmarks.has(keyId(key));
    }

    toggleBookmark(key: LabelKey): void {
        const id = keyId(key);
        if (this.bookmarks.has(id)) {
            this.bookmarks.delete(id);
            this.markDirty();
            this.emit({ key, kind: "bookmark", action: "removed" });
        } else {
            this.bookmarks.set(id, { createdAt: new Date().toISOString() });
            this.markDirty();
            this.emit({ key, kind: "bookmark", action: "added" });
        }
    }

    listBookmarks(): LabelKey[] {
        return Array.from(this.bookmarks.keys())
            .map(parseKeyId)
            .filter((k): k is LabelKey => k !== null);
    }

    getNote(key: LabelKey): string | null {
        return this.notes.get(keyId(key))?.markdown ?? null;
    }

    setNote(key: LabelKey, markdown: string): void {
        const id = keyId(key);
        const exists = this.notes.has(id);
        this.notes.set(id, { markdown, updatedAt: new Date().toISOString() });
        this.markDirty();
        this.emit({ key, kind: "note", action: exists ? "updated" : "added" });
    }

    removeNote(key: LabelKey): void {
        const id = keyId(key);
        if (!this.notes.has(id)) return;
        this.notes.delete(id);
        this.markDirty();
        this.emit({ key, kind: "note", action: "removed" });
    }

    listNoted(): LabelKey[] {
        return Array.from(this.notes.keys())
            .map(parseKeyId)
            .filter((k): k is LabelKey => k !== null);
    }

    onChange(listener: Listener<AnnotationChangeEvent>): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(event: AnnotationChangeEvent): void {
        for (const l of this.listeners) {
            try { l(event); } catch { /* swallow */ }
        }
    }

    async flush(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        const data: AnnotationsFileV1 = {
            schemaVersion: 1,
            bookmarks: Object.fromEntries(this.bookmarks),
            notes: Object.fromEntries(this.notes),
        };
        const tmp = this.filePath + ".tmp";
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
        await fs.promises.rename(tmp, this.filePath);
    }

    private markDirty(): void { this.dirty = true; }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) return;
        let raw: string;
        try {
            raw = fs.readFileSync(this.filePath, "utf-8");
        } catch {
            return;
        }
        try {
            const data = JSON.parse(raw) as AnnotationsFileV1;
            for (const [k, v] of Object.entries(data.bookmarks ?? {})) this.bookmarks.set(k, v);
            for (const [k, v] of Object.entries(data.notes ?? {})) this.notes.set(k, v);
        } catch {
            const backup = `${this.filePath}.corrupted.${Date.now()}.json`;
            try {
                fs.renameSync(this.filePath, backup);
            } catch {
                return;
            }
            this.bookmarks.clear();
            this.notes.clear();
            if (this.onCorruption) {
                try { this.onCorruption(backup); } catch { /* ignore */ }
            }
        }
    }
}
