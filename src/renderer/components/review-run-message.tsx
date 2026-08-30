import { Message, MessageLabel } from "@/components/ai-elements/message";
import { ActionCard } from "@/components/ui/action-card";
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
      <ActionCard
        disabled={!onOpen}
        onClick={() => onOpen?.(run.threadIds[0])}
        className="max-w-[34rem]"
        title={
          run.status === "running" ? (
            <LoadingState label={label} variant="Dots" />
          ) : (
            <span className={run.status === "error" ? "text-destructive" : ""}>{label}</span>
          )
        }
        trailing={<span className="font-mono text-[10px] text-accent">View in VS Code</span>}
      />
    </Message>
  );
}
