import { z } from "zod";
import { jsonValueSchema } from "../ipc/json-contract";
import { resolvedAgentModelSchema } from "../ipc/plugin-agent-contract";
import { toolOperationName } from "./cake-tool";
import {
  sessionUsageSchema,
  uiPartSchema,
  type SessionUsage,
  type UiPart,
} from "../ipc/session-contract";

const statusSchema = z.enum(["queued", "running", "complete", "error", "aborted"]);
const profileSchema = z.enum(["scout", "planner", "reviewer", "worker"]);
const runPayloadSchema = z
  .object({
    handleId: z.uuid().optional(),
    task: z.string().optional(),
    profile: profileSchema.optional(),
    status: statusSchema.optional(),
    resolvedModel: resolvedAgentModelSchema.optional(),
    streaming: z.boolean().optional(),
    parts: z.array(z.unknown()).optional(),
    usage: sessionUsageSchema.optional(),
    error: z.string().optional(),
  })
  .passthrough();
const gatewayInputSchema = z.object({ input: z.unknown() }).passthrough();
const payloadSchema = runPayloadSchema
  .extend({
    tasks: z.array(runPayloadSchema).optional(),
    latest: runPayloadSchema.optional(),
    results: z.array(runPayloadSchema).optional(),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
  })
  .passthrough();

type RunPayload = z.infer<typeof runPayloadSchema>;
type Payload = z.infer<typeof payloadSchema>;
type ToolPart = Extract<UiPart, { kind: "tool" }>;

export interface SubagentRun {
  key: string;
  anchorPartId: string;
  handleId?: string;
  task: string;
  profile: "scout" | "planner" | "reviewer" | "worker";
  status: "queued" | "running" | "complete" | "error" | "aborted";
  resolvedModel?: z.infer<typeof resolvedAgentModelSchema>;
  streaming: boolean;
  parts: UiPart[];
  usage?: SessionUsage;
  error?: string;
  released: boolean;
}

function payload(value?: string): Payload | undefined {
  if (!value) return undefined;
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(value));
    const gateway = gatewayInputSchema.safeParse(parsed);
    const result = payloadSchema.safeParse(gateway.success ? gateway.data.input : parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function projectedParts(value: unknown[] | undefined) {
  return (value ?? []).flatMap((part) => {
    const parsed = uiPartSchema.safeParse(part);
    return parsed.success ? [parsed.data] : [];
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
  const spawnByHandle = new Map<string, { part: ToolPart; request?: Payload; output?: Payload }>();

  for (const part of parts) {
    if (part.kind !== "tool") continue;
    if (toolOperationName(part) === "subagents.spawn") {
      const request = payload(part.input);
      const output = payload(part.output);
      const source = output ?? request;
      if (!source) continue;
      const run = runFromPayload(source, part.id, part.state, request);
      runs.set(run.key, run);
      if (run.handleId) spawnByHandle.set(run.handleId, { part, request, output });
      continue;
    }
    if (toolOperationName(part) === "subagents.wait") {
      const input = payload(part.input);
      const output = payload(part.output);
      const handleId = output?.handleId ?? input?.handleId;
      if (!handleId || !output) continue;
      const spawn = spawnByHandle.get(handleId);
      const fallback = spawn?.request ?? spawn?.output;
      const run = runFromPayload(output, spawn?.part.id ?? part.id, part.state, fallback);
      runs.set(run.key, run);
      continue;
    }
    if (toolOperationName(part) === "subagents.parallel") {
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
