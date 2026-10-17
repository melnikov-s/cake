import { Option, Schema } from "effect";
import { uiPartSchema } from "../conversations/session-contract";
import type { SubagentResult } from "./subagent-data";

/** Exact final assistant text only; child tool output is never a parent report. */
export function subagentFinalAnswer(result: SubagentResult): string | undefined {
  return result.parts
    .flatMap((part) => {
      const parsed = Schema.decodeUnknownOption(uiPartSchema)(part);
      return Option.isSome(parsed) &&
        parsed.value.kind === "text" &&
        parsed.value.role === "assistant" &&
        parsed.value.text.trim()
        ? [parsed.value.text]
        : [];
    })
    .at(-1);
}
