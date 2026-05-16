// Dofus plugin RPC entry — re-exports every method that should be exposed to
// the backend via the Frida agent. Imported as a single module by the core
// rpc-methods.ts so the cross-tree coupling is contained to one line there.

import * as _runtimeRpc from "./actions/_runtime";
export function warmupLiveInstance(classNames: string[]) {
    return _runtimeRpc.warmupLiveInstance(classNames);
}
export function clearLiveInstanceCache() {
    return _runtimeRpc.clearLiveInstanceCache();
}
export * from "./data-scrape";
export * from "./actions/trade-center";
export * from "./actions/interactive";
export * from "./actions/movement";
export * from "./actions/change-map";
export * from "./actions/basic-ping";
export * from "./actions/npc-dialog";
export * from "./actions/player-state";
export * from "./actions/entity-probe";
export * from "./actions/map-state";
export * from "./actions/world-pathfinding";
