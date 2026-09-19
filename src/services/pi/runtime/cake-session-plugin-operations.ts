import { Schema } from "effect";
import type { SessionPlugin } from "../../../domain/application/application-data";
import type { JsonValue } from "../../../ipc/json-contract";
import type { InlineWidgetGenerationRequest } from "./sidecar-runtime";
import type { CakeOperationDefinition } from "./cake-operation-registry";

const pluginId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const pluginBrief = Schema.Struct({
  id: pluginId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  data: Schema.optionalKey(Schema.Json),
  initialState: Schema.optionalKey(Schema.Json),
});

export interface SessionPluginControl {
  readonly sessionId: string;
  readonly generate: (input: InlineWidgetGenerationRequest) => Promise<{
    readonly source: string;
    readonly generationSessionId: string;
  }>;
  readonly present: (plugin: SessionPlugin) => Promise<void>;
  readonly setState: (pluginId: string, state: JsonValue) => Promise<void>;
  readonly delete: (pluginId: string) => Promise<void>;
}

export function createCakeSessionPluginOperations(
  control: SessionPluginControl,
): CakeOperationDefinition[] {
  return [
    {
      command: "plugins.present",
      topic: "plugins",
      summary: "Generate and mount a durable Session Plugin in a semantic session slot.",
      guidance: [
        "Use Session Plugins for task-specific controls that should remain attached to this session, such as Previous/Next guided-tour navigation.",
        "Describe behavior and state semantically. A private UI builder writes the React source with useCake, usePluginState, and useSharedState.",
        "Presenting the same ID replaces the implementation while preserving the original creation time.",
      ],
      inputSchema: Schema.Struct({ plugin: pluginBrief }),
      examples: [
        {
          input: {
            plugin: {
              id: "change-tour",
              title: "Change tour",
              brief:
                "Show Previous and Next buttons. Each sends that visible message to the owning session. Show the current and total values from durable plugin state.",
              initialState: { current: 1, total: 5 },
            },
          },
        },
      ],
      result: "The mounted Session Plugin identity and slot.",
      limitations: [
        "Session Plugins currently mount in composer.above.",
        "React useState is mount-local. usePluginState and useSharedState are durable with the owning session.",
      ],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry decoded input with this operation's schema.
        const request = (input as { plugin: typeof pluginBrief.Type }).plugin;
        const generated = await control.generate({
          sessionId: control.sessionId,
          brief: request.brief,
          data: request.data,
          fallback: request.title,
          model:
            typeof context.runtime === "object" &&
            context.runtime !== null &&
            "model" in context.runtime &&
            typeof context.runtime.model === "object" &&
            context.runtime.model !== null &&
            "provider" in context.runtime.model &&
            "id" in context.runtime.model
              ? {
                  provider: String(context.runtime.model.provider),
                  id: String(context.runtime.model.id),
                }
              : undefined,
          surface: "session-plugin",
          signal: context.signal,
        });
        const now = new Date().toISOString();
        await control.present({
          sessionId: control.sessionId,
          id: request.id,
          title: request.title,
          slot: "composer.above",
          source: generated.source,
          state: request.initialState ?? null,
          generationSessionId: generated.generationSessionId,
          createdAt: now,
          updatedAt: now,
        });
        return { id: request.id, slot: "composer.above", status: "mounted" };
      },
    },
    {
      command: "plugins.update",
      topic: "plugins",
      summary: "Replace the durable private state of a Session Plugin without regenerating it.",
      inputSchema: Schema.Struct({ id: pluginId, state: Schema.Json }),
      examples: [{ input: { id: "change-tour", state: { current: 2, total: 5 } } }],
      result: "The updated Session Plugin identity.",
      async execute(input) {
        // SAFETY: CakeOperationRegistry decoded input with this operation's schema.
        const update = input as { id: string; state: JsonValue };
        await control.setState(update.id, update.state);
        return { id: update.id, updated: true };
      },
    },
    {
      command: "plugins.delete",
      topic: "plugins",
      summary: "Permanently remove a Session Plugin from the calling session.",
      inputSchema: Schema.Struct({ id: pluginId }),
      examples: [{ input: { id: "change-tour" } }],
      result: "The deleted Session Plugin identity.",
      async execute(input) {
        // SAFETY: CakeOperationRegistry decoded input with this operation's schema.
        const removal = input as { id: string };
        await control.delete(removal.id);
        return { id: removal.id, deleted: true };
      },
    },
  ];
}
