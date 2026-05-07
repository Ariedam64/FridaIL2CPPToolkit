// Clean map-only screenshots of the running Dofus process.
//
// Strategy: render Camera.main into an off-screen RenderTexture with the UI
// layer masked out, read the pixels back to a readable Texture2D, encode PNG
// via UnityEngine.ImageConversion, and stream the bytes to the host via
// send(meta, ArrayBuffer). Screen-Space-Overlay canvases don't render
// through a camera so they're already excluded; excluding the UI layer
// covers Screen-Space-Camera / World-Space canvases that would otherwise
// appear in the main camera's view.
import "frida-il2cpp-bridge";
import { findClassExact as findClass } from "../lib/search";
import { scheduleMainThread } from "./sender";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

export function captureMapScreenshot(mapId?: number): Promise<{
    ok: boolean; reason?: string; width?: number; height?: number; bytes?: number; mapId?: number;
}> {
    return inVm(() => new Promise((resolve) => {
        const cameraKlass = findClass("Camera");
        const screenKlass = findClass("Screen");
        const rtKlass = findClass("RenderTexture");
        const texKlass = findClass("Texture2D");
        const rectKlass = findClass("Rect");
        const icv = findClass("ImageConversion");
        if (!cameraKlass || !screenKlass || !rtKlass || !texKlass || !rectKlass || !icv) {
            resolve({ ok: false, reason: "missing Unity class (Camera/Screen/RenderTexture/Texture2D/Rect/ImageConversion)" });
            return;
        }

        const getMain = cameraKlass.methods.find(m => m.isStatic && m.name === "get_main");
        const screenWidth = screenKlass.methods.find(m => m.isStatic && m.name === "get_width");
        const screenHeight = screenKlass.methods.find(m => m.isStatic && m.name === "get_height");
        const getTemp = rtKlass.methods.find(m => m.isStatic && m.name === "GetTemporary" && m.parameters.length === 3);
        const releaseTemp = rtKlass.methods.find(m => m.isStatic && m.name === "ReleaseTemporary");
        const getActive = rtKlass.methods.find(m => m.isStatic && m.name === "get_active");
        const setActive = rtKlass.methods.find(m => m.isStatic && m.name === "set_active");
        const encodeToPNG = icv.methods.find(m =>
            m.isStatic && m.name === "EncodeToPNG" && m.parameters.length === 1
            && m.parameters[0].type.name === "UnityEngine.Texture2D"
        );
        if (!getMain || !screenWidth || !screenHeight || !getTemp || !releaseTemp || !getActive || !setActive || !encodeToPNG) {
            resolve({ ok: false, reason: "missing Unity method (get_main/get_width/get_height/GetTemporary/ReleaseTemporary/get_active/set_active/EncodeToPNG)" });
            return;
        }

        // UI layer bitmask — Unity's built-in "UI" is layer 5. If the project uses
        // a custom layer we'd miss it, but the main world camera's cullingMask
        // almost certainly already excludes non-world layers so this is belt-and-suspenders.
        const UI_LAYER_MASK = 1 << 5;

        const scheduled = scheduleMainThread(() => {
            try {
                // Prefer Camera.main (the MainCamera-tagged one). Fall back to the
                // highest-depth enabled Camera in the heap if Dofus doesn't tag
                // its world camera — game-side cameras usually depth-sort such that
                // the world camera is either the only one or has the lowest depth
                // (rendered first, under UI).
                let cam: any = getMain.invoke();
                if (!cam || (cam.isNull && cam.isNull())) {
                    const cams = Il2Cpp.gc.choose(cameraKlass);
                    cam = cams.find(c => {
                        try { return Boolean(c.method("get_enabled").invoke()); } catch { return false; }
                    }) ?? cams[0] ?? null;
                }
                if (!cam || (cam.isNull && cam.isNull())) { resolve({ ok: false, reason: "no Camera instance found" }); return; }

                const w = Number(screenWidth.invoke());
                const h = Number(screenHeight.invoke());
                if (!w || !h) { resolve({ ok: false, reason: `bad screen dims ${w}x${h}` }); return; }

                const origMask = Number(cam.method("get_cullingMask").invoke());
                const origTarget = cam.method("get_targetTexture").invoke();
                const prevActive = getActive.invoke() as any;

                // 24-bit depth buffer so shadow/z-sorted rendering stays correct.
                const rt = getTemp.invoke(w, h, 24) as any;

                let readable: any = null;
                let pngBytes: Il2Cpp.Array<number> | null = null;
                try {
                    cam.method("set_cullingMask").invoke((origMask & ~UI_LAYER_MASK) >>> 0);
                    cam.method("set_targetTexture").invoke(rt);
                    cam.method("Render").invoke();

                    setActive.invoke(rt);
                    readable = (texKlass as any).new(w, h);
                    const rect = (rectKlass as any).new();
                    rect.method(".ctor").invoke(0, 0, w, h);
                    readable.method("ReadPixels").invoke(rect, 0, 0, false);
                    readable.method("Apply").invoke();

                    pngBytes = encodeToPNG.invoke(readable) as Il2Cpp.Array<number>;
                } finally {
                    // Restore camera state before we risk failing downstream.
                    try { cam.method("set_targetTexture").invoke(origTarget); } catch {}
                    try { cam.method("set_cullingMask").invoke(origMask); } catch {}
                    try { setActive.invoke(prevActive); } catch {}
                    try { if (rt) releaseTemp.invoke(rt); } catch {}
                }

                if (!pngBytes) { resolve({ ok: false, reason: "EncodeToPNG returned null" }); return; }
                const len = Number(pngBytes.length);
                const buf = Memory.alloc(len);
                for (let k = 0; k < len; k++) buf.add(k).writeU8(Number(pngBytes.get(k)));
                const ab = buf.readByteArray(len);
                send({ type: "map-screenshot", mapId: mapId ?? null, width: w, height: h, len, ts: Date.now() }, ab as any);
                resolve({ ok: true, width: w, height: h, bytes: len, mapId });
            } catch (e) {
                resolve({ ok: false, reason: String(e).slice(0, 200) });
            }
        });
        if (!scheduled) resolve({ ok: false, reason: "main-thread dispatcher unavailable" });
    }));
}
