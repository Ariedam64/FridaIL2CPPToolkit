"use strict";
// Universal search via VSCode Quick Pick. Indexes obf names + labels and
// supports `:class`, `:method`, `:field` prefixes for filtering by kind.
//
// Note: `:rva` is not yet supported because no RPC provides per-method RVAs.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.UniversalSearch = exports.parseSearchInput = exports.filterByKind = void 0;
const vscode = __importStar(require("vscode"));
const search_filters_1 = require("./search-filters");
Object.defineProperty(exports, "filterByKind", { enumerable: true, get: function () { return search_filters_1.filterByKind; } });
Object.defineProperty(exports, "parseSearchInput", { enumerable: true, get: function () { return search_filters_1.parseSearchInput; } });
class UniversalSearch {
    rpc;
    profileSource;
    cache = null;
    constructor(rpc, profileSource) {
        this.rpc = rpc;
        this.profileSource = profileSource;
    }
    invalidate() { this.cache = null; }
    async show() {
        const items = await this.getIndex();
        const qp = vscode.window.createQuickPick();
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        // Persistent kind filter — set when user types `:kind `, cleared otherwise.
        let activeKind = null;
        const setItems = () => {
            const filtered = (0, search_filters_1.filterByKind)(items, activeKind);
            qp.items = filtered.map((e) => ({
                label: e.label,
                description: e.description,
                detail: e.detail,
                entry: e,
            }));
            qp.placeholder = activeKind === null
                ? "Search class/method/field by obf or label. Prefix :class :method :field"
                : `Filter: ${activeKind}. Type to search; type a new :prefix to switch kind.`;
        };
        const onValue = (raw) => {
            const parsed = (0, search_filters_1.parseSearchInput)(raw);
            if (parsed.kind !== null) {
                activeKind = parsed.kind;
                // Strip the prefix; this re-fires onDidChangeValue with the
                // bare query, which falls into the else branch below.
                qp.value = parsed.query;
                setItems();
                return;
            }
            setItems();
        };
        setItems();
        qp.onDidChangeValue(onValue);
        const pick = await new Promise((resolve) => {
            qp.onDidAccept(() => {
                resolve(qp.selectedItems[0]);
                qp.hide();
            });
            qp.onDidHide(() => resolve(undefined));
            qp.show();
        });
        qp.dispose();
        if (!pick)
            return;
        await vscode.commands.executeCommand(pick.entry.target.command, ...pick.entry.target.args);
    }
    async getIndex() {
        if (this.cache)
            return this.cache;
        const profile = this.profileSource.current();
        const out = [];
        try {
            const assemblies = await this.rpc.call("listAssembliesInfo");
            for (const a of assemblies) {
                const namespaces = await this.rpc.call("listNamespaces", [a.name]);
                for (const n of namespaces) {
                    const classes = await this.rpc.call("listClassesIn", [a.name, n.ns]);
                    for (const obf of classes) {
                        const fullName = n.ns ? `${n.ns}.${obf}` : obf;
                        const friendly = profile?.labels.get({ kind: "class", className: obf }) ?? null;
                        out.push({
                            kind: "class",
                            label: friendly ?? obf,
                            description: friendly ? `[${fullName}]` : (n.ns ? n.ns : ""),
                            detail: `${a.name} / ${n.ns || "(root)"}`,
                            target: { command: "frida.openClassDetail", args: [fullName] },
                        });
                    }
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`search index build failed: ${msg}`);
        }
        // Method and field labels — only the ones the user actually renamed.
        // We can't enumerate all members from the agent without a per-class
        // round-trip, so for v1 we surface labeled members only.
        if (profile) {
            const exported = profile.labels.bulkExport();
            for (const [key, entry] of Object.entries(exported.methods)) {
                const dot = key.indexOf(".");
                if (dot < 0)
                    continue;
                const className = key.slice(0, dot);
                const methodName = key.slice(dot + 1);
                out.push({
                    kind: "method",
                    label: entry.label,
                    description: `[${className}.${methodName}]`,
                    detail: "method",
                    target: { command: "frida.openClassDetail", args: [className] },
                });
            }
            for (const [key, entry] of Object.entries(exported.fields)) {
                const dot = key.indexOf(".");
                if (dot < 0)
                    continue;
                const className = key.slice(0, dot);
                const fieldName = key.slice(dot + 1);
                out.push({
                    kind: "field",
                    label: entry.label,
                    description: `[${className}.${fieldName}]`,
                    detail: "field",
                    target: { command: "frida.openClassDetail", args: [className] },
                });
            }
        }
        this.cache = out;
        return out;
    }
}
exports.UniversalSearch = UniversalSearch;
//# sourceMappingURL=search.js.map