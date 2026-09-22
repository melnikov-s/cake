import { Schema } from "effect";
import { SessionPluginControls } from "../../../domain/application/session-plugin-controls";
import type { SessionPlugin } from "../../../domain/application/application-data";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../../../ipc/json-contract";
import type { InlineWidgetGenerationRequest } from "./sidecar-runtime";
import type { CakeOperationDefinition } from "./cake-operation-registry";

const pluginId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const identity = {
  id: pluginId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
};
const pluginBrief = Schema.Union([
  Schema.Struct({
    ...identity,
    brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
    data: Schema.optionalKey(Schema.Json),
    initialState: Schema.optionalKey(Schema.Json),
  }),
  Schema.Struct({
    ...identity,
    preset: Schema.Literal("action-bar"),
    initialState: SessionPluginControls,
  }),
]);

export interface SessionPluginControl {
  readonly sessionId: string;
  readonly generate: (input: InlineWidgetGenerationRequest) => Promise<{
    readonly source: string;
    readonly generationSessionId: string;
  }>;
  readonly present: (plugin: SessionPlugin) => Promise<void>;
  readonly setState: (pluginId: string, state: JsonValue) => Promise<void>;
  readonly patchState: (pluginId: string, patch: JsonObject) => Promise<void>;
  readonly delete: (pluginId: string) => Promise<void>;
}

export function createCakeSessionPluginOperations(
  control: SessionPluginControl,
): CakeOperationDefinition[] {
  return [
    {
      command: "plugins.present",
      topic: "plugins",
      summary:
        "Mount prebuilt session controls, or generate custom UI, above this session's composer.",
      guidance: [
        "Use Session Plugins for task-specific controls that should remain attached to this session, such as Previous/Next guided-tour navigation.",
        "Prefer preset: action-bar with initialState: { label, actions: [{ id, label, message, primary?, disabled? }], progress?: { current, total } }. No generation is needed. Use Previous/Next/Done actions for guided navigation, or Continue/Explain this/Done for Draw.",
        "Actions send their exact message visibly to the owning session. They do not advance progress, undo a board, or remove the plugin automatically. Update state after completing a step; a Done message can request plugins.delete while preserving the board.",
        "For genuinely custom UI, supply brief instead of preset. A private builder writes React using useCake, usePluginState, useSharedState and Cake semantic theme tokens.",
        "Presenting the same ID replaces the implementation while preserving creation time and the user's hidden preference. Users can Hide/Show controls without messaging the agent. Ordinary chat remains available.",
      ],
      inputSchema: Schema.Struct({ plugin: pluginBrief }),
      examples: [
        {
          input: {
            plugin: {
              id: "draw-guide",
              title: "Draw guide",
              preset: "action-bar",
              initialState: {
                label: "Current topic",
                actions: [
                  {
                    id: "continue",
                    label: "Continue",
                    primary: true,
                    message:
                      "Continue with one meaningful Draw step, then update draw-guide's topic.",
                  },
                  {
                    id: "explain",
                    label: "Explain this",
                    message: "Clarify the current Draw point or selection.",
                  },
                  {
                    id: "done",
                    label: "Done",
                    message:
                      "Remove the draw-guide plugin using plugins.delete. Preserve the Draw board.",
                  },
                ],
              },
            },
          },
        },
        {
          input: {
            plugin: {
              id: "guided-steps",
              title: "Guided steps",
              preset: "action-bar",
              initialState: {
                label: "Introduction",
                progress: { current: 1, total: 4 },
                actions: [
                  {
                    id: "previous",
                    label: "Previous",
                    disabled: true,
                    message: "Revisit the previous step; do not undo board changes.",
                  },
                  {
                    id: "next",
                    label: "Next",
                    primary: true,
                    message: "Explain the next step, then update guided-steps progress.",
                  },
                  {
                    id: "done",
                    label: "Done",
                    message: "End the guide and delete guided-steps. Preserve existing work.",
                  },
                ],
              },
            },
          },
        },
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
        const now = new Date().toISOString();
        if ("preset" in request) {
          await control.present({
            sessionId: control.sessionId,
            id: request.id,
            title: request.title,
            slot: "composer.above",
            preset: request.preset,
            state: request.initialState,
            createdAt: now,
            updatedAt: now,
          });
          return { id: request.id, slot: "composer.above", status: "mounted" };
        }
        const generated = await control.generate({
          sessionId: control.sessionId,
          brief: request.brief,
          data: request.data,
          initialState: request.initialState ?? null,
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
      command: "plugins.patch",
      topic: "plugins",
      summary:
        "Atomically patch top-level plugin state fields, preserving omitted fields and user visibility.",
      inputSchema: Schema.Struct({ id: pluginId, patch: jsonObjectSchema }),
      examples: [
        {
          input: {
            id: "draw-guide",
            patch: { label: "Next point", progress: { current: 2, total: 5 } },
          },
        },
      ],
      result: "The updated plugin identity; no state echo.",
      limitations: [
        "Shallow merge only: nested objects and arrays replace as units, null is a value (not deletion). Existing state must be an object. The complete merged preset state is validated atomically; a missing plugin or invalid patch fails without changes.",
      ],
      async execute(input) {
        // SAFETY: CakeOperationRegistry decoded input with this operation's schema.
        const { id, patch } = input as { id: string; patch: JsonObject };
        await control.patchState(id, patch);
        return { id, updated: true };
      },
    },
    {
      command: "plugins.update",
      topic: "plugins",
      summary:
        "Replace durable plugin state without regeneration or changing the user's hidden preference.",
      guidance: [
        "For action-bar, update requires the complete { label, actions, progress? } configuration. Prefer plugins.patch for label/progress changes without resending actions. Keep message intent explicit; progress changes only when updated, never optimistically on click.",
      ],
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
