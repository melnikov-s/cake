import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageLabel } from "@/components/ai-elements/message";
import type { UiPart } from "../../ipc/session-contract";

export function CompactionMessage({ part }: { part: Extract<UiPart, { kind: "compaction" }> }) {
  return (
    <Message className="compaction-message mx-auto w-full max-w-2xl">
      <MessageLabel>Cake · context</MessageLabel>
      <details>
        <summary>
          <strong>Context compacted</strong>
          <span>{part.tokensBefore.toLocaleString()} tokens summarized</span>
        </summary>
        <div>
          <Markdown>{part.summary}</Markdown>
        </div>
      </details>
    </Message>
  );
}
