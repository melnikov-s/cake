import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { useMarkdownLinkActions } from "../ai-elements/markdown";
import { ChatIcon } from "./icons";
import { Link } from "./link";

/** Attributed communication, never a collapsed system-context disclosure. */
export const SessionMessage = observer(function SessionMessage({
  source,
  notice = false,
  children,
}: {
  source?: { sessionId?: string; title?: string; projectName?: string };
  notice?: boolean;
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
  return (
    <section
      data-slot="session-message"
      aria-label={notice ? "Notice about another session" : "Message from another session"}
      className="min-w-0 overflow-hidden rounded-xl border border-border border-l-4 bg-card text-foreground"
    >
      <header className="flex items-start gap-3 border-b border-border bg-muted/50 px-4 py-3">
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
          <ChatIcon />
        </span>
        <div className="grid min-w-0 gap-1">
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground">
            {notice ? "Notice about another session" : "Message from another session"}
          </div>
          <div className="break-words text-sm">
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
          </div>
          {(source?.projectName || !title || !id) && (
            <div className="text-xs text-muted-foreground">
              {source?.projectName}
              {source?.projectName && (!title || !id) && " · "}
              {!id ? "Source identity not recorded" : !title ? "Source title not recorded" : null}
            </div>
          )}
        </div>
      </header>
      {children}
    </section>
  );
});
