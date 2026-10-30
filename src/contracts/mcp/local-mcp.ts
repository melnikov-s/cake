import { Schema } from "effect";
import { AgentListInput } from "../agent/agent-list-data";
import { SessionHistoryQuery } from "../conversations/session-query-data";
import { PendingReportRead } from "../conversations/pending-report";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { AgentProjectSessionCreate } from "../project-sessions/session-reporting";
import { ProjectTodo, ProjectTodoCreate, ProjectTodoUpdate } from "../projects/project-todos";

const path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const LocalMcpScope = Schema.Literals(["read", "launch", "send", "todos.write"]);
export type LocalMcpScope = typeof LocalMcpScope.Type;
export const LocalMcpConfiguration = Schema.Struct({
  directory: path,
  projects: Schema.Array(path).check(Schema.isMinLength(1), Schema.isUnique()),
  scopes: Schema.optionalKey(Schema.Array(LocalMcpScope).check(Schema.isUnique())),
});
export interface LocalMcpConfiguration extends Schema.Schema.Type<typeof LocalMcpConfiguration> {}

const project = { projectPath: path };
const session = {
  ...project,
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
};
const tool = (
  name: string,
  scope: LocalMcpScope,
  description: string,
  inputSchema: Schema.ConstraintDecoder<unknown, never>,
) => ({ name, scope, description, inputSchema });

/** Deliberate external subset, not the internal operation registry or a forwarding escape hatch. */
export const localMcpTools = [
  tool(
    "projects.list",
    "read",
    "List only the Projects allowed by this local MCP grant.",
    AgentListInput,
  ),
  tool(
    "projects.info",
    "read",
    "Read registered Project metadata and its Project Chat ID.",
    Schema.Struct(project),
  ),
  tool(
    "sessions.list",
    "read",
    "List sessions and Project Chat in one allowed Project. Launch acceptance is not completion.",
    Schema.Struct({ ...project, ...AgentListInput.fields }),
  ),
  tool(
    "sessions.info",
    "read",
    "Read session identity, lifecycle and current execution status. Use canonical IDs from sessions.list.",
    Schema.Struct(session),
  ),
  tool(
    "sessions.history",
    "read",
    "Read bounded history through Cake's ordinary task-input protection. Global Cake Chat is not accessible.",
    Schema.Struct({ ...session, ...SessionHistoryQuery.fields }),
  ),
  tool(
    "sessions.reports",
    "read",
    "List pending reports addressed to this Project Chat (not all reports in Cake).",
    Schema.Struct({ ...project, ...AgentListInput.fields }),
  ),
  tool(
    "sessions.reports.read",
    "read",
    "Read a pending report addressed to this Project Chat.",
    Schema.Struct({ ...project, ...PendingReportRead.fields }),
  ),
  tool(
    "sessions.create",
    "launch",
    "Launch a session in a registered, trusted Project. Returns admission, not completed work. Uses Cake's normal model defaults when omitted; ordinary Project Chat notification delivery applies.",
    Schema.Struct({
      ...project,
      name: AgentProjectSessionCreate.fields.name,
      initialPrompt: AgentProjectSessionCreate.fields.initialPrompt,
      worktreeName: AgentProjectSessionCreate.fields.worktreeName,
      model: Schema.optionalKey(CakeModelSelection),
    }),
  ),
  tool(
    "sessions.send",
    "send",
    "Send ordinary text as this Project Chat to a Project Session in the same Project. Returns admission, not completion; does not grant trust or approve tools.",
    Schema.Struct({ ...session, text: AgentProjectSessionCreate.fields.initialPrompt }),
  ),
  tool(
    "todos.list",
    "read",
    "List compact Project to-dos. Does not inspect linked sessions in other Projects.",
    Schema.Struct({
      ...project,
      ...AgentListInput.fields,
      state: Schema.optionalKey(ProjectTodo.fields.state),
    }),
  ),
  tool(
    "todos.read",
    "read",
    "Read a Project to-do and its associated work lifecycle.",
    Schema.Struct({ ...project, id: ProjectTodo.fields.id }),
  ),
  tool(
    "todos.create",
    "todos.write",
    "Create a Project to-do without work associations. No session lifecycle changes.",
    Schema.Struct({
      ...project,
      title: ProjectTodoCreate.fields.title,
      description: ProjectTodoCreate.fields.description,
    }),
  ),
  tool(
    "todos.update",
    "todos.write",
    "Revision-checked title, description, status or done/reopen edit. Preserves associations; never resolves, deletes or merges sessions.",
    Schema.Struct({
      ...project,
      id: ProjectTodo.fields.id,
      expectedRevision: ProjectTodoUpdate.fields.expectedRevision,
      title: ProjectTodoUpdate.fields.title,
      description: ProjectTodoUpdate.fields.description,
      status: ProjectTodoUpdate.fields.status,
      state: ProjectTodoUpdate.fields.state,
    }),
  ),
];

export class LocalMcpError extends Schema.TaggedError<LocalMcpError>()("LocalMcpError", {
  code: Schema.Literals(["denied", "unsupported", "invalid_input", "operation_failed"]),
  message: Schema.String,
}) {}
