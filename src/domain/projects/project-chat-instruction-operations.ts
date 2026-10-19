import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  ProjectChatInstructions,
  ProjectChatInstructionsGet,
  ProjectChatInstructionsUpdate,
  type ProjectChatInstructionsControl,
} from "../../contracts/projects/project-chat-instructions";

export function createProjectChatInstructionOperations(
  control: ProjectChatInstructionsControl,
): CakeOperationDefinition[] {
  const guidance = [
    "This text is included only in the named registered project’s permanent Project Chat, never coding Project Session prompts, AGENTS.md, or shared Cake Chat instructions.",
    "Use the exact registered projectPath from projects.list or project.settings.get, never a worktree path. Project Chats and coding Project Sessions can target only their own registered project; global Cake Chat can target any registered project.",
    "The same text appears in that project's settings → Project Chat instructions. Changes apply on the next Project Chat message.",
  ];
  return [
    {
      command: "settings.project-chat.get",
      topic: "settings",
      summary: "Read one registered project's permanent Project Chat instructions.",
      guidance,
      inputSchema: ProjectChatInstructionsGet,
      outputSchema: ProjectChatInstructions,
      examples: [{ input: { projectPath: "/path/to/project" } }],
      result: "The exact registered projectPath and persisted instructions (empty if unset).",
      async execute(input, context) {
        context.signal.throwIfAborted();
        return control.get(
          await Schema.decodeUnknownPromise(ProjectChatInstructionsGet)(input),
          context.signal,
        );
      },
    },
    {
      command: "settings.project-chat.update",
      topic: "settings",
      summary: "Save only one registered project's permanent Project Chat instructions.",
      guidance: [
        ...guidance,
        "First read settings.project-chat.get; pass its exact text as expectedInstructions and complete merged text as instructions. Preserve unrelated user guidance. A stale read fails; read and merge again.",
        "Empty instructions explicitly clears them. Read back the same projectPath before claiming success. Storage failures never return success. Never silently substitute settings.cake-chat.update if this operation is unavailable.",
      ],
      inputSchema: ProjectChatInstructionsUpdate,
      outputSchema: ProjectChatInstructions,
      examples: [
        {
          input: {
            projectPath: "/path/to/project",
            expectedInstructions: "",
            instructions: "Discuss tradeoffs before delegating.",
          },
        },
      ],
      result:
        "The projectPath and committed instructions. Validation, scope, conflict and persistence errors fail the operation.",
      async execute(input, context) {
        context.signal.throwIfAborted();
        return control.update(
          await Schema.decodeUnknownPromise(ProjectChatInstructionsUpdate)(input),
          context.signal,
        );
      },
    },
  ];
}
