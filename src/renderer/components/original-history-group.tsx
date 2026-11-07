import { useId } from "react";
import { observer } from "r-state-tree/react";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { ChatTextMessage, type CanonicalTranscriptBehavior } from "./chat-message";
import { TranscriptPart } from "./chat-transcript-part";
import type { UiPart } from "../../contracts/conversations/session-contract";

/** Pi-owned inherited originals, kept apart from the new side-chat dialogue. */
export const OriginalHistoryGroup = observer(function OriginalHistoryGroup({
  parts,
  behavior,
}: {
  parts: UiPart[];
  behavior: CanonicalTranscriptBehavior;
}) {
  const contentId = useId();
  const interaction = behavior.store.transcriptInteraction;
  const open = interaction.sideChatImportOpen("original-history");
  return (
    <section data-slot="original-history" className="min-w-0 rounded-md border border-border/65">
      <DisclosureTrigger
        title="Original history"
        open={open}
        aria-controls={contentId}
        className="px-3 py-2.5"
        onClick={() => interaction.setSideChatImportOpen("original-history", !open)}
      />
      {open && (
        <div id={contentId} className="grid min-w-0 gap-5 border-t border-border/65 p-3">
          {parts.map((part) =>
            part.kind === "text" ? (
              <ChatTextMessage
                key={part.id}
                part={part}
                onOpenSourceLocation={behavior.openSourceLocation}
              />
            ) : (
              <TranscriptPart key={part.id} part={part} behavior={behavior} />
            ),
          )}
        </div>
      )}
    </section>
  );
});
