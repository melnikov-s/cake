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
    <Message className="compaction-message mx-auto w-full max-w-2xl">
      <MessageLabel>Cake · context</MessageLabel>
      <details>
        <summary>
          <strong>Context compacted</strong>
          <span>{part.tokensBefore.toLocaleString()} tokens summarized</span>
        </summary>
        <div>
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>{part.summary}</Markdown>
        </div>
      </details>
    </Message>
  );
}
