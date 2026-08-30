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
    <Message className="mr-auto w-full">
      <MessageLabel>{run.status === "running" ? "Cake · working" : "Cake"}</MessageLabel>
      <button
        type="button"
        disabled={!onOpen}
        onClick={() => onOpen?.(run.threadIds[0])}
        className="flex w-full max-w-[34rem] cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card/90 p-3.5 text-left text-foreground hover:border-accent/45 transition-colors"
      >
        {run.status === "running" && <LoadingState label={label} variant="Dots" />}
        {run.status !== "running" && (
          <strong
            className={`text-xs font-semibold ${run.status === "error" ? "text-destructive" : ""}`}
          >
            {label}
          </strong>
        )}
        <span className="ml-auto font-mono text-[10px] text-accent">View in VS Code</span>
      </button>
    </Message>
  );
}
