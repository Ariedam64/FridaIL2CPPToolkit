// Small path helpers. Kept vscode-free so they can run under vitest.

import * as os from "os";
import * as path from "path";

/**
 * Expand a leading `~` or `~/` (or `~\` on Windows) to the user's home
 * directory. Bare strings without a leading tilde are returned unchanged.
 */
export function expandHome(p: string): string {
    if (!p) return p;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/") || p.startsWith("~\\")) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}
