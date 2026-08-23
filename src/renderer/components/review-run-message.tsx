import { Message, MessageLabel } from "@/components/ai-elements/message";
import { LoadingState } from "@/components/ui/loading-state";
import type { UiPart } from "../../ipc/session-contract";

export function ReviewRunMessage({
  run,
  onOpen,
}: {
  run: Extract<UiPart, { kind: "review-run" }>;
  onOpen?(threadId?: string): void;
}) {
  const count = run.commentCount;
  const label =
    run.status === "running"
      ? `Replying to ${count} ${count === 1 ? "comment" : "comments"}`
      : run.status === "error"
        ? `${count} ${count === 1 ? "comment needs" : "comments need"} another try`
        : `${count} ${count === 1 ? "comment" : "comments"} replied`;
  return (
    <Message className="review-run-message mr-auto w-full">
      <MessageLabel>{run.status === "running" ? "Cake · working" : "Cake"}</MessageLabel>
      <button
        type="button"
        className={run.status}
        disabled={!onOpen}
        onClick={() => onOpen?.(run.threadIds[0])}
      >
        {run.status === "running" && <LoadingState label={label} variant="Dots" />}
        {run.status !== "running" && <strong>{label}</strong>}
        <span>View in Changes</span>
      </button>
    </Message>
  );
}
