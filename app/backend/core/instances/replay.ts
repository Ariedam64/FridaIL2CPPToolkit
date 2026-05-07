import type { InstanceRegistry } from "./instance-registry";
import type { Recipe, RecipeReplayResult, RecipeStepResult } from "./types";

export interface ReplayAgent {
    captureViaGC(className: string, index: number, asKey: string): Promise<{ className: string; handle: string }>;
    captureViaHook(className: string, tickMethod: string, timeoutMs: number, asKey: string): Promise<{ className: string; handle: string }>;
    captureFieldValue(ownerKey: string, fieldName: string, asKey: string): Promise<{ className: string; handle: string }>;
    captureListElement(ownerKey: string, listFieldName: string, index: number, asKey: string): Promise<{ className: string; handle: string }>;
    captureMethodReturn(ownerKey: string, methodName: string, args: unknown[], asKey: string): Promise<{ className: string; handle: string }>;
}

export async function replayRecipe(
    recipe: Recipe,
    agent: ReplayAgent,
    registry: InstanceRegistry,
): Promise<RecipeReplayResult> {
    const steps: RecipeStepResult[] = [];

    for (let i = 0; i < recipe.steps.length; i++) {
        const step = recipe.steps[i];

        // Pre-check: chained steps must reference an existing asKey in the registry.
        if ("ownerKey" in step && !registry.get(step.ownerKey)) {
            steps.push({
                stepIndex: i, op: step.op, asKey: step.asKey, ok: false,
                error: `referenced ownerKey "${step.ownerKey}" not found in registry`,
            });
            continue;
        }

        try {
            let result: { className: string; handle: string };
            switch (step.op) {
                case "captureViaGC":
                    result = await agent.captureViaGC(step.className, step.index, step.asKey);
                    break;
                case "captureViaHook":
                    result = await agent.captureViaHook(step.className, step.tickMethod, step.timeoutMs, step.asKey);
                    break;
                case "captureFieldValue":
                    result = await agent.captureFieldValue(step.ownerKey, step.fieldName, step.asKey);
                    break;
                case "captureListElement":
                    result = await agent.captureListElement(step.ownerKey, step.listFieldName, step.index, step.asKey);
                    break;
                case "captureMethodReturn":
                    result = await agent.captureMethodReturn(step.ownerKey, step.methodName, step.args, step.asKey);
                    break;
            }
            registry.set(step.asKey, result.className, result.handle, step.op);
            steps.push({
                stepIndex: i, op: step.op, asKey: step.asKey, ok: true,
                summary: `${result.className}@${result.handle}`,
            });
        } catch (err) {
            steps.push({
                stepIndex: i, op: step.op, asKey: step.asKey, ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const okCount = steps.filter((s) => s.ok).length;
    const finalStatus: RecipeReplayResult["finalStatus"] =
        okCount === steps.length ? "ok"
      : okCount === 0            ? "failed"
                                 : "partial";
    return { steps, finalStatus };
}
