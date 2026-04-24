// Travel panel — autopilot + zaap only. The world-map visualisation has
// moved to panels/world.ts. This panel stays tiny on purpose: give the
// current position, a coord-based autopilot, a coord-based zaap, and a
// log surface.

import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";

let hookInstalled = false;
async function ensureHook(): Promise<void> {
    if (hookInstalled) return;
    try {
        await rpcCall<any>("installOutgoingHook", [[]]);
        rpcCall<any>("primeMapCoordIndex", []).catch(() => null);
        hookInstalled = true;
    } catch { /* ignore */ }
}

export function renderMap(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3); max-width:620px">
        <div style="display:flex; gap:var(--s-2); align-items:center">
          <button id="tp-refresh-pos" class="btn">↻</button>
          <span id="tp-pos" style="font-family:var(--font-mono); font-size:12px; color:var(--c-label)">—</span>
        </div>

        <fieldset style="border:1px solid #333; padding:var(--s-3); border-radius:4px">
          <legend style="padding:0 var(--s-2); color:var(--c-label); font-size:11px">autopilot (walks + zaaps natively)</legend>
          <div style="display:flex; gap:var(--s-2); align-items:center">
            <input id="tp-ap-x" type="number" placeholder="x" style="width:60px">
            <input id="tp-ap-y" type="number" placeholder="y" style="width:60px">
            <button id="tp-ap-go" class="btn primary">TRAVEL</button>
          </div>
        </fieldset>

        <fieldset style="border:1px solid #333; padding:var(--s-3); border-radius:4px">
          <legend style="padding:0 var(--s-2); color:var(--c-label); font-size:11px">zaap (instant — must be on a zaap cell)</legend>
          <div style="display:flex; gap:var(--s-2); align-items:center">
            <input id="tp-zp-x" type="number" placeholder="x" style="width:60px">
            <input id="tp-zp-y" type="number" placeholder="y" style="width:60px">
            <button id="tp-zp-go" class="btn primary">ZAAP</button>
          </div>
        </fieldset>
      </div>
    `;
    // Inline-style the inputs the same way the original did.
    container.querySelectorAll<HTMLInputElement>("input[type=number]").forEach(el => {
        el.style.cssText += "padding:2px 4px;background:#111;border:1px solid #333;color:#fff;font-family:var(--font-mono);font-size:11px";
    });

    const pos = container.querySelector<HTMLSpanElement>("#tp-pos")!;

    async function refreshPos(): Promise<void> {
        try {
            const st = await rpcCall<any>("getMapState", []);
            if (!st) { pos.textContent = "not on a map"; return; }
            const info = await rpcCall<any>("getMapInfo", [st.mapId]).catch(() => null);
            const coords = info ? ` (${info.posX}, ${info.posY})` : "";
            pos.textContent = `mapId=${st.mapId}${coords}  subAreaId=${info?.subAreaId ?? "?"}`;
        } catch (err) { pos.textContent = `err: ${String(err).slice(0, 120)}`; }
    }

    container.querySelector<HTMLButtonElement>("#tp-refresh-pos")!.addEventListener("click", refreshPos);

    container.querySelector<HTMLButtonElement>("#tp-ap-go")!.addEventListener("click", async () => {
        await ensureHook();
        const x = parseInt(container.querySelector<HTMLInputElement>("#tp-ap-x")!.value, 10);
        const y = parseInt(container.querySelector<HTMLInputElement>("#tp-ap-y")!.value, 10);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { logRpcLine("[travel] need both x and y"); return; }
        try {
            const lookup = await rpcCall<any>("findMapIdByCoords", [x, y]);
            if (!lookup?.best) { logRpcLine(`[travel] no map at (${x}, ${y})`); return; }
            const r = await rpcCall<any>("autoTravelInstant", [lookup.best.mapId]);
            logRpcLine(`[travel] autopilot → ${lookup.best.mapId} : ${JSON.stringify(r)}`);
        } catch (err) { logRpcLine(`[travel] autopilot threw: ${String(err)}`); }
    });

    container.querySelector<HTMLButtonElement>("#tp-zp-go")!.addEventListener("click", async () => {
        await ensureHook();
        const x = parseInt(container.querySelector<HTMLInputElement>("#tp-zp-x")!.value, 10);
        const y = parseInt(container.querySelector<HTMLInputElement>("#tp-zp-y")!.value, 10);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { logRpcLine("[zaap] need both x and y"); return; }
        try {
            const lookup = await rpcCall<any>("findMapIdByCoords", [x, y]);
            if (!lookup?.best) { logRpcLine(`[zaap] no map at (${x}, ${y})`); return; }
            const r = await rpcCall<any>("zaapTeleport", [lookup.best.mapId]);
            logRpcLine(`[zaap] → ${lookup.best.mapId} : ${JSON.stringify(r)}`);
            setTimeout(refreshPos, 2500);
        } catch (err) { logRpcLine(`[zaap] threw: ${String(err)}`); }
    });

    refreshPos().catch(() => null);
}
