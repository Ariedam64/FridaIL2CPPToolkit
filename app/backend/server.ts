// app/backend/server.ts
import express from "express";
import * as path from "node:path";
import * as http from "node:http";

import { Session } from "./session.js";
import { mountApiCall } from "./routes/api-call.js";
import { mountProfile } from "./routes/profile.js";
import { mountLabels } from "./routes/labels.js";
import { mountAnnotations } from "./routes/annotations.js";
import { mountHooks } from "./routes/hooks.js";
import { mountMigrations } from "./routes/migrations.js";
import { mountWsBridge } from "./ws-bridge.js";

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
mountProfile(app, { session });
mountLabels(app, { session });
mountAnnotations(app, { session });
mountHooks(app, { session });
mountMigrations(app, { session });

const server = http.createServer(app);
mountWsBridge(server, session);

server.listen(PORT, HOST, () => {
    console.log(`[frida-toolkit] backend listening on http://${HOST}:${PORT}`);
    console.log(`[frida-toolkit] ws events at ws://${HOST}:${PORT}/events`);
    console.log(`[frida-toolkit] agent script: ${agentScriptPath}`);
});
