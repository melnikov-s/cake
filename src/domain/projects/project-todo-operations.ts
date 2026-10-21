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
    "This permanent Project Chat's lightweight commitments. Each actual new Project Session automatically gets one linked to-do; read/update it rather than creating a duplicate. Other open-ended work and private subagents are discretionary. Do not bulk-import history or create one per question/tool.",
    "Set a clear title and short durable description in one or two sentences. Optional status is freeform latest progress, not lifecycle. State is only open/done. Report delivery and session resolve/restore NEVER change to-do state; done/reopen NEVER resolves/restores sessions. Preserve user closure. No polling or wakes for open items.",
    "Associations are optional titled useful links; omit them when nothing useful exists. One or multiple sessions, exact messages/reports, artifacts, web URLs or workspace source links are supported. Session references accept canonical identities or discovered suffixes. Private investigator handles are not navigable: link an actual launch/report message instead.",
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
      examples: [
        {
          input: {
            title: "Investigate slow startup",
            description: "Find what delays startup and recommend a focused fix.",
            status: "Investigating",
          },
        },
      ],
      result: "The committed open item with stable identity.",
      execute: async (input, context) =>
        control.create(await Schema.decodeUnknownPromise(ProjectTodoCreate)(input), context.signal),
    },
    {
      command: "todos.update",
      topic: "todos",
      summary: "Update a to-do's title/description/status/links or explicitly mark done/reopen.",
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
