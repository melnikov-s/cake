import { Option, Schema } from "effect";
import { uiPartSchema } from "../conversations/session-contract";
import { jsonValueSchema, type JsonValue } from "../serialization/json-contract";
import { SubagentResult } from "./subagent-data";

/** Exact final assistant text only; child tool output is never a parent report. */
export function subagentFinalAnswerPart(result: SubagentResult) {
  return result.parts
    .flatMap((part) => {
      const parsed = Schema.decodeUnknownOption(uiPartSchema)(part);
      return Option.isSome(parsed) &&
        parsed.value.kind === "text" &&
        parsed.value.role === "assistant" &&
        parsed.value.text.trim()
        ? [parsed.value]
        : [];
    })
    .at(-1);
}

function subagentFinalAnswer(result: SubagentResult): string | undefined {
  return subagentFinalAnswerPart(result)?.text;
}

const SUBAGENT_REPORT_LIMIT = 16_000;

/** Formats the parent-facing report without copying verbose child tool activity into model context. */
export function subagentCompletionMessage(value: JsonValue): string {
  const decoded = Schema.decodeUnknownOption(SubagentResult)(value);
  if (Option.isNone(decoded)) return "A background subagent finished, but its report was invalid.";

  const result = decoded.value;
  const finalAnswer = subagentFinalAnswer(result)?.trim();
  const heading = `Background subagent ${result.status}: ${result.task.slice(0, 500)}`;
  const report = finalAnswer || result.error?.trim() || "No final report was produced.";
  const available = Math.max(0, SUBAGENT_REPORT_LIMIT - heading.length - 2);
  const bounded =
    report.length > available ? `${report.slice(0, Math.max(0, available - 2))}…` : report;
  return `${heading}\n\n${bounded}`;
}

/**
 * A worker report admitted to its parent's ordinary input queue. The completion ID is the
 * admission identity, so a repeated delivery after a restart is idempotent.
 */
export function subagentCompletionInput(result: JsonValue, completionId?: string) {
  const parsed = Schema.decodeUnknownOption(SubagentResult)(result);
  const details: JsonValue =
    completionId && Option.isSome(parsed)
      ? Schema.decodeUnknownSync(jsonValueSchema)({ ...parsed.value, completionId })
      : result;
  return {
    text: subagentCompletionMessage(result),
    internal: { _tag: "SubagentCompletion" as const, details },
  };
}
