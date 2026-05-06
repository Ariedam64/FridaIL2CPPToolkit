// app/vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
    root: "frontend",
    build: {
        outDir: "../dist/frontend",
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        proxy: {
            "/api": "http://127.0.0.1:3001",
            "/events": { target: "ws://127.0.0.1:3001", ws: true },
        },
    },
});
