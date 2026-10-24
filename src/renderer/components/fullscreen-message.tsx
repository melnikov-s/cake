import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { useMessageHighlights, type MessageHighlightAnchor } from "@/lib/message-highlights";
import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import type { SourceRange } from "../../contracts/editor/source-location";
import type { SourceLocation } from "../../contracts/editor/source-location";

/** Presents arbitrary transient message content without creating a transcript entry or artifact. */
export function FullscreenMessage({
  eyebrow,
  allowSourceView = false,
  highlightAnchors = [],
  markdown,
  onClose,
  onOpenSourceLocation,
  partId,
  streaming = false,
  sourceSession,
  sourceRanges,
  text,
  title,
}: {
  eyebrow: string;
  allowSourceView?: boolean;
  highlightAnchors?: readonly MessageHighlightAnchor[];
  markdown: boolean;
  onClose(): void;
  onOpenSourceLocation?(location: SourceLocation): void;
  partId?: string;
  streaming?: boolean;
  sourceSession?: { sessionId: string; title: string };
  sourceRanges?: readonly SourceRange[];
  text: string;
  title: string;
}) {
  const [showSource, setShowSource] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useMessageHighlights(contentRef, highlightAnchors, text);
  const firstLine = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    firstLine.current?.scrollIntoView?.({ block: "center" });
  }, [text, sourceRanges]);
  return (
    <FullscreenSurface eyebrow={eyebrow} title={title} onClose={onClose}>
      <div className="w-full" {...(partId ? { "data-part-id": partId } : null)}>
        {sourceSession && (
          <div className="mb-4 text-sm text-muted-foreground">
            <Markdown>{`From session: [${sourceSession.title.replace(/[\\`*_[\]]/g, "\\$&")}](cake://session/${encodeURIComponent(sourceSession.sessionId)})`}</Markdown>
          </div>
        )}
        {markdown && allowSourceView && (
          <Button variant="outline" className="mb-4" onClick={() => setShowSource(!showSource)}>
            {showSource ? "Show Markdown" : "Show source"}
          </Button>
        )}
        <div ref={contentRef}>
          {markdown && !showSource ? (
            <Markdown
              streaming={streaming}
              normalizeLatexDelimiters={!streaming}
              onOpenSourceLocation={onOpenSourceLocation}
            >
              {text}
            </Markdown>
          ) : (
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {sourceRanges?.length
                ? text.split("\n").map((line, index) => {
                    const ranges = sourceRanges.filter(
                      (range) =>
                        index >= range.start.line && index <= (range.end?.line ?? range.start.line),
                    );
                    const selected = ranges.length > 0;
                    const first =
                      index === Math.min(...sourceRanges.map((range) => range.start.line));
                    return (
                      <span
                        key={index}
                        ref={first ? firstLine : undefined}
                        className={
                          selected
                            ? "block bg-accent font-mono text-accent-foreground"
                            : "block font-mono"
                        }
                      >
                        {line || "\u200b"}
                      </span>
                    );
                  })
                : text}
            </div>
          )}
        </div>
      </div>
    </FullscreenSurface>
  );
}
