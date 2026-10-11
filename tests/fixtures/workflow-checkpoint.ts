import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowRunFixture } from "./dynamic-workflow.ts";

/** Seeds only durable main-owned data. Never launches a billed sandbox or worker. */
export async function seedWorkflowCheckpoint(
  cakeHome: string,
  ownerSessionId: string,
  projectPath: string,
) {
  const run = workflowRunFixture({ ownerSessionId, projectPath, status: "complete" });
  const directory = join(cakeHome, "state", "workflows");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${run.id}.json`),
    JSON.stringify({
      version: 1,
      checkpoint: {
        run,
        previousPrograms: [],
        inheritedModel: run.steps[0]!.resolvedModel,
        commonInstructions: "Review supported findings only.",
        workers: [],
        completionTurnIds: [],
        completionDelivery: "delivered",
      },
    }),
  );
  return run;
}
