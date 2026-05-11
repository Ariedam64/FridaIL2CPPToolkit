// Dofus plugin RPC entry — re-exports every method that should be exposed to
// the backend via the Frida agent. Imported as a single module by the core
// rpc-methods.ts so the cross-tree coupling is contained to one line there.

export * from "./data-scrape";
export * from "./actions/trade-center";
export * from "./actions/interactive";
export * from "./actions/movement";
export * from "./actions/change-map";
export * from "./actions/player-state";
export * from "./actions/entity-probe";
export * from "./actions/map-state";
