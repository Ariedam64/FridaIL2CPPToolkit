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
import * as mapstateRpc from "./mapstate";
import * as senderRpc from "./sender";
import * as catalogRpc from "./catalog";

type AllRpc = typeof searchRpc & typeof explorerRpc & typeof hooksRpc & typeof instanceOpsRpc & typeof networkRpc & typeof watchlistRpc & typeof scannerRpc & typeof inspectorRpc & typeof diffRpc & typeof stacktraceRpc & typeof mapstateRpc & typeof senderRpc & typeof catalogRpc;

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
        ...mapstateRpc,
        ...senderRpc,
        ...catalogRpc,
    } as AllRpc;
}
