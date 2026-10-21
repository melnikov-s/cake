import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  ProjectTodo,
  ProjectTodos,
  ProjectTodoCreate,
  ProjectTodoUpdate,
  type ProjectTodoControl,
} from "../../contracts/projects/project-todos";

export function createProjectTodoOperations(
  control: ProjectTodoControl,
): CakeOperationDefinition[] {
  const guidance = [
    "Only this permanent Project Chat's lightweight user commitments, not a session/task mirror. Create with judgment when taking on open-ended work; do not import history or create one per question, tool, or worker.",
    "State is only open/done; status is freeform. Reports can remain open awaiting review; worker completion is NOT session resolution. Session-only items complete when ALL linked Project Sessions are actually resolved (user or agent). Mixed session/source items require explicit conclusion. Closing a to-do never resolves sessions. Never auto-reopen a user-closed item. No polling or wakes for open items.",
    "Strongly prefer attaching the work you launch with associations (multiple titled Project Sessions or exact source/report message refs). Undelegated discussion may have no links. Investigator handles/private Pi IDs are not navigable: use an actual launch/report message ref in its parent, discoverable with messages.list/read. Never invent a subagent-session route.",
    "Read before updating and pass expectedRevision. On conflict, reread; preserve explicit user decisions, especially closure. Update associations with the complete merged list, preserving unrelated work links.",
  ];
  return [
    {
      command: "todos.list",
      topic: "todos",
      summary: "Read this Project Chat's current to-dos and selection.",
      guidance,
      inputSchema: Schema.Struct({}),
      outputSchema: ProjectTodos,
      examples: [{ input: {} }],
      result: "Current items, selection and pending user context.",
      execute: (_input, context) => control.list(context.signal),
    },
    {
      command: "todos.read",
      topic: "todos",
      summary: "Read one to-do by stable identity.",
      guidance,
      inputSchema: Schema.Struct({ id: ProjectTodo.fields.id }),
      outputSchema: ProjectTodo,
      examples: [{ input: { id: "00000000-0000-4000-8000-000000000001" } }],
      result: "The exact item, including its current revision.",
      async execute(input, context) {
        const { id } = await Schema.decodeUnknownPromise(
          Schema.Struct({ id: ProjectTodo.fields.id }),
        )(input);
        return control.read(id, context.signal);
      },
    },
    {
      command: "todos.create",
      topic: "todos",
      summary: "Create an open user commitment/thread in this Project Chat.",
      guidance,
      inputSchema: ProjectTodoCreate,
      outputSchema: ProjectTodo,
      examples: [{ input: { title: "Investigate slow startup", status: "Investigating" } }],
      result: "The committed open item with stable identity.",
      execute: async (input, context) =>
        control.create(await Schema.decodeUnknownPromise(ProjectTodoCreate)(input), context.signal),
    },
    {
      command: "todos.update",
      topic: "todos",
      summary: "Update a to-do's title/status/reference or explicitly mark done/reopen.",
      guidance,
      inputSchema: ProjectTodoUpdate,
      outputSchema: ProjectTodo,
      examples: [
        {
          input: {
            id: "00000000-0000-4000-8000-000000000001",
            expectedRevision: 0,
            status: "Report delivered; awaiting your review",
          },
        },
      ],
      result: "The committed item with an incremented revision. Stale updates fail.",
      execute: async (input, context) =>
        control.update(await Schema.decodeUnknownPromise(ProjectTodoUpdate)(input), context.signal),
    },
  ];
}
