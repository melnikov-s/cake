import { Option, Schema } from "effect";
import { uiPartSchema } from "../conversations/session-contract";
import { jsonValueSchema, type JsonValue } from "../serialization/json-contract";
import { SubagentResult } from "./subagent-data";
import { subagentLink } from "./subagent-reference";

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

/** Report text inlined into the parent's model context; the full answer stays readable by ref. */
const SUBAGENT_REPORT_INLINE_LIMIT = 4_000;
/** Without a retrievable original (failure text, legacy parts) keep more inline, still marked. */
export const SUBAGENT_REPORT_UNREFERENCED_LIMIT = 16_000;

/** Exact public ref to the worker's final answer in its retained Pi session, when Pi recorded one. */
export function subagentReportRef(
  parentSessionId: string,
  result: SubagentResult,
): string | undefined {
  const entryId = subagentFinalAnswerPart(result)?.entryId;
  return entryId ? subagentLink(parentSessionId, result.handleId, entryId) : undefined;
}

/** Truncation is never silent: it names what was shown, the total, and where the rest lives. */
function truncationNotice(shown: number, total: number, ref?: string): string {
  return ref
    ? `[Truncated: showing the first ${shown} of ${total} characters. Read the full text with messages.read { "ref": "${ref}" }; pass nextOffset as offset for each next page.]`
    : `[Truncated: showing the first ${shown} of ${total} characters. No retrievable original was recorded for the rest.]`;
}

/** Bounds report text for a parent surface, appending an explicit marker when anything is cut. */
export function boundedReportText(text: string, limit: number, ref?: string): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n${truncationNotice(limit, text.length, ref)}`;
}

/** Formats the parent-facing report without copying verbose child tool activity into model context.
 * A long final answer becomes its opening plus an explicit marker and the exact ref to the full text. */
export function subagentCompletionMessage(value: JsonValue): string {
  const decoded = Schema.decodeUnknownOption(SubagentResult)(value);
  if (Option.isNone(decoded)) return "A background subagent finished, but its report was invalid.";

  const result = decoded.value;
  const finalAnswer = subagentFinalAnswer(result)?.trim();
  const heading = `Background subagent ${result.status}: ${result.task.slice(0, 500)}`;
  // A failed worker's last text is mid-task narration, not a report; lead with why it failed.
  const report =
    (result.status === "error"
      ? result.error?.trim() || finalAnswer
      : finalAnswer || result.error?.trim()) || "No final report was produced.";
  // The ref names the final answer, so it describes the report only when the answer is the report.
  const ref = report === finalAnswer ? result.reportRef : undefined;
  const body = boundedReportText(
    report,
    ref ? SUBAGENT_REPORT_INLINE_LIMIT : SUBAGENT_REPORT_UNREFERENCED_LIMIT,
    ref,
  );
  return `${heading}\n\n${body}${ref ? `\n\n[Full agent response](${ref})` : ""}`;
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
