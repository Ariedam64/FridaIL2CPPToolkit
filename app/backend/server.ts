// app/backend/server.ts
import express from "express";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";

import { Session } from "./session.js";
import { mountApiCall } from "./routes/api-call.js";
import { mountProfile } from "./routes/profile.js";
import { mountLabels } from "./routes/labels.js";
import { mountAnnotations } from "./routes/annotations.js";
import { mountHooks } from "./routes/hooks.js";
import { mountMigrations } from "./routes/migrations.js";
import { mountNetwork } from "./routes/network.js";
import { mountInstances } from "./routes/instances.js";
import { mountScripts } from "./routes/scripts.js";
import { mountNetworkEventBus } from "./core/network/event-bus.js";
import { mountWsBridge } from "./ws-bridge.js";
import { mountAllPluginBackends } from "./plugins/registry.js";

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
mountNetwork(app, { session });
mountInstances(app, { session });
mountScripts(app, {
    loader: () => session.scriptLoader(),
    runner: () => session.scriptRunner(),
});
mountAllPluginBackends(app, { session });
mountNetworkEventBus(session);

const server = http.createServer(app);
mountWsBridge(server, session);

// Serve the built frontend in production. In dev, vite serves it on port 5173
// and proxies /api/ + /events to this backend. The static path matches vite's
// build output (vite.config.ts sets outDir to "../dist/frontend").
const frontendDist = path.resolve(process.cwd(), "dist/frontend");
if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("*", (_req, res) => {
        res.sendFile(path.join(frontendDist, "index.html"));
    });
}

server.listen(PORT, HOST, () => {
    console.log(`[frida-toolkit] backend listening on http://${HOST}:${PORT}`);
    console.log(`[frida-toolkit] ws events at ws://${HOST}:${PORT}/events`);
    console.log(`[frida-toolkit] agent script: ${agentScriptPath}`);
});
