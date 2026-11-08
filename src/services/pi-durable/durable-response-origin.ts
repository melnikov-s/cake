import type { SubmissionRecord } from "@earendil-works/pi-durable";
import type { UiPart } from "../../contracts/conversations/session-contract";

/** Project SDK causality, never a nearest/latest-message guess or a second transcript. */
export function projectDurableResponseOrigins(
  parts: readonly UiPart[],
  activeTurnIds: readonly string[],
  submissions: readonly SubmissionRecord[],
): UiPart[] {
  const answers = new Map<string, string[]>();
  for (const submission of submissions) {
    if (submission.type !== "input" || submission.status !== "done" || !submission.requestId)
      continue;
    const key = String(submission.answer);
    const ids = answers.get(key) ?? [];
    ids.push(submission.requestId);
    answers.set(key, ids);
  }
  return parts.map((part) => {
    if (part.kind !== "text" || part.role !== "assistant") return part;
    const ids =
      part.status === "streaming"
        ? activeTurnIds
        : part.entryId
          ? answers.get(part.entryId)
          : undefined;
    return ids?.length ? { ...part, responseToTurnIds: ids } : part;
  });
}
