import { useId, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { useMarkdownLinkActions } from "../ai-elements/markdown";
import type { CrossSessionBadge } from "../../lib/cross-session-presentation";
import { Badge } from "./badge";
import { DisclosureTrigger } from "./disclosure-trigger";
import { ChatIcon } from "./icons";
import { Link } from "./link";

const relationLabels = {
  request: "From",
  reply: "Reply from",
  notice: "Notice about",
} as const;

/** Attributed communication, never a collapsed system-context disclosure. */
export const SessionMessage = observer(function SessionMessage({
  source,
  relation = "request",
  badges = [],
  raw,
  children,
}: {
  source?: { sessionId?: string; title?: string; projectName?: string };
  relation?: keyof typeof relationLabels;
  badges?: readonly CrossSessionBadge[];
  /** Exact agent-facing text, inspectable on demand for debugging. */
  raw?: string;
  children: ReactNode;
}) {
  const actions = useMarkdownLinkActions();
  const [rawOpen, setRawOpen] = useState(false);
  const rawId = useId();
  const id = source?.sessionId?.trim();
  // Catalog identity can recover a title omitted by an older report and follows renames.
  // The send-time title remains useful when the source is no longer in the catalog.
  const recordedTitle =
    (id ? actions?.sessionTitle?.(id) : undefined)?.trim() || source?.title?.trim();
  const title =
    recordedTitle && recordedTitle !== id && recordedTitle !== `Session ${id}`
      ? recordedTitle
      : undefined;
  const label = title ?? (id ? "Untitled session" : "Source session unavailable");
  const detail = [
    source?.projectName,
    !id ? "Source identity not recorded" : !title ? "Source title not recorded" : undefined,
  ].filter(Boolean);
  return (
    <section
      data-slot="session-message"
      aria-label={
        relation === "notice" ? "Notice about another session" : "Message from another session"
      }
      className="min-w-0 overflow-hidden rounded-xl border border-border border-l-4 bg-card text-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/50 px-4 py-2">
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          <ChatIcon />
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{relationLabels[relation]}</span>
        <span className="min-w-0 break-words text-sm">
          {id && actions ? (
            <Link
              href={`cake://session/${encodeURIComponent(id)}`}
              title={`Open source session · ${id}`}
              onClick={(event) => {
                event.preventDefault();
                actions.openSession(id);
              }}
            >
              {label}
            </Link>
          ) : (
            <span className="font-semibold">{label}</span>
          )}
        </span>
        {detail.length > 0 && (
          <span className="text-xs text-muted-foreground">{detail.join(" · ")}</span>
        )}
        {badges.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {badges.map((badge) => (
              <Badge key={badge.label} variant={badge.tone} title={badge.description}>
                {badge.label}
              </Badge>
            ))}
          </span>
        )}
      </header>
      {children}
      {raw && (
        <div className="border-t border-border px-4 py-1.5">
          <DisclosureTrigger
            title="Raw envelope"
            className="w-fit gap-2 font-normal text-muted-foreground"
            open={rawOpen}
            aria-controls={rawOpen ? rawId : undefined}
            onClick={() => setRawOpen(!rawOpen)}
          />
          {rawOpen && (
            <pre
              id={rawId}
              className="mt-1.5 mb-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/35 px-3 py-2 font-mono text-[11px] text-muted-foreground"
            >
              {raw}
            </pre>
          )}
        </div>
      )}
    </section>
  );
});
