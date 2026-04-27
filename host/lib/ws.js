/* WebSocket broadcast layer. attach(httpServer, onConnect) mounts the WSS. */
const { WebSocketServer } = require("ws");

const wsClients = new Set();

function attach(httpServer, onConnect) {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    wss.on("connection", (clientWs) => {
        wsClients.add(clientWs);
        if (onConnect) {
            try {
                const hello = onConnect();
                if (hello) clientWs.send(JSON.stringify(hello));
            } catch {}
        }
        clientWs.on("close", () => wsClients.delete(clientWs));
    });
    return wss;
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(data);
    }
}

module.exports = { attach, broadcast };
