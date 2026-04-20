import "frida-il2cpp-bridge";
import { banner, fullClassName, safe, stringifyValue } from "./util";

/** Dump structurel d'une classe (sans instance) : fields + static fields + methods. */
export function dumpClass(klass: Il2Cpp.Class): void {
    banner(`CLASS ${fullClassName(klass)}`);
    console.log(`  parent : ${klass.parent ? fullClassName(klass.parent) : "(none)"}`);

    const instFields = klass.fields.filter(f => !f.isStatic);
    const statFields = klass.fields.filter(f => f.isStatic);

    if (instFields.length) {
        console.log(`  instance fields (${instFields.length}):`);
        for (const f of instFields) console.log(`    ${f.type.name.padEnd(30)} ${f.name}`);
    }
    if (statFields.length) {
        console.log(`  static fields (${statFields.length}):`);
        for (const f of statFields) {
            const val = safe(`static ${f.name}`, () => stringifyValue(f.value));
            console.log(`    ${f.type.name.padEnd(30)} ${f.name.padEnd(30)} = ${val ?? "<err>"}`);
        }
    }

    if (klass.methods.length) {
        console.log(`  methods (${klass.methods.length}):`);
        for (const m of klass.methods) {
            const kind = m.isStatic ? "static " : "       ";
            const params = m.parameters.map(p => `${p.type.name} ${p.name}`).join(", ");
            console.log(`    ${kind}${m.returnType.name.padEnd(20)} ${m.name}(${params})`);
        }
    }
}

/** Dump les valeurs courantes de tous les champs d'instance d'un objet vivant. */
export function dumpFields(instance: Il2Cpp.Object): void {
    banner(`INSTANCE ${instance.class.name}@${instance.handle}`);
    for (const f of instance.class.fields) {
        if (f.isStatic) continue;
        const val = safe(f.name, () => stringifyValue(instance.field(f.name).value));
        console.log(`  ${f.type.name.padEnd(30)} ${f.name.padEnd(30)} = ${val ?? "<err>"}`);
    }
}

/** Dump les valeurs des champs statiques d'une classe. */
export function dumpStatics(klass: Il2Cpp.Class): void {
    banner(`STATICS ${fullClassName(klass)}`);
    for (const f of klass.fields) {
        if (!f.isStatic) continue;
        const val = safe(f.name, () => stringifyValue(f.value));
        console.log(`  ${f.type.name.padEnd(30)} ${f.name.padEnd(30)} = ${val ?? "<err>"}`);
    }
}
