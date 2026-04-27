// Frida agent entry point. Compiled by `npm run build:rpc` → build/rpc-agent.js.
import "frida-il2cpp-bridge";
import { getRpcMethods } from "./rpc-methods";

const rpcMethods = getRpcMethods();
rpc.exports = rpcMethods;

Il2Cpp.perform(() => {
    console.log("[rpc-agent] ready. Exposed methods: " + Object.keys(rpcMethods).sort().join(", "));
    send({ type: "agent-ready" });
});
