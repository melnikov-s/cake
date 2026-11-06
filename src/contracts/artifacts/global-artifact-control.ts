import { Schema } from "effect";
import { AgentListInput } from "../agent/agent-list-data";
import {
  ArtifactLineageId,
  ArtifactRevisionNumber,
  ArtifactLineageSummary,
} from "./artifact-lineage";
import { ArtifactRuntimeDescriptor, ArtifactRuntimeTool } from "./artifact-runtime-descriptor";
import { ArtifactRuntimeStatus } from "./artifact-runtime";
import {
  ArtifactSchedule,
  ArtifactScheduleConfigureInput,
  ArtifactScheduleIdentity,
} from "./artifact-schedules";
import { ArtifactViewing } from "./artifact-viewing";

export const ArtifactIdentityInput = Schema.Struct({ lineageId: ArtifactLineageId });
export const ArtifactToolCallInput = Schema.Struct({
  ...ArtifactIdentityInput.fields,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  input: Schema.Json,
});
export const ArtifactCommandDiscoveryInput = Schema.Struct({
  command: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
export const ArtifactCakeCallInput = Schema.Struct({
  ...ArtifactIdentityInput.fields,
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  input: Schema.Json,
});
export const ArtifactSetGlobalInput = Schema.Struct({
  ...ArtifactIdentityInput.fields,
  global: Schema.Boolean,
});
export const ArtifactRuntimePublishInput = Schema.Struct({
  ...ArtifactIdentityInput.fields,
  expectedRevision: ArtifactRevisionNumber,
  runtime: ArtifactRuntimeDescriptor,
});
const GlobalArtifactListOutput = Schema.Struct({
  artifacts: Schema.Array(ArtifactLineageSummary).check(Schema.isMaxLength(50)),
  total: Schema.Int,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
});
const ArtifactToolListOutput = Schema.Struct({
  ...ArtifactIdentityInput.fields,
  revision: ArtifactRevisionNumber,
  tools: Schema.Array(ArtifactRuntimeTool),
});
export const ArtifactExecutionStatus = Schema.Struct({
  ...ArtifactRuntimeStatus.fields,
  executable: Schema.Boolean,
  backgroundPaused: Schema.Boolean,
  schedules: Schema.Array(ArtifactSchedule),
});
export interface ArtifactExecutionStatus extends Schema.Schema.Type<
  typeof ArtifactExecutionStatus
> {}

export const globalArtifactOperationContracts = [
  {
    command: "artifacts.commands",
    summary:
      "Discover canonical Cake bridge commands or inspect one command's validated input schema.",
    inputSchema: ArtifactCommandDiscoveryInput,
    outputSchema: Schema.Json,
  },
  {
    command: "artifacts.command",
    summary:
      "Invoke a canonical Cake command for an artifact, preserving the actual caller when present. Host filesystem/network commands also work without a session.",
    inputSchema: ArtifactCakeCallInput,
    outputSchema: Schema.Json,
  },
  {
    command: "artifacts.globals",
    summary: "List globally retained artifacts, including documents and executable widgets.",
    inputSchema: AgentListInput,
    outputSchema: GlobalArtifactListOutput,
  },
  {
    command: "artifacts.inspect",
    summary: "Inspect one artifact's current metadata and execution state.",
    inputSchema: ArtifactIdentityInput,
    outputSchema: Schema.Struct({
      artifact: ArtifactLineageSummary,
      execution: ArtifactExecutionStatus,
    }),
  },
  {
    command: "artifacts.viewing",
    summary:
      "Identify visible and active artifacts, including fullscreen, in the caller's window and other connected windows.",
    inputSchema: Schema.Struct({}),
    outputSchema: ArtifactViewing,
  },
  {
    command: "artifacts.set-global",
    summary: "Retain an artifact globally, or remove its independent retention root.",
    inputSchema: ArtifactSetGlobalInput,
    outputSchema: ArtifactLineageSummary,
  },
  {
    command: "artifacts.delete",
    summary: "Stop and permanently delete an artifact, its schedules and Cake-owned data.",
    inputSchema: ArtifactIdentityInput,
    outputSchema: Schema.Struct({ deleted: Schema.Boolean }),
  },
  {
    command: "artifacts.tools",
    summary:
      "Discover an artifact's semantic tools and typed input/output JSON schemas without starting it.",
    inputSchema: ArtifactIdentityInput,
    outputSchema: ArtifactToolListOutput,
  },
  {
    command: "artifacts.call",
    summary: "Invoke one semantic artifact tool, even while its view is closed.",
    inputSchema: ArtifactToolCallInput,
    outputSchema: Schema.Json,
  },
  {
    command: "artifacts.runtime.publish",
    summary:
      "Publish trusted backend logic and typed semantic tools for an existing widget, retaining its view and private data.",
    inputSchema: ArtifactRuntimePublishInput,
    outputSchema: Schema.Struct({ lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber }),
  },
  ...(["status", "start", "pause", "resume", "restart"] as const).map((action) => ({
    command: `artifacts.runtime.${action}` as const,
    summary: `${action.charAt(0).toUpperCase()}${action.slice(1)} artifact logic; opening a view never resumes paused background work.`,
    inputSchema: ArtifactIdentityInput,
    outputSchema: ArtifactExecutionStatus,
  })),
  {
    command: "artifacts.schedules.configure",
    summary:
      "Configure a durable deterministic schedule invoking an artifact handler without an LLM or Pi session.",
    inputSchema: ArtifactScheduleConfigureInput,
    outputSchema: ArtifactSchedule,
  },
  {
    command: "artifacts.schedules.list",
    summary: "List one artifact's durable schedules and latest execution receipts.",
    inputSchema: ArtifactIdentityInput,
    outputSchema: Schema.Array(ArtifactSchedule),
  },
  {
    command: "artifacts.schedules.remove",
    summary: "Remove one named artifact schedule.",
    inputSchema: ArtifactScheduleIdentity,
    outputSchema: Schema.Struct({ removed: Schema.Boolean }),
  },
] as const;

export const handlesGlobalArtifactCommand = (command: string) =>
  globalArtifactOperationContracts.some((operation) => operation.command === command);
