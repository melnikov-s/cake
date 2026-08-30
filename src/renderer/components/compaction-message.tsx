import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageLabel } from "@/components/ai-elements/message";
import type { UiPart } from "../../ipc/session-contract";
import type { SourceLocation } from "../../ipc/source-location";

export function CompactionMessage({
  part,
  onOpenSourceLocation,
}: {
  part: Extract<UiPart, { kind: "compaction" }>;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  return (
    <Message className="mx-auto w-full max-w-2xl">
      <MessageLabel>Cake · context</MessageLabel>
      <details className="overflow-hidden rounded-xl border border-accent/25 bg-card/85 marker:text-accent">
        <summary className="flex cursor-pointer items-baseline gap-2.5 px-3.5 py-3">
          <strong className="text-xs font-semibold">Context compacted</strong>
          <span className="font-mono text-[10px] text-muted-foreground">
            {part.tokensBefore.toLocaleString()} tokens summarized
          </span>
        </summary>
        <div className="max-h-[28rem] overflow-y-auto border-t border-border/70 p-3.5 pt-0">
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>{part.summary}</Markdown>
        </div>
      </details>
    </Message>
  );
}
