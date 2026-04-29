// Filesystem RPC methods used by the toolkit's build-version detection.
// All methods are read-only and operate on paths reachable by the
// instrumented process.

import "frida-il2cpp-bridge";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

/**
 * Returns Application.dataPath — the Unity Dofus_Data folder, or equivalent
 * for other Unity games. Empty string if not a Unity game.
 */
export function getDataPath(): Promise<string> {
    return inVm(() => {
        try {
            const application = Il2Cpp.domain.assembly("UnityEngine.CoreModule")
                .image.class("UnityEngine.Application");
            const dataPath = application.method<Il2Cpp.String>("get_dataPath").invoke();
            return dataPath.content ?? "";
        } catch {
            return "";
        }
    });
}

/**
 * Read a UTF-8 text file via the host filesystem. Used for boot.config.
 */
export function readFile(path: string): Promise<string> {
    return inVm(() => {
        try {
            return File.readAllText(path);
        } catch (e) {
            throw new Error(`readFile failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}

/**
 * Read a binary file and return as hex-encoded string (avoids
 * JSON-incompatible Buffer over RPC). Used for global-metadata.dat hash.
 */
export function readFileBytes(path: string): Promise<string> {
    return inVm(() => {
        try {
            const bytes = new Uint8Array(File.readAllBytes(path));
            let hex = "";
            for (let i = 0; i < bytes.length; i++) {
                hex += bytes[i].toString(16).padStart(2, "0");
            }
            return hex;
        } catch (e) {
            throw new Error(`readFileBytes failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}

/**
 * Read the main process module bytes (executable in memory). Hex-encoded.
 * Limited to the first 1 MiB for hashing (more than enough for unique id).
 */
export function readMainModuleBytes(): Promise<string> {
    return inVm(() => {
        const main = Process.enumerateModules()[0];
        if (!main) throw new Error("no main module");
        const size = Math.min(main.size, 1024 * 1024);
        const buf = main.base.readByteArray(size);
        if (!buf) throw new Error("readByteArray returned null");
        const bytes = new Uint8Array(buf);
        let hex = "";
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, "0");
        }
        return hex;
    });
}
