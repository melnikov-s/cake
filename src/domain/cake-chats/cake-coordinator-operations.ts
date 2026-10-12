import { Schema } from "effect";
import { CakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import type { CakeOperationProviders } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

export function createCoordinatorOperations(
  bridge: Parameters<CakeOperationProviders["coordinator"]>[1],
): CakeOperationDefinition[] {
  return [
    ...[
      {
        command: "session.info",
        topic: "sessions",
        summary: "Inspect the permanent global coordinator.",
        execute: bridge.info,
      },
      {
        command: "session.usage",
        topic: "sessions",
        summary: "Inspect coordinator usage.",
        execute: bridge.usage,
      },
      {
        command: "context.status",
        topic: "context",
        summary: "Inspect the active bounded context.",
        execute: bridge.contextStatus,
      },
      {
        command: "context.compact",
        topic: "context",
        summary: "Compact the active run.",
        execute: bridge.compact,
      },
    ].map((operation) => ({
      ...operation,
      inputSchema: Schema.Struct({}),
      examples: [{}],
      result: "Coordinator facts.",
    })),
    {
      command: "session.set-model",
      topic: "sessions",
      summary: "Select a configured coordinator model.",
      inputSchema: Schema.Struct({ model: CakeModelSelection }),
      examples: [{ input: { model: "Sol" } }],
      result: "The selected model.",
      async execute(input) {
        // SAFETY: the operation registry decoded this input with the declared schema.
        const { model } = input as { model: CakeModelSelection };
        const resolved = bridge.resolveModel(model);
        await bridge.setModel(resolved);
        return resolved;
      },
    },
  ];
}
