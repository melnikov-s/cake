import { Schema } from "effect";
import { AgentListInput } from "../agent/agent-list-data";
import { AgentProjectInfoInput } from "../projects/agent-projects";
import { AgentProjectSessionCreate } from "../project-sessions/session-reporting";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { AutomationDefinition, AutomationListInput } from "./automation-data";
import {
  AutomationArchiveInput,
  AutomationCreateInput,
  AutomationHistoryInput,
  AutomationOccurrenceTarget,
  AutomationRunTarget,
  AutomationTarget,
} from "./automation-control";
import { OptMemoryZoomInput, OptMemoryWriteInput } from "../memory/opt-memory-data";

const AutomationTaskReadInput = Schema.Struct({
  ...AutomationTarget.fields,
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxChars: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 }))),
});
const AutomationMemoryZoomInput = Schema.Struct({
  ...AutomationTarget.fields,
  range: OptMemoryZoomInput.fields.range,
  offset: OptMemoryZoomInput.fields.offset,
  maxChars: OptMemoryZoomInput.fields.maxChars,
});
const SessionMemoryZoomInput = Schema.Struct({
  range: OptMemoryZoomInput.fields.range,
  offset: OptMemoryZoomInput.fields.offset,
  maxChars: OptMemoryZoomInput.fields.maxChars,
});
const SessionMemoryWriteInput = Schema.Struct({ text: OptMemoryWriteInput.fields.text });

const AutomationAgentUpdateInput = Schema.Struct({
  ...AutomationTarget.fields,
  changes: Schema.Struct({
    name: Schema.optionalKey(AutomationDefinition.fields.name),
    context: Schema.optionalKey(AutomationDefinition.fields.context),
    trigger: Schema.optionalKey(AutomationDefinition.fields.trigger),
    overlap: Schema.optionalKey(AutomationDefinition.fields.overlap),
    completion: Schema.optionalKey(AutomationDefinition.fields.completion),
    task: Schema.optionalKey(
      Schema.Struct({
        prompt: Schema.optionalKey(AutomationDefinition.fields.task.fields.prompt),
        configuration: Schema.optionalKey(AutomationDefinition.fields.task.fields.configuration),
        attachments: Schema.optionalKey(AutomationDefinition.fields.task.fields.attachments),
      }),
    ),
  }),
});

const operation = <const Name extends string, Input extends Schema.Constraint>(
  name: Name,
  input: Input,
) => Schema.Struct({ name: Schema.Literal(name), arguments: input });
export const AutomationAgentInvocation = Schema.Union([
  operation("automations.list", AutomationListInput),
  operation("automations.inspect", AutomationTarget),
  operation("automations.read-task", AutomationTaskReadInput),
  operation("automations.create", AutomationCreateInput),
  operation("automations.update", AutomationAgentUpdateInput),
  operation("automations.activate", AutomationTarget),
  operation("automations.pause", AutomationTarget),
  operation("automations.archive", AutomationArchiveInput),
  operation("automations.trigger", AutomationTarget),
  operation("automations.history", AutomationHistoryInput),
  operation("automations.cancel-run", AutomationRunTarget),
  operation("automations.cancel-queued", AutomationOccurrenceTarget),
  operation("automations.memory", AutomationTarget),
  operation("automations.zoom-memory", AutomationMemoryZoomInput),
  operation("memory.read", Schema.Struct({})),
  operation("memory.zoom", SessionMemoryZoomInput),
  operation("memory.write", SessionMemoryWriteInput),
]);
export type AutomationAgentInvocation = typeof AutomationAgentInvocation.Type;

const AutomationProjectSessionCreate = Schema.Struct({
  workspacePath: AgentProjectSessionCreate.fields.workspacePath,
  name: AgentProjectSessionCreate.fields.name,
  initialPrompt: AgentProjectSessionCreate.fields.initialPrompt,
  promptFiles: AgentProjectSessionCreate.fields.promptFiles,
  model: Schema.optionalKey(CakeModelSelection),
  markdown: AgentProjectSessionCreate.fields.markdown,
  worktreeName: AgentProjectSessionCreate.fields.worktreeName,
});
export const AutomationSessionInvocation = Schema.Union([
  ...AutomationAgentInvocation.members,
  operation("sessions.create", AutomationProjectSessionCreate),
  operation("projects.list", AgentListInput),
  operation("projects.info", AgentProjectInfoInput),
]);

