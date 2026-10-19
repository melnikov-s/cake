import { type JsonObject } from "../../contracts/serialization/json-contract";

import {
  CurrentProjectSettingsGetInput,
  CurrentProjectSettingsUpdateInput,
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
      summary: "Read every setting for the calling Project Session's Cake Project.",
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
      summary:
        "Patch any setting for the calling Project Session's Cake Project and return all committed settings.",
      guidance: [
        "Call project.settings.get before updating the Project. Unspecified settings remain unchanged.",
        "customInstructions applies only to coding Project Sessions. projectChatInstructions applies only to the permanent Project Chat and appears in Project settings → Project Chat instructions. Never move text between these fields without user authorization. Read back before claiming success.",
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
