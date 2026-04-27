/* Tiny route table: { method: { path: handler(req, res, parsedQuery) } }.
 * Supports exact-match routes and parameterized routes via `METHOD_param` keys.
 * Parameterized handler signature: (req, res, query, slug).
 */
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
            // Exact match first
            const exact = routes[req.method]?.[parsed.pathname];
            if (exact) return await exact(req, res, parsed.query);
            // Parameterized match: routes[`${METHOD}_param`] = { "/prefix": handler(req,res,query,slug) }
            const paramRoutes = routes[`${req.method}_param`] || {};
            for (const [prefix, handler] of Object.entries(paramRoutes)) {
                if (parsed.pathname.startsWith(prefix + "/")) {
                    const slug = parsed.pathname.slice(prefix.length + 1);
                    if (!slug.includes("/")) return await handler(req, res, parsed.query, slug);
                }
            }
            if (fallback) return await fallback(req, res, parsed.pathname);
            res.writeHead(404); res.end("not found");
        } catch (e) {
            console.error("[http]", e);
            sendJson(res, 500, { error: String(e.message || e) });
        }
    };
}

module.exports = { makeHandler, sendJson, readBody };
