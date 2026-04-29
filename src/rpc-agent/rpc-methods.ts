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
import * as sentryRpc from "./sentry";
import * as gbeRouterRpc from "./gbe-router";
import * as gbeProbeRpc from "./gbe-probe";
import * as attributesRpc from "./attributes";
import * as dataCenterRpc from "./datacenter";
import * as protoDescriptorCaptureRpc from "./proto-descriptor-capture";
import * as filesystemRpc from "./filesystem";

type AllRpc = typeof searchRpc & typeof explorerRpc & typeof hooksRpc & typeof instanceOpsRpc & typeof networkRpc & typeof watchlistRpc & typeof scannerRpc & typeof inspectorRpc & typeof diffRpc & typeof stacktraceRpc & typeof mapstateRpc & typeof senderRpc & typeof catalogRpc & typeof sentryRpc & typeof gbeRouterRpc & typeof gbeProbeRpc & typeof attributesRpc & typeof dataCenterRpc & typeof protoDescriptorCaptureRpc & typeof filesystemRpc;

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
        ...sentryRpc,
        ...gbeRouterRpc,
        ...gbeProbeRpc,
        ...attributesRpc,
        ...dataCenterRpc,
        ...protoDescriptorCaptureRpc,
        ...filesystemRpc,
    } as AllRpc;
}
