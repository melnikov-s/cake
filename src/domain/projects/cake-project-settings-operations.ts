import { type JsonObject } from "../../contracts/serialization/json-contract";

import {
  CurrentProjectSettingsGetInput,
  CurrentProjectSettingsUpdateInput,
  projectIconPathGuidance,
} from "../../contracts/projects/project-settings-schema";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

export function createAgentProjectSettingsOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  const invokeAppControl =
    (command: string): CakeOperationDefinition["execute"] =>
    (input, context) => {
      // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
      return api().invokeAppControl(command, input as JsonObject, context.signal);
    };
  return [
    {
      command: "project.settings.get",
      requires: "invokeAppControl",
      topic: "project",
      summary: "Read this project's settings",
      guidance: [
        "This singular project.* operation always targets the calling Project and never accepts a project path.",
      ],
      inputSchema: CurrentProjectSettingsGetInput,
      examples: [{}],
      result: "The calling Project's path and effective settings.",
      execute: invokeAppControl("project.settings.get"),
    },
    {
      command: "project.settings.update",
      requires: "invokeAppControl",
      topic: "project",
      summary: "Patch this project's settings",
      guidance: [
        "Call project.settings.get before updating the Project. Unspecified settings remain unchanged.",
        "customInstructions: coding sessions. projectChatInstructions: permanent chat. Never move text without authorization; verify afterward.",
        projectIconPathGuidance,
        "For Project Chat guidance prefer settings.project-chat.get/update: explicit registered project identity, exact expectedInstructions, and conflict-safe persistence. Never fall back silently to shared settings.cake-chat.update.",
        "This singular project.* operation always targets the calling Project and never accepts a project path.",
      ],
      inputSchema: CurrentProjectSettingsUpdateInput,
      examples: [
        {
          input: {
            changes: {
              worktreeSetupInstructions:
                "Remove the node_modules symlink before running pnpm install.",
            },
          },
        },
      ],
      result: "The calling Project's path and committed settings.",
      execute: invokeAppControl("project.settings.update"),
    },
  ];
}
