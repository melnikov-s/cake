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
    summary: "Discover bridge commands/schemas",
    inputSchema: ArtifactCommandDiscoveryInput,
    outputSchema: Schema.Json,
  },
  {
    command: "artifacts.command",
    summary: "Call artifact bridge command",
    inputSchema: ArtifactCakeCallInput,
    outputSchema: Schema.Json,
  },
  {
    command: "artifacts.globals",
    summary: "List global artifacts",
    inputSchema: AgentListInput,
    outputSchema: GlobalArtifactListOutput,
  },
  {
    command: "artifacts.inspect",
    summary: "Inspect artifact",
    inputSchema: ArtifactIdentityInput,
    outputSchema: Schema.Struct({
      artifact: ArtifactLineageSummary,
      execution: ArtifactExecutionStatus,
    }),
  },
  {
    command: "artifacts.viewing",
    summary: "Identify viewed artifacts/window",
    inputSchema: Schema.Struct({}),
    outputSchema: ArtifactViewing,
  },
  {
    command: "artifacts.set-global",
    summary: "Set global retention",
    inputSchema: ArtifactSetGlobalInput,
    outputSchema: ArtifactLineageSummary,
  },
  {
    command: "artifacts.delete",
    summary: "Delete artifact, schedules and data",
    inputSchema: ArtifactIdentityInput,
    outputSchema: Schema.Struct({ deleted: Schema.Boolean }),
  },
  {
    command: "artifacts.tools",
    summary: "Discover semantic tools/schemas",
    inputSchema: ArtifactIdentityInput,
    outputSchema: ArtifactToolListOutput,
  },
  {
    command: "artifacts.call",
    summary: "Call semantic tool",
    inputSchema: ArtifactToolCallInput,
    outputSchema: Schema.Json,
  },
  {
    command: "artifacts.runtime.publish",
    summary: "Publish trusted backend logic",
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
    summary: "Schedule artifact handler",
    inputSchema: ArtifactScheduleConfigureInput,
    outputSchema: ArtifactSchedule,
  },
  {
    command: "artifacts.schedules.list",
    summary: "List schedules/receipts",
    inputSchema: ArtifactIdentityInput,
    outputSchema: Schema.Array(ArtifactSchedule),
  },
  {
    command: "artifacts.schedules.remove",
    summary: "Remove schedule",
    inputSchema: ArtifactScheduleIdentity,
    outputSchema: Schema.Struct({ removed: Schema.Boolean }),
  },
] as const;

export const handlesGlobalArtifactCommand = (command: string) =>
  globalArtifactOperationContracts.some((operation) => operation.command === command);