export const automationToolDescriptions = [
  {
    command: "automations.list",
    summary: "List bounded automation metadata, optionally by context, state or running activity.",
    result: "Summaries, total, offset and nextOffset; no task bodies or transcripts.",
  },
  {
    command: "automations.inspect",
    summary: "Inspect one automation's settings, state and activity without reading its task body.",
    result:
      "Configuration, prompt character count and attachment metadata. Use automations.read-task for task text.",
  },
  {
    command: "automations.read-task",
    summary: "Read one saved automation prompt in bounded text slices.",
    result: "Text, totalChars and nextOffset; default 4000, maximum 20000 characters.",
  },
  {
    command: "automations.create",
    summary:
      "Create a global or explicitly project-scoped automation with a schedule or scoped event trigger.",
    result: "Saved identity and configuration metadata; no execution starts until a trigger fires.",
  },
  {
    command: "automations.update",
    summary:
      "Change selected saved fields without resending task attachments; running and queued work retain their accepted settings.",
    result: "Updated configuration metadata.",
  },
  {
    command: "automations.activate",
    summary: "Activate, resume or restore an automation after validating its context and schedule.",
    result: "Active state and current activity; accepted queued work may start.",
  },
  {
    command: "automations.pause",
    summary:
      "Pause automatic triggering while letting current sessions finish and holding the accepted queue.",
    result: "Paused state; this does not stop running sessions.",
  },
  {
    command: "automations.archive",
    summary:
      "Retire an automation and cancel queued occurrences; explicitly let running sessions finish or stop them.",
    result: "Archived state; memory and history remain.",
  },
  {
    command: "automations.trigger",
    summary: "Run an automation now, respecting overlap; a paused automation stays paused.",
    result:
      "Started with run/session IDs, queued, skipped or blocked with the occurrence ID and reason.",
  },
  {
    command: "automations.history",
    summary:
      "List globally ordered trigger outcomes and run/session links, optionally filtered by automationId; query matches captured automation names.",
    result:
      "A bounded page of occurrence metadata and run links, total and nextOffset; no task bodies or transcripts.",
  },
  {
    command: "automations.cancel-run",
    summary: "Stop one running automation session without pausing its definition.",
    result: "Run identity after requesting cancellation.",
  },
  {
    command: "automations.cancel-queued",
    summary: "Cancel one queued occurrence without creating a session.",
    result: "Canceled occurrence identity.",
  },
  {
    command: "automations.memory",
    summary: "Read an automation's compact shared OptMem view.",
    result: "Budgeted summary lines with id+n ranges for Zoom.",
  },
  {
    command: "automations.zoom-memory",
    summary: "Expand a shared memory range repeatedly to branches or exact paged originals.",
    result: "Children or original text; offset/maxChars apply only to leaf originals.",
  },
] as const;

export const automationSessionToolDescriptions = [
  {
    command: "projects.list",
    summary:
      "List registered Projects with exact paths for explicit launches or automation contexts.",
    result: "A bounded metadata page of registered Project paths, names, and Project Chat IDs.",
  },
  {
    command: "projects.info",
    summary: "Inspect a registered Project and its trust state by exact path.",
    result:
      "The registered Project's metadata and trust state, without opening it or reading conversations.",
  },
  {
    command: "sessions.create",
    summary: "Launch an independent Project Session in an explicitly selected registered project.",
    result:
      "Started Project Session identity and link. This creates no Session Family and does not automatically relay its result to the automation.",
  },
];

export const automationMemoryToolDescriptions = [
  {
    command: "memory.read",
    summary: "Read this automation session's shared memory.",
    result: "The compact shared OptMem view, not previous session transcripts.",
  },
  {
    command: "memory.zoom",
    summary: "Zoom a range from this automation's memory view down to exact original notes.",
    result:
      "Children or paged original text; no other automation's memory is accessible through this tool.",
  },
  {
    command: "memory.write",
    summary: "Write a durable note for future and concurrent sessions of this automation.",
    result:
      "Saved note sourceId; ownership and author session are bound by Cake, never supplied by the model.",
  },
] as const;
