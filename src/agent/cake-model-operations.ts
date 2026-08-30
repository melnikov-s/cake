import { z } from "zod";
import type { ModelPreset } from "../ipc/session-contract";
import type { CakeOperationDefinition } from "./cake-operation-registry";

/** Exposes only the preset lookup fields an agent needs to name a model. */
export function createCakeModelOperations(
  listPresets: () => readonly Pick<ModelPreset, "name" | "modelId">[],
): CakeOperationDefinition[] {
  return [
    {
      command: "models.list",
      topic: "models",
      summary: "List configured model preset names and model IDs.",
      inputSchema: z.object({}).strict(),
      examples: [{}],
      result: "Configured presets containing only name and modelId.",
      execute: async () => ({
        presets: listPresets().map(({ name, modelId }) => ({ name, modelId })),
      }),
    },
  ];
}
