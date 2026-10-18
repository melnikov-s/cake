import { PendingReportAcknowledge, PendingReportRead } from "../conversations/pending-report";
import { CompletionInboxUpdate } from "../conversations/completion-inbox";
import { ResultDelivery } from "../conversations/result-delivery";
import { Schema } from "effect";
import { SessionLabelColor } from "./application-data";
import {
  CurrentProjectSettingsGetInput,
  CurrentProjectSettingsUpdateInput,
  ProjectSettingsGetInput,
  ProjectSettingsUpdateInput,
} from "../projects/project-settings-schema";
import { SessionHistoryQuery } from "../conversations/session-query-data";
import { inputRefsSchema } from "../conversations/task-input";
import { messageRefsSchema } from "../conversations/message-reference";
import { jsonObjectSchema } from "../serialization/json-contract";
import { AgentListInput } from "../agent/agent-list-data";
import { AgentSessionListInput } from "../project-sessions/agent-session-list";
import { AgentProjectInfoInput } from "../projects/agent-projects";

const bounded = (min: number, max: number) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const trimmed = (min: number, max: number) =>
  Schema.Trim.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const id = Schema.String.check(Schema.isUUID(4));
const target = { sessionId: bounded(1, 256) };
const message = {
  resultDelivery: Schema.optionalKey(ResultDelivery),
  text: trimmed(1, 100_000),
  delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
  threadId: Schema.optionalKey(id),
  replyToMessageId: Schema.optionalKey(id),
};
const operation = <const Name extends string, Input extends Schema.Constraint>(
  name: Name,
  input: Input,
) => Schema.Struct({ name: Schema.Literal(name), arguments: input });

export const SessionLabelListInput = Schema.Struct({
  ...AgentListInput.fields,
  projectPath: Schema.optionalKey(bounded(1, 4096)),
});

/** Shared decoding for backend-owned application controls. Window selection/layout is deliberately absent. */
export const BackendAgentInvocation = Schema.Union([
  operation("settings.sections", Schema.Struct({})),
  operation("projects.list", AgentListInput),
  operation("projects.info", AgentProjectInfoInput),
  operation("project.settings.get", CurrentProjectSettingsGetInput),
  operation("project.settings.update", CurrentProjectSettingsUpdateInput),
  operation("projects.settings.get", ProjectSettingsGetInput),
  operation("projects.settings.update", ProjectSettingsUpdateInput),
  operation("session-labels.list", SessionLabelListInput),
  operation(
    "session-labels.add",
    Schema.Struct({
      name: trimmed(1, 40),
      color: SessionLabelColor,
      projectPath: Schema.optionalKey(bounded(1, 4096)),
    }),
  ),
  operation(
    "session-labels.update",
    Schema.Struct({
      labelId: id,
      name: Schema.optionalKey(trimmed(1, 40)),
      color: Schema.optionalKey(SessionLabelColor),
    }),
  ),
  operation("session-labels.remove", Schema.Struct({ labelId: id })),
  operation(
    "session-labels.reorder",
    Schema.Struct({
      labelId: id,
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(99)),
    }),
  ),
  operation("sessions.list", AgentSessionListInput),
  operation("sessions.info", Schema.Struct(target)),
  operation("sessions.list-family", AgentListInput),
  operation(
    "sessions.set-labels",
    Schema.Struct({
      ...target,
      labelIds: Schema.Array(id).check(Schema.isMaxLength(100), Schema.isUnique()),
    }),
  ),
  operation("sessions.history", Schema.Struct({ ...target, ...SessionHistoryQuery.fields })),
  operation("sessions.compactions", Schema.Struct({ ...target, ...SessionHistoryQuery.fields })),
  operation("sessions.tree", Schema.Struct({ ...target, ...SessionHistoryQuery.fields })),
  operation("sessions.context", Schema.Struct(target)),
  operation("sessions.usage", Schema.Struct(target)),
  operation("sessions.commands", Schema.Struct(target)),
  operation(
    "sessions.cake",
    Schema.Struct({
      ...target,
      command: bounded(1, 256),
      input: Schema.optionalKey(jsonObjectSchema),
    }),
  ),
  operation(
    "sessions.send",
    Schema.Struct({
      ...target,
      ...message,
      inputRefs: Schema.optionalKey(inputRefsSchema),
      messageRefs: Schema.optionalKey(messageRefsSchema),
      maxMessages: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
      ),
    }),
  ),
  operation("sessions.reply", Schema.Struct(message)),
  operation("sessions.reports", AgentListInput),
  operation("sessions.reports.read", PendingReportRead),
  operation("sessions.reports.acknowledge", PendingReportAcknowledge),
  operation("sessions.completions", AgentListInput),
  operation("sessions.completions.update", CompletionInboxUpdate),
  operation("sessions.thread", Schema.Struct({ threadId: Schema.optionalKey(id) })),
  operation("sessions.close-thread", Schema.Struct({ threadId: Schema.optionalKey(id) })),
]);
export type BackendAgentInvocation = Schema.Schema.Type<typeof BackendAgentInvocation>;

export const backendAgentCommands: ReadonlySet<string> = new Set([
  "settings.sections",
  "projects.list",
  "projects.info",
  "project.settings.get",
  "project.settings.update",
  "projects.settings.get",
  "projects.settings.update",
  "session-labels.list",
  "session-labels.add",
  "session-labels.update",
  "session-labels.remove",
  "session-labels.reorder",
  "sessions.list",
  "sessions.list-family",
  "sessions.set-labels",
  "sessions.info",
  "sessions.history",
  "sessions.compactions",
  "sessions.tree",
  "sessions.context",
  "sessions.usage",
  "sessions.commands",
  "sessions.cake",
  "sessions.send",
  "sessions.reply",
  "sessions.thread",
  "sessions.close-thread",
  "sessions.reports",
  "sessions.reports.read",
  "sessions.reports.acknowledge",
  "sessions.completions",
  "sessions.completions.update",
]);
