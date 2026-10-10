import { useId, useState } from "react";
import { Chip } from "./chip";

/** Exact model-facing context, collapsed without hiding its existence. */
export function ContextPill({
  title,
  text,
  compacted = false,
}: {
  title: string;
  text: string;
  compacted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <section
      className="min-w-0 max-w-full"
      data-slot="context-pill"
      data-origin={compacted ? "compacted" : "current"}
    >
      <Chip
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="max-w-64 truncate">{title}</span>
        {compacted && <span>· removed from context</span>}
      </Chip>
      {open && (
        <pre
          id={contentId}
          className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 font-mono text-xs text-muted-foreground"
        >
          {text}
        </pre>
      )}
    </section>
  );
}
