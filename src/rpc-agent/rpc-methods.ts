// Aggregates all rpc-agent modules into a single flat export namespace.
// Used by index.ts as the value of rpc.exports.
import * as searchRpc from "./search";
import * as explorerRpc from "./explorer";
import * as hooksRpc from "./hooks";
import * as instanceOpsRpc from "./instance-ops";
import * as networkRpc from "./network";
import * as watchlistRpc from "./watchlist";
import * as scannerRpc from "./scanner";
import * as inspectorRpc from "./inspector";
import * as diffRpc from "./diff";
import * as stacktraceRpc from "./stacktrace";
import * as attributesRpc from "./attributes";
import * as dataCenterRpc from "./datacenter";
import * as networkMonitorRpc from "./network-monitor";
import * as filesystemRpc from "./filesystem";
import * as fingerprintsRpc from "./fingerprints";
// Plugin-owned RPC modules — kept under src/rpc-agent/plugins/ so the agent
// build picks them up, but logically belong to the matching app/plugins/<id>/.
import * as dofusRpc from "./plugins/dofus";

type AllRpc = typeof searchRpc & typeof explorerRpc & typeof hooksRpc & typeof instanceOpsRpc & typeof networkRpc & typeof watchlistRpc & typeof scannerRpc & typeof inspectorRpc & typeof diffRpc & typeof stacktraceRpc & typeof attributesRpc & typeof dataCenterRpc & typeof networkMonitorRpc & typeof filesystemRpc & typeof fingerprintsRpc & typeof dofusRpc;

export function getRpcMethods(): AllRpc {
    return {
        ...searchRpc,
        ...explorerRpc,
        ...hooksRpc,
        ...instanceOpsRpc,
        ...networkRpc,
        ...watchlistRpc,
        ...scannerRpc,
        ...inspectorRpc,
        ...diffRpc,
        ...stacktraceRpc,
        ...attributesRpc,
        ...dataCenterRpc,
        ...networkMonitorRpc,
        ...filesystemRpc,
        ...fingerprintsRpc,
        ...dofusRpc,
    } as AllRpc;
}
