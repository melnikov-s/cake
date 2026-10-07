import { useRef } from "react";
import { useMessageHighlights, type MessageHighlightAnchor } from "@/lib/message-highlights";
import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import type { SourceLocation } from "../../ipc/source-location";

/** Presents arbitrary transient message content without creating a transcript entry or artifact. */
export function FullscreenMessage({
  eyebrow,
  highlightAnchors = [],
  markdown,
  onClose,
  onOpenSourceLocation,
  partId,
  streaming = false,
  sourceSession,
  text,
  title,
}: {
  eyebrow: string;
  highlightAnchors?: readonly MessageHighlightAnchor[];
  markdown: boolean;
  onClose(): void;
  onOpenSourceLocation?(location: SourceLocation): void;
  partId?: string;
  streaming?: boolean;
  sourceSession?: { sessionId: string; title: string };
  text: string;
  title: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useMessageHighlights(contentRef, highlightAnchors, text);
  return (
    <FullscreenSurface eyebrow={eyebrow} title={title} onClose={onClose}>
      <div className="w-full" {...(partId ? { "data-part-id": partId } : null)}>
        {sourceSession && (
          <div className="mb-4 text-sm text-muted-foreground">
            <Markdown>{`From session: [${sourceSession.title.replace(/[\\`*_[\]]/g, "\\$&")}](cake://session/${encodeURIComponent(sourceSession.sessionId)})`}</Markdown>
          </div>
        )}
        <div ref={contentRef}>
          {markdown ? (
            <Markdown
              streaming={streaming}
              normalizeLatexDelimiters={!streaming}
              onOpenSourceLocation={onOpenSourceLocation}
            >
              {text}
            </Markdown>
          ) : (
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</div>
          )}
        </div>
      </div>
    </FullscreenSurface>
  );
}
