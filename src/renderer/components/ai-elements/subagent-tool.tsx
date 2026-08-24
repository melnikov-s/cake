import { useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { z } from "zod";
import { jsonValueSchema } from "../../../ipc/json-contract";
import { resolvedAgentModelSchema } from "../../../ipc/plugin-agent-contract";
import { sessionUsageSchema, type UiPart } from "../../../ipc/session-contract";
import type { SubagentActivity } from "../../../ipc/subagent-activity-contract";
import type { SubagentActivityStore } from "../../stores/SubagentActivityStore";
import { Markdown } from "./markdown";

const modelPreferenceSchema = z.discriminatedUnion("prefer", [
  z.object({ prefer: z.literal("utility") }),
  z.object({ prefer: z.literal("default") }),
  z.object({ prefer: z.literal("current") }),
  z.object({
    prefer: z.literal("exact"),
    provider: z.string(),
    modelId: z.string(),
    thinkingLevel: z.string().optional(),
  }),
]);

const subagentPartSchema = z
  .object({
    id: z.string().optional(),
    kind: z.string(),
    name: z.string().optional(),
    text: z.string().optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough();

const subagentRunProjectionSchema = z
  .object({
    handleId: z.string().optional(),
    task: z.string().optional(),
    profile: z.string().optional(),
    status: z.string().optional(),
    model: modelPreferenceSchema.optional(),
    resolvedModel: resolvedAgentModelSchema.optional(),
    instructions: z.string().optional(),
    fastMode: z.boolean().optional(),
    maxDepth: z.number().optional(),
    retain: z.boolean().optional(),
    retained: z.boolean().optional(),
    streaming: z.boolean().optional(),
    parts: z.array(subagentPartSchema).optional(),
    usage: sessionUsageSchema.optional(),
    error: z.string().optional(),
  })
  .passthrough();

const subagentProjectionSchema = subagentRunProjectionSchema
  .extend({
    tasks: z.array(subagentRunProjectionSchema).optional(),
    latest: subagentRunProjectionSchema.optional(),
    results: z.array(subagentRunProjectionSchema).optional(),
    completed: z.number().optional(),
    total: z.number().optional(),
  })
  .passthrough();

type Projection = z.infer<typeof subagentProjectionSchema>;
type RunProjection = z.infer<typeof subagentRunProjectionSchema> | SubagentActivity;
type ToolPart = Extract<UiPart, { kind: "tool" }>;

function projectionFromJson(value?: string): Projection | undefined {
  if (!value) return undefined;
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(value));
    const result = subagentProjectionSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function requestedModelLabel(model: Projection["model"]) {
  if (!model) return undefined;
  if (model.prefer === "exact") return `${model.provider}/${model.modelId}`;
  return `${model.prefer} model`;
}

function capabilityLabel(profile: string) {
  return profile === "worker" ? "parent-approved workspace tools" : "read/search only";
}

function displayValue(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function runParts(run: RunProjection) {
  // SAFETY: Both live UiParts and persisted subagent parts cross validated Zod boundaries;
  // this common optional-field view avoids reparsing a growing trace on every live update.
  return (run.parts ?? []) as z.infer<typeof subagentPartSchema>[];
}

function runModelLabel(run: RunProjection) {
  return run.resolvedModel
    ? `${run.resolvedModel.provider}/${run.resolvedModel.modelId}`
    : requestedModelLabel("model" in run ? run.model : undefined);
}

function finalRunText(run: RunProjection) {
  return [...runParts(run)].reverse().find((item) => item.kind === "text" && item.text)?.text;
}

function toolStateForRun(status: string) {
  if (status === "complete") return "success";
  if (status === "aborted") return "interrupted";
  return status;
}

function currentRunActivity(run: RunProjection) {
  const parts = runParts(run);
  const running = [...parts]
    .reverse()
    .find((item) => item.kind === "tool" && item.state === "running");
  if (running) return `Running ${running.name ?? "tool"}`;
  const latest = [...parts]
    .reverse()
    .find((item) => item.kind === "tool" || item.kind === "reasoning");
  if (!latest) return run.status === "queued" ? "Waiting for a worker slot" : "Thinking";
  return latest.kind === "tool" ? `Last activity: ${latest.name ?? "tool"}` : "Reasoning";
}

function ParallelSubagentRuns({
  part,
  request,
  output,
  liveActivities,
  open,
  toggleOpen,
  timer,
}: {
  part: ToolPart;
  request?: Projection;
  output?: Projection;
  liveActivities: SubagentActivity[];
  open: boolean;
  toggleOpen(): void;
  timer?: ReactNode;
}) {
  const persistedRuns = output?.results ?? (output?.latest ? [output.latest] : []);
  const runs: RunProjection[] = liveActivities.length > 0 ? liveActivities : persistedRuns;
  const requestedTasks = request?.tasks ?? [];
  const total = output?.total ?? (requestedTasks.length || runs.length);
  const completed =
    liveActivities.length > 0
      ? runs.filter((run) => run.status === "complete").length
      : (output?.completed ?? runs.filter((run) => run.status === "complete").length);
  const active = runs.some((run) => run.status === "queued" || run.status === "running");

  return (
    <div
      className={`tool-call subagent-call rounded-xl border border-border bg-muted/35 px-4 py-3${active ? " subagent-running" : ""}${open ? " tool-open" : ""}`}
    >
      <button type="button" className="subagent-summary" onClick={toggleOpen} aria-expanded={open}>
        <span
          className={`tool-state tool-${active ? "running" : part.state}`}
          aria-label={active ? "running" : part.state}
        />
        <span className="subagent-title">Parallel delegation</span>
        {timer}
        <span className="subagent-status">
          {completed}/{total || runs.length} complete
        </span>
      </button>
      <div className="mt-3 grid gap-2" aria-label="Delegated agents">
        {(runs.length > 0 ? runs : requestedTasks).map((run, index) => {
          const task = run.task ?? requestedTasks[index]?.task ?? `Delegated task ${index + 1}`;
          const status = run.status ?? "queued";
          const finalText = finalRunText(run);
          const trace = runParts(run).filter(
            (item) => item.kind === "tool" || item.kind === "reasoning",
          );
          return (
            <section
              key={run.handleId ?? `${task}-${index}`}
              className="rounded-lg border border-border/70 bg-background/60 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span
                  className={`tool-state tool-${toolStateForRun(status)}`}
                  aria-label={status}
                />
                <strong className="font-mono">{run.profile ?? "worker"}</strong>
                {runModelLabel(run) && (
                  <span className="truncate text-muted-foreground">{runModelLabel(run)}</span>
                )}
                <span className="ml-auto text-muted-foreground">{status}</span>
              </div>
              <p className="mt-1 text-xs">{task}</p>
              {(status === "running" || status === "queued") && (
                <p className="mt-1 text-xs text-muted-foreground">{currentRunActivity(run)}</p>
              )}
              {open && trace.length > 0 && (
                <div className="subagent-trace mt-2" aria-label="Subagent execution trace">
                  {trace.map((item, traceIndex) => (
                    <div key={item.id ?? `${item.kind}-${traceIndex}`}>
                      <strong>
                        {item.kind === "tool" ? (item.name ?? "tool") : "reasoning"}
                        {item.state ? ` · ${item.state}` : ""}
                      </strong>
                      {item.text && <Markdown>{item.text}</Markdown>}
                      {item.input && <pre>{displayValue(item.input)}</pre>}
                      {item.output && <pre>{displayValue(item.output)}</pre>}
                    </div>
                  ))}
                </div>
              )}
              {run.error && <pre className="subagent-error mt-2">{run.error}</pre>}
              {finalText && (
                <div className="subagent-result mt-2" aria-label="Subagent output">
                  <strong>Output</strong>
                  <Markdown className="mt-2 text-xs">{finalText}</Markdown>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export const SubagentTool = observer(function SubagentTool({
  part,
  spawnPart,
  subagents,
  live = false,
  timer,
  expansion,
}: {
  part: ToolPart;
  spawnPart?: ToolPart;
  subagents?: SubagentActivityStore;
  /** True while this conversation's runtime may still be producing subagent work. */
  live?: boolean;
  timer?: ReactNode;
  expansion?: { open: boolean; toggle(): void };
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = expansion?.open ?? uncontrolledOpen;
  const toggleOpen = expansion?.toggle ?? (() => setUncontrolledOpen((value) => !value));
  const requestPart = spawnPart ?? (part.name === "subagent_spawn" ? part : undefined);
  const request = projectionFromJson(requestPart?.input);
  const spawnOutput = projectionFromJson(requestPart?.output);
  const persistedOutput = projectionFromJson(part.output) ?? spawnOutput;
  const persistedHandleId = persistedOutput?.handleId ?? spawnOutput?.handleId;
  const anchorPartId = requestPart?.id ?? part.id;
  const liveActivities = subagents?.forAnchor(anchorPartId) ?? [];
  const liveActivity =
    subagents?.forHandle(persistedHandleId) ??
    (part.name === "subagent_parallel" ? undefined : liveActivities[0]);
  if (part.name === "subagent_parallel")
    return (
      <ParallelSubagentRuns
        part={part}
        request={request}
        output={persistedOutput}
        liveActivities={liveActivities}
        open={open}
        toggleOpen={toggleOpen}
        timer={timer}
      />
    );
  const output: RunProjection | undefined = liveActivity ?? persistedOutput;
  const task = output?.task ?? request?.task;
  const profile = output?.profile ?? request?.profile ?? "worker";
  // A persisted receipt's embedded status is a point-in-time snapshot written
  // by an earlier process. Only a live runtime may present "running": once the
  // part has settled without that runtime, the part state wins over a stale
  // "running" so restored transcripts never display stale activity.
  const status =
    output?.status === "running" && part.state !== "running" && !live && !liveActivity
      ? part.state
      : (output?.status ?? (part.state === "running" ? "running" : part.state));
  const activelyRunning = status === "running" || status === "queued";
  const currentActivity = output && activelyRunning ? currentRunActivity(output) : undefined;
  const resolvedModel = output?.resolvedModel ?? spawnOutput?.resolvedModel;
  const requestedModel = request?.model;
  const requestedModelName = requestedModelLabel(requestedModel);
  const modelLabel = resolvedModel
    ? `${resolvedModel.provider}/${resolvedModel.modelId}`
    : requestedModelName;
  const thinkingLevel =
    resolvedModel?.thinkingLevel ??
    (requestedModel?.prefer === "exact" ? requestedModel.thinkingLevel : undefined);
  const parts = output ? runParts(output) : [];
  const traceParts = parts.filter((item) => item.kind === "tool" || item.kind === "reasoning");
  const finalText = [...parts].reverse().find((item) => item.kind === "text" && item.text)?.text;
  const totalTokens = output?.usage?.tokens.total;
  const cost = output?.usage?.cost;
  const title = `${profile} subagent`;
  const handleId = output?.handleId ?? spawnOutput?.handleId;
  const retained = request?.retain ?? spawnOutput?.retained;
  const fastMode = request?.fastMode ?? spawnOutput?.fastMode ?? output?.fastMode;
  const maxDepth = request?.maxDepth ?? spawnOutput?.maxDepth;

  return (
    <div
      className={`tool-call subagent-call rounded-xl border border-border bg-muted/35 px-4 py-3${activelyRunning ? " subagent-running" : ""}${open ? " tool-open" : ""}`}
    >
      <button type="button" className="subagent-summary" onClick={toggleOpen} aria-expanded={open}>
        <span className={`tool-state tool-${toolStateForRun(status)}`} aria-label={status} />
        <span className="subagent-title">{title}</span>
        {modelLabel && <span className="subagent-model">{modelLabel}</span>}
        {thinkingLevel && <span className="subagent-thinking">{thinkingLevel}</span>}
        {timer}
        <span className="subagent-status">{status}</span>
      </button>
      {task && <p className="subagent-task">{task}</p>}
      {currentActivity && <p className="mt-1 text-xs text-muted-foreground">{currentActivity}</p>}
      {(totalTokens !== undefined || cost !== undefined) && (
        <div className="subagent-usage">
          {totalTokens?.toLocaleString()} tokens{cost !== undefined ? ` · $${cost.toFixed(4)}` : ""}
        </div>
      )}
      {open && (
        <div className="subagent-details">
          <section>
            <h4>Request</h4>
            <dl className="subagent-metadata">
              <div>
                <dt>Agent</dt>
                <dd>{profile}</dd>
              </div>
              <div>
                <dt>Capabilities</dt>
                <dd>{capabilityLabel(profile)}</dd>
              </div>
              <div>
                <dt>Requested model</dt>
                <dd>{requestedModelName ?? "Not reported"}</dd>
              </div>
              <div>
                <dt>Resolved model</dt>
                <dd>
                  {resolvedModel
                    ? `${resolvedModel.provider}/${resolvedModel.modelId} via ${resolvedModel.source}`
                    : "Not reported"}
                </dd>
              </div>
              <div>
                <dt>Reasoning</dt>
                <dd>{thinkingLevel ?? "Model default"}</dd>
              </div>
              {resolvedModel && resolvedModel.fallbacks.length > 0 && (
                <div>
                  <dt>Fallbacks</dt>
                  <dd>
                    {resolvedModel.fallbacks
                      .map((fallback) => `${fallback.source}: ${fallback.reason}`)
                      .join(", ")}
                  </dd>
                </div>
              )}
              <div>
                <dt>Mode</dt>
                <dd>{retained ? "retained / multi-turn" : "one-shot"}</dd>
              </div>
              <div>
                <dt>Fast mode</dt>
                <dd>{fastMode ? "On" : "Off"}</dd>
              </div>
              <div>
                <dt>Delegation depth</dt>
                <dd>{maxDepth ?? 0}</dd>
              </div>
              {handleId && (
                <div>
                  <dt>Handle</dt>
                  <dd title={handleId}>{handleId}</dd>
                </div>
              )}
            </dl>
            {task && (
              <div className="subagent-payload">
                <strong>Prompt</strong>
                <pre>{task}</pre>
              </div>
            )}
            {request?.instructions && (
              <div className="subagent-payload">
                <strong>Additional instructions</strong>
                <pre>{request.instructions}</pre>
              </div>
            )}
          </section>
          {(traceParts.length > 0 || output?.error) && (
            <section>
              <h4>Execution</h4>
              {traceParts.length > 0 && (
                <div className="subagent-trace" aria-label="Subagent execution trace">
                  {traceParts.map((item, index) => (
                    <div key={item.id ?? `${item.kind}-${index}`}>
                      <strong>
                        {item.kind === "tool" ? (item.name ?? "tool") : "reasoning"}
                        {item.state ? ` · ${item.state}` : ""}
                      </strong>
                      {item.text && <Markdown>{item.text}</Markdown>}
                      {item.input && <pre>{displayValue(item.input)}</pre>}
                      {item.output && <pre>{displayValue(item.output)}</pre>}
                    </div>
                  ))}
                </div>
              )}
              {output?.error && <pre className="subagent-error">{output.error}</pre>}
            </section>
          )}
        </div>
      )}
      {finalText && (
        <div className="subagent-result" aria-label="Subagent output">
          <strong>Output</strong>
          <Markdown className="mt-2 text-xs">{finalText}</Markdown>
        </div>
      )}
    </div>
  );
});
