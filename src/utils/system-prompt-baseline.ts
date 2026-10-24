import type { UiPart } from "../contracts/conversations/session-contract";

/** Only this namespace is synthetic; entry-/live-context- parts are chronological disclosures. */
export function isSystemPromptBaseline(part: Pick<UiPart, "id" | "kind">): boolean {
  return part.kind === "context" && part.id.startsWith("runtime-system-prompt-");
}

/** Stable partition: never deduplicate or alter the instructions themselves. */
export function systemPromptBaselineFirst(parts: readonly UiPart[]): UiPart[] {
  const baseline: UiPart[] = [];
  const chronological: UiPart[] = [];
  for (const part of parts) (isSystemPromptBaseline(part) ? baseline : chronological).push(part);
  return [...baseline, ...chronological];
}
