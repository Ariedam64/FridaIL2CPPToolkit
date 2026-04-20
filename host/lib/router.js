/* Tiny route table: { method: { path: handler(req, res, parsedQuery) } }. */
const url = require("url");

function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", c => data += c);
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

function makeHandler(routes, fallback) {
    return async function handleRequest(req, res) {
        const parsed = url.parse(req.url, true);
        try {
            const table = routes[req.method];
            const handler = table && table[parsed.pathname];
            if (handler) return await handler(req, res, parsed.query);
            if (fallback) return await fallback(req, res, parsed.pathname);
            res.writeHead(404); res.end("not found");
        } catch (e) {
            console.error("[http]", e);
            sendJson(res, 500, { error: String(e.message || e) });
        }
    };
}

module.exports = { makeHandler, sendJson, readBody };
