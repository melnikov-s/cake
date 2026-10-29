import { useId } from "react";
import { observer } from "r-state-tree/react";
import { MessageLabel } from "./ai-elements/message";
import { Button } from "./ui/button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { Link } from "./ui/link";
import { messageReference } from "../../contracts/conversations/message-reference";
import { ChatTextMessage, type CanonicalTranscriptBehavior } from "./chat-message";
import { TranscriptPart } from "./chat-transcript-part";
import type { TranscriptItem } from "./chat-transcript-items";

/** Historical dialogue remains a quiet, collapsed entry at the point it was imported. */
export const SideChatImportGroup = observer(function SideChatImportGroup({
  group,
  behavior,
}: {
  group: Extract<TranscriptItem, { kind: "side-chat-import" }>;
  behavior: CanonicalTranscriptBehavior;
}) {
  const contentId = useId();
  const interaction = behavior.store.transcriptInteraction;
  const open = interaction.sideChatImportOpen(group.source.groupId);
  return (
    <section data-slot="side-chat-import" className="min-w-0 rounded-md border border-border/65">
      <DisclosureTrigger
        title={`Merged from ${group.source.title}`}
        subtitle={`${new Set(group.parts.map((part) => part.sideChatImport?.sourceEntryId)).size} messages`}
        open={open}
        aria-controls={contentId}
        className="px-3 py-2.5"
        onClick={() => interaction.setSideChatImportOpen(group.source.groupId, !open)}
      />
      {open && (
        <div id={contentId} className="grid min-w-0 gap-5 border-t border-border/65 p-3">
          {behavior.openSideChatThread && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() => behavior.openSideChatThread?.(group.source.threadId)}
            >
              Open side chat
            </Button>
          )}
          {group.parts.map((part, index) => {
            const source = part.sideChatImport!;
            const firstForMessage =
              group.parts[index - 1]?.sideChatImport?.sourceEntryId !== source.sourceEntryId;
            return (
              <div key={part.id} className="grid min-w-0 gap-2">
                {firstForMessage && (
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    {part.kind === "text" && part.role === "assistant" && (
                      <MessageLabel>Assistant</MessageLabel>
                    )}
                    <Link
                      className="ml-auto"
                      href={messageReference(source.sourceSessionId, source.sourceEntryId)}
                      title={`Original message · ${new Date(source.sourceTimestamp).toLocaleString()}`}
                      onClick={
                        behavior.openSideChatThread
                          ? (event) => {
                              event.preventDefault();
                              behavior.openSideChatThread?.(source.threadId, source.sourceEntryId);
                            }
                          : undefined
                      }
                    >
                      Source
                    </Link>
                  </div>
                )}
                {part.kind === "text" ? (
                  <ChatTextMessage part={part} onOpenSourceLocation={behavior.openSourceLocation} />
                ) : (
                  <TranscriptPart part={part} behavior={behavior} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
});
