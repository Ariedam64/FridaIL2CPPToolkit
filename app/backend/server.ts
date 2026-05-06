// app/backend/server.ts
import express from "express";
import * as path from "node:path";

import { Session } from "./session.js";
import { mountApiCall } from "./routes/api-call.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = "127.0.0.1";

// process.cwd() is always app/ (npm sets cwd to package.json directory),
// so this resolves to <repo>/build/rpc-agent.js in both dev and prod.
const agentScriptPath = process.env.FRIDA_AGENT_SCRIPT
    ?? path.resolve(process.cwd(), "../build/rpc-agent.js");

const session = new Session(agentScriptPath);
const app = express();
app.use(express.json({ limit: "5mb" }));

mountApiCall(app, { fridaClient: session.fridaClient });

app.listen(PORT, HOST, () => {
    console.log(`[frida-toolkit] backend listening on http://${HOST}:${PORT}`);
    console.log(`[frida-toolkit] agent script: ${agentScriptPath}`);
});
