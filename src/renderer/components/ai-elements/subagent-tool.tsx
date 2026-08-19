import { z } from "zod";
import { jsonValueSchema } from "../../../ipc/json-contract";
import { sessionUsageSchema, type UiPart } from "../../../ipc/session-contract";
import { Markdown } from "./markdown";

const subagentPartSchema = z
  .object({
    kind: z.string(),
    name: z.string().optional(),
    text: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough();

const subagentProjectionSchema = z
  .object({
    task: z.string().optional(),
    profile: z.string().optional(),
    status: z.string().optional(),
    parts: z.array(subagentPartSchema).optional(),
    usage: sessionUsageSchema.optional(),
    completed: z.number().optional(),
    total: z.number().optional(),
  })
  .passthrough();

function projectionFromJson(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = jsonValueSchema.parse(JSON.parse(value));
    const result = subagentProjectionSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function SubagentTool({ part }: { part: Extract<UiPart, { kind: "tool" }> }) {
  const input = projectionFromJson(part.input);
  const output = projectionFromJson(part.output);
  const task = output?.task ?? input?.task;
  const profile = output?.profile ?? input?.profile ?? "worker";
  const status = output?.status ?? (part.state === "running" ? "running" : part.state);
  const parts = output?.parts ?? [];
  const recentTools = parts.filter((item) => item.kind === "tool").slice(-4);
  const finalText = [...parts].reverse().find((item) => item.kind === "text" && item.text)?.text;
  const totalTokens = output?.usage?.tokens.total;
  const cost = output?.usage?.cost;
  const parallelCount =
    output?.completed !== undefined && output.total !== undefined
      ? `${output.completed}/${output.total}`
      : undefined;
  const title =
    part.name === "subagent_parallel"
      ? `parallel delegation${parallelCount ? ` ${parallelCount}` : ""}`
      : `${profile} subagent`;

  return (
    <div
      className={`tool-call subagent-call rounded-xl border border-border bg-muted/35 px-4 py-3${part.state === "running" ? " subagent-running" : ""}`}
    >
      <div className="subagent-header">
        <span className={`tool-state tool-${part.state}`} aria-label={part.state} />
        <span className="subagent-title">{title}</span>
        <span className="subagent-status">{status}</span>
      </div>
      {task && <p className="subagent-task">{task}</p>}
      {recentTools.length > 0 && (
        <div className="subagent-activity" aria-label="Subagent activity">
          {recentTools.map((item, index) => (
            <span key={`${item.name ?? "tool"}-${index}`}>
              <i
                className={`tool-state tool-${item.state === "error" ? "error" : item.state === "running" ? "running" : "success"}`}
              />
              {item.name ?? "tool"}
            </span>
          ))}
        </div>
      )}
      {(totalTokens !== undefined || cost !== undefined) && (
        <div className="subagent-usage">
          {totalTokens?.toLocaleString()} tokens{cost !== undefined ? ` · $${cost.toFixed(4)}` : ""}
        </div>
      )}
      {finalText && (
        <details className="subagent-result">
          <summary>Result</summary>
          <Markdown className="mt-2 text-xs">{finalText}</Markdown>
        </details>
      )}
    </div>
  );
}
