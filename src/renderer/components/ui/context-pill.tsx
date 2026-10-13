import { useId, useState } from "react";
import { Chip } from "./chip";
import { Markdown } from "../ai-elements/markdown";
import type { SourceLocation } from "../../../contracts/editor/source-location";

/** Exact model-facing context, collapsed without hiding its existence. */
export function ContextPill({
  title,
  text,
  onOpenSourceLocation,
}: {
  title: string;
  text: string;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <section className="contents" data-slot="context-pill">
      <Chip
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="max-w-64 truncate">{title}</span>
      </Chip>
      {open && (
        <div
          id={contentId}
          className="order-1 mt-2 max-h-96 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 font-mono text-xs text-muted-foreground"
        >
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>{text}</Markdown>
        </div>
      )}
    </section>
  );
}
