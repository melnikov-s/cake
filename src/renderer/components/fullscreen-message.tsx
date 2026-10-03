import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import type { SourceLocation } from "../../ipc/source-location";

/** Presents arbitrary transient message content without creating a transcript entry or artifact. */
export function FullscreenMessage({
  eyebrow,
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
  markdown: boolean;
  onClose(): void;
  onOpenSourceLocation?(location: SourceLocation): void;
  partId?: string;
  streaming?: boolean;
  sourceSession?: { sessionId: string; title: string };
  text: string;
  title: string;
}) {
  return (
    <FullscreenSurface eyebrow={eyebrow} title={title} onClose={onClose}>
      <div className="w-full" {...(partId ? { "data-part-id": partId } : null)}>
        {sourceSession && (
          <div className="mb-4 text-sm text-muted-foreground">
            <Markdown>{`From session: [${sourceSession.title.replace(/[\\`*_[\]]/g, "\\$&")}](cake://session/${encodeURIComponent(sourceSession.sessionId)})`}</Markdown>
          </div>
        )}
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
    </FullscreenSurface>
  );
}
