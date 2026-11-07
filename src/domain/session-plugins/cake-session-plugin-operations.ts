import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import type { SessionPluginControl } from "../../contracts/application/session-plugin-agent-control";
import { Schema } from "effect";
import { widgetConversationFromOperation } from "../widgets/widgetOperationContext";
import { SessionPluginControls } from "../../contracts/application/session-plugin-controls";

import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../../contracts/serialization/json-contract";

import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

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

export function createCakeSessionPluginOperations(
  control: SessionPluginControl,
): CakeOperationDefinition[] {
  return [
    {
      command: "plugins.present",
      topic: "plugins",
      summary: "Mount session controls",
      guidance: [
        "Use Session Plugins for task-specific controls that should remain attached to this session, such as Previous/Next guided-tour navigation.",
        "Prefer action-bar with label, actions and optional progress. No generation; actions support guided Previous/Next/Done.",
        "Actions send visible messages to owner; no automatic progress/artifact change/deletion. Update after work; Done may request plugins.delete.",
        "For genuinely custom UI, supply brief instead of preset. A private builder writes React using useCake, usePluginState, useSharedState, useSpeech and Cake semantic theme tokens.",
        "useSpeech provides speak/pause/resume/stop and sentence progress. Request it in the brief; one speaker.",
        "Presenting the same ID replaces the implementation while preserving creation time and the user's hidden preference. Users can Hide/Show controls without messaging the agent. Ordinary chat remains available.",
      ],
      inputSchema: Schema.Struct({ plugin: pluginBrief }),
      examples: [
        {
          input: {
            plugin: {
              id: "explanation-guide",
              title: "Explanation guide",
              preset: "action-bar",
              initialState: {
                label: "Current topic",
                actions: [
                  {
                    id: "continue",
                    label: "Continue",
                    primary: true,
                    message:
                      "Continue with one meaningful explanation step, then update explanation-guide's topic.",
                  },
                  {
                    id: "explain",
                    label: "Explain this",
                    message: "Clarify the current explanation point.",
                  },
                  {
                    id: "done",
                    label: "Done",
                    message:
                      "Remove the explanation-guide plugin using plugins.delete. Preserve the artifact.",
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
          parentConversation: isCakeChatSessionId(control.sessionId)
            ? undefined
            : widgetConversationFromOperation(context.runtime),
          brief: request.brief,
          data: request.data,
          initialState: request.initialState ?? null,
          fallback: request.title,
          model: context.runtime.model,
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
      summary: "Patch plugin state fields",
      inputSchema: Schema.Struct({ id: pluginId, patch: jsonObjectSchema }),
      examples: [
        {
          input: {
            id: "explanation-guide",
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
      summary: "Replace plugin state",
      guidance: [
        "update replaces full action-bar config. patch changes fields without resending actions. Update progress only after actual work.",
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
      summary: "Delete session plugin",
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
