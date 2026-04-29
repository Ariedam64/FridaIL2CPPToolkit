import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        environment: "node",
        globals: false,
        passWithNoTests: true,
        coverage: {
            provider: "v8",
            include: ["src/core/**/*.ts"],
            exclude: ["src/core/webviews/**"],
        },
    },
    resolve: {
        alias: {
            // vscode is not available in node test env; tests must mock it
            // explicitly. See test/labels.test.ts for the pattern.
        },
    },
});
