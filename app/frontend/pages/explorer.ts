// app/frontend/pages/explorer.ts
import { renderProcessExplorer } from "../components/process-explorer.js";
import { renderClassDetail } from "../components/class-detail.js";
import { renderHookLog } from "../components/hook-log.js";

export function mountExplorerPage(host: HTMLElement): void {
    host.innerHTML = `
        <div id="exp-host"></div>
        <div id="cd-host"></div>
        <div id="hl-host"></div>
    `;
    host.style.display = "flex";
    host.style.flex = "1";
    host.style.minHeight = "0";

    const exp = renderProcessExplorer(host.querySelector<HTMLElement>("#exp-host")!);
    const cd = renderClassDetail(host.querySelector<HTMLElement>("#cd-host")!);
    renderHookLog(host.querySelector<HTMLElement>("#hl-host")!);

    exp.onClassSelect((fullName) => { void cd.show(fullName); });
}
