// app/frontend/core/il2cpp-pretty.ts
// Cosmetic transforms for IL2CPP names — applied at the display layer only.
// Raw names are preserved in typeName/rawValue for write operations.

/**
 * Auto-property backing fields are emitted by the C# compiler as
 * `<PropName>k__BackingField`. Strip the wrapper to show just `PropName`.
 */
export function prettyFieldName(name: string): string {
    const m = name.match(/^<(.+)>k__BackingField$/);
    return m ? m[1] : name;
}

/** Whether the name is a synthetic backing field (so we can render a hint). */
export function isBackingField(name: string): boolean {
    return /^<.+>k__BackingField$/.test(name);
}

/**
 * IL2CPP / CLI emit generics as `Type\`N` where N is the arity.
 * Replace with `Type<…>` so it's recognizable as generic without faking type args.
 */
export function prettyClassName(name: string): string {
    return name.replace(/`(\d+)/g, "<…>");
}
