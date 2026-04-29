#!/usr/bin/env node
/*
 * Driver: install FileDescriptor capture → wait → dump → uninstall.
 *
 * Usage:
 *   DOFUS_PORT=3001 node dofus-app/scripts/capture-proto-descriptors.js
 *
 * Prerequisite: Frida agent attached to Dofus.exe with rpc agent loaded.
 * The driver expects the candidate file at
 * dofus-app/data/runtime/filedescriptor-init-candidates.json (produced by
 * scripts/find-filedescriptor-init-rvas.py).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..", "..");
const CANDIDATES = path.join(ROOT, "dofus-app", "data", "runtime", "filedescriptor-init-candidates.json");
const OUTPUT = path.join(ROOT, "dofus-app", "data", "runtime", "protobuf-descriptors-captured.json");
const HOST = process.env.DOFUS_HOST || "localhost";
const PORT = parseInt(process.env.DOFUS_PORT || "3001", 10);

function rpc(method, args = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ method, args });
        const req = http.request({
            hostname: HOST, port: PORT, path: "/api/call",
            method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, res => {
            let chunks = "";
            res.on("data", c => chunks += c);
            res.on("end", () => { try { resolve(JSON.parse(chunks).result); } catch (e) { reject(e); } });
        });
        req.on("error", reject);
        req.write(body); req.end();
    });
}

function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (a) => { rl.close(); resolve(a); });
    });
}

async function main() {
    if (!fs.existsSync(CANDIDATES)) {
        console.error("[error] missing", CANDIDATES);
        console.error("        run: python dofus-app/scripts/find-filedescriptor-init-rvas.py");
        process.exit(1);
    }

    const candidatesJson = fs.readFileSync(CANDIDATES, "utf-8");
    console.log("[capture] installing FileDescriptor capture hooks...");

    let installResult;
    try {
        installResult = await rpc("installFileDescriptorCapture", [candidatesJson]);
    } catch (e) {
        console.error("[capture] install RPC failed:", e.message);
        process.exit(1);
    }
    console.log("[capture] install:", JSON.stringify(installResult));
    console.log("");
    console.log("Lance Dofus.exe maintenant (ou si déjà lancé, login + charge une map).");
    console.log("Les FileDescriptor s'initialisent typiquement au login screen + 1er chargement.");
    console.log("");
    await prompt("Appuie ENTER quand le client a chargé pour dumper... ");

    console.log("[capture] dumping captured descriptors...");
    let captured = [];
    try {
        captured = await rpc("getCapturedDescriptors");
    } catch (e) {
        console.error("[capture] dump RPC failed:", e.message);
    }

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(captured, null, 2));
    console.log(`[capture] wrote ${captured.length} descriptors to ${OUTPUT}`);
    for (const d of captured.slice(0, 3)) {
        const bytesLen = (d.bytes_hex || "").length / 2;
        const hexHead = (d.bytes_hex || "").slice(0, 64);
        console.log(`  ${d.class_obf_name}::${d.method_obf_name} → ${bytesLen} bytes [${hexHead}...]`);
    }

    console.log("[capture] uninstalling...");
    try {
        const r = await rpc("uninstallFileDescriptorCapture");
        console.log("[capture] uninstall:", JSON.stringify(r));
    } catch (e) {
        console.error("[capture] uninstall RPC failed:", e.message);
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
