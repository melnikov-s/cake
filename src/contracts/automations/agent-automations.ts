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
    summary: "List automations",
    result: "Summaries, total, offset and nextOffset; no task bodies or transcripts.",
  },
  {
    command: "automations.inspect",
    summary: "Inspect automation metadata",
    result:
      "Configuration, prompt character count and attachment metadata. Use automations.read-task for task text.",
  },
  {
    command: "automations.read-task",
    summary: "Read saved task",
    result: "Text, totalChars and nextOffset; default 4000, maximum 20000 characters.",
  },
  {
    command: "automations.create",
    summary: "Create automation",
    result: "Saved identity and configuration metadata; no execution starts until a trigger fires.",
  },
  {
    command: "automations.update",
    summary: "Edit saved fields; accepted work unchanged",
    result: "Updated configuration metadata.",
  },
  {
    command: "automations.activate",
    summary: "Activate automation",
    result: "Active state and current activity; accepted queued work may start.",
  },
  {
    command: "automations.pause",
    summary: "Pause triggers; keep running work/queue",
    result: "Paused state; this does not stop running sessions.",
  },
  {
    command: "automations.archive",
    summary: "Retire automation; cancel queued work",
    result: "Archived state; memory and history remain.",
  },
  {
    command: "automations.trigger",
    summary: "Run now; preserve paused state",
    result:
      "Started with run/session IDs, queued, skipped or blocked with the occurrence ID and reason.",
  },
  {
    command: "automations.history",
    summary: "List trigger outcomes/run links",
    result:
      "A bounded page of occurrence metadata and run links, total and nextOffset; no task bodies or transcripts.",
  },
  {
    command: "automations.cancel-run",
    summary: "Stop running automation session",
    result: "Run identity after requesting cancellation.",
  },
  {
    command: "automations.cancel-queued",
    summary: "Cancel queued occurrence",
    result: "Canceled occurrence identity.",
  },
  {
    command: "automations.memory",
    summary: "Read shared memory",
    result: "Budgeted summary lines with id+n ranges for Zoom.",
  },
  {
    command: "automations.zoom-memory",
    summary: "Expand shared memory",
    result: "Children or original text; offset/maxChars apply only to leaf originals.",
  },
] as const;

export const automationSessionToolDescriptions = [
  {
    command: "projects.list",
    summary: "List projects and Project Chat addresses",
    result: "A bounded metadata page of registered Project paths, names, and Project Chat IDs.",
  },
  {
    command: "projects.info",
    summary: "Inspect registered project",
    result: "The registered Project's metadata, without opening it or reading conversations.",
  },
  {
    command: "sessions.create",
    summary: "Launch independent Project Session",
    result:
      "Started Project Session identity and link. This creates no Session Family and does not automatically relay its result to the automation.",
  },
];

export const automationMemoryToolDescriptions = [
  {
    command: "memory.read",
    summary: "Read shared automation notes",
    result: "The compact shared OptMem view, not previous session transcripts.",
  },
  {
    command: "memory.zoom",
    summary: "Expand note originals",
    result:
      "Children or paged original text; no other automation's memory is accessible through this tool.",
  },
  {
    command: "memory.write",
    summary: "Save shared automation note",
    result:
      "Saved note sourceId; ownership and author session are bound by Cake, never supplied by the model.",
  },
] as const;
