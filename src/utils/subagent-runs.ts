import { Option, Schema } from "effect";
import { jsonValueSchema } from "../ipc/json-contract";
import { ResolvedAgentModel as resolvedAgentModelSchema } from "../domain/subagents/subagent-data";
import { toolOperationName } from "./cake-tool";
import {
  sessionUsageSchema,
  uiPartSchema,
  type SessionUsage,
  type UiPart,
} from "../ipc/session-contract";

const statusSchema = Schema.Literals(["queued", "running", "complete", "error", "aborted"]);
const profileSchema = Schema.Literals(["scout", "planner", "reviewer", "worker"]);
const runPayloadFields = {
  handleId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  task: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(profileSchema),
  status: Schema.optionalKey(statusSchema),
  resolvedModel: Schema.optionalKey(resolvedAgentModelSchema),
  streaming: Schema.optionalKey(Schema.Boolean),
  parts: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  usage: Schema.optionalKey(sessionUsageSchema),
  error: Schema.optionalKey(Schema.String),
};
const runPayloadSchema = Schema.Struct(runPayloadFields);
const gatewayInputSchema = Schema.Struct({ input: Schema.Unknown });
const payloadSchema = Schema.Struct({
  ...runPayloadFields,
  tasks: Schema.optionalKey(Schema.Array(runPayloadSchema)),
  latest: Schema.optionalKey(runPayloadSchema),
  results: Schema.optionalKey(Schema.Array(runPayloadSchema)),
  completed: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  total: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

type RunPayload = typeof runPayloadSchema.Type;
type Payload = typeof payloadSchema.Type;
type ToolPart = Extract<UiPart, { kind: "tool" }>;

export interface SubagentRun {
  key: string;
  anchorPartId: string;
  handleId?: string;
  task: string;
  profile: "scout" | "planner" | "reviewer" | "worker";
  status: "queued" | "running" | "complete" | "error" | "aborted";
  resolvedModel?: typeof resolvedAgentModelSchema.Type;
  streaming: boolean;
  parts: UiPart[];
  usage?: SessionUsage;
  error?: string;
  released: boolean;
}

function payload(value?: string): Payload | undefined {
  if (!value) return undefined;
  try {
    const parsed = Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(value));
    const gateway = Schema.decodeUnknownOption(gatewayInputSchema)(parsed);
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(payloadSchema)(
        Option.isSome(gateway) ? gateway.value.input : parsed,
      ),
    );
  } catch {
    return undefined;
  }
}

function projectedParts(value: ReadonlyArray<unknown> | undefined) {
  return (value ?? []).flatMap((part) => {
    const parsed = Schema.decodeUnknownOption(uiPartSchema)(part);
    return Option.isSome(parsed) ? [parsed.value] : [];
  });
}

function settledStatus(payloadStatus: RunPayload["status"], partState: ToolPart["state"]) {
  if (payloadStatus !== "running" && payloadStatus !== "queued")
    return payloadStatus ?? (partState === "error" ? "error" : "complete");
  if (partState === "running" || partState === "approval") return payloadStatus;
  if (partState === "error") return "error" as const;
  if (partState === "interrupted" || partState === "denied") return "aborted" as const;
  return "complete" as const;
}

function runFromPayload(
  value: RunPayload,
  anchorPartId: string,
  partState: ToolPart["state"],
  fallback?: RunPayload,
  index = 0,
): SubagentRun {
  const handleId = value.handleId ?? fallback?.handleId;
  return {
    key: handleId ?? `${anchorPartId}:${index}`,
    anchorPartId,
    handleId,
    task: value.task ?? fallback?.task ?? `Delegated task ${index + 1}`,
    profile: value.profile ?? fallback?.profile ?? "worker",
    status: settledStatus(value.status ?? fallback?.status, partState),
    resolvedModel: value.resolvedModel ?? fallback?.resolvedModel,
    streaming: false,
    parts: projectedParts(value.parts ?? fallback?.parts),
    usage: value.usage ?? fallback?.usage,
    error: value.error ?? fallback?.error,
    released: true,
  };
}

/** Reconstructs read-only subagent chats from the parent Pi transcript. */
export function historicalSubagentRuns(parts: readonly UiPart[]) {
  const runs = new Map<string, SubagentRun>();
  const startByHandle = new Map<string, { part: ToolPart; request?: Payload; output?: Payload }>();

  for (const part of parts) {
    if (part.kind !== "tool") continue;
    const operation = toolOperationName(part);
    if (operation === "subagents.run") {
      const request = payload(part.input);
      const output = payload(part.output);
      const source = output ?? request;
      if (!source) continue;
      const run = runFromPayload(source, part.id, part.state, request);
      runs.set(run.key, run);
      continue;
    }
    if (operation === "subagents.start") {
      const request = payload(part.input);
      const output = payload(part.output);
      const source = output ?? request;
      if (!source) continue;
      const run = runFromPayload(source, part.id, part.state, request);
      runs.set(run.key, run);
      if (run.handleId) startByHandle.set(run.handleId, { part, request, output });
      continue;
    }
    if (operation === "subagents.wait" || operation === "subagents.completion") {
      const input = payload(part.input);
      const output = payload(part.output);
      const handleId = output?.handleId ?? input?.handleId;
      if (!handleId || !output) continue;
      const start = startByHandle.get(handleId);
      const fallback = start?.request ?? start?.output;
      const run = runFromPayload(output, start?.part.id ?? part.id, part.state, fallback);
      runs.set(run.key, run);
      continue;
    }
    if (operation === "subagents.parallel") {
      const request = payload(part.input);
      const output = payload(part.output);
      const results = output?.results ?? (output?.latest ? [output.latest] : []);
      const requestedTasks = request?.tasks ?? [];
      const sources = results.length > 0 ? results : requestedTasks;
      sources.forEach((source, index) => {
        const run = runFromPayload(source, part.id, part.state, requestedTasks[index], index);
        runs.set(run.key, run);
      });
    }
  }
  return [...runs.values()];
}

export function subagentHandleFromTool(part: ToolPart | undefined) {
  if (!part) return undefined;
  return payload(part.output)?.handleId ?? payload(part.input)?.handleId;
}
