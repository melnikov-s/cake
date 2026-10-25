import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { useMarkdownLinkActions } from "../ai-elements/markdown";
import type { CrossSessionBadge } from "../../lib/cross-session-presentation";
import { Badge } from "./badge";
import { Link } from "./link";
import { parseSubagentLink } from "../../../contracts/subagents/subagent-reference";

const relationLabels = {
  request: "From",
  reply: "From",
  notice: "Notice about",
} as const;

/** Attributed communication, never a collapsed system-context disclosure. */
export const SessionMessage = observer(function SessionMessage({
  source,
  relation = "request",
  badges = [],
  children,
}: {
  source?: { sessionId?: string; title?: string; projectName?: string; href?: string };
  relation?: keyof typeof relationLabels;
  badges?: readonly CrossSessionBadge[];
  children: ReactNode;
}) {
  const actions = useMarkdownLinkActions();
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
  const href = source?.href ?? (id ? `cake://session/${encodeURIComponent(id)}` : undefined);
  const detail = [
    source?.projectName,
    !href ? "Source identity not recorded" : !title ? "Source title not recorded" : undefined,
  ].filter(Boolean);
  return (
    <section
      data-slot="session-message"
      aria-label={
        relation === "notice" ? "Notice about another session" : "Message from another session"
      }
      className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card py-3 text-foreground"
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-5 pt-1 pb-2">
        <span className="shrink-0 text-xs text-muted-foreground">{relationLabels[relation]}</span>
        <span className="min-w-0 break-words text-xs text-muted-foreground">
          {href && actions ? (
            <Link
              href={href}
              title="Open source conversation"
              className="font-medium text-inherit decoration-transparent hover:decoration-current"
              onClick={(event) => {
                event.preventDefault();
                const worker = parseSubagentLink(href);
                if (worker)
                  actions.openSubagent?.(worker.parentSessionId, worker.handleId, worker.messageId);
                else if (id) actions.openSession(id);
              }}
            >
              {label}
            </Link>
          ) : (
            <span className="font-medium">{label}</span>
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
    </section>
  );
});
