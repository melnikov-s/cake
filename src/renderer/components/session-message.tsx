import { useId, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { useMarkdownLinkActions } from "./ai-elements/markdown";
import type { CrossSessionBadge } from "../lib/cross-session-presentation";
import { markdownSummary } from "../lib/message-summary";
import { cn } from "../lib/utils";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { messageNavigationTarget } from "../../contracts/conversations/message-reference";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import { MessageSourceBody, MessageSourceCopy, OriginalResponse } from "./message-source-body";
import { ResultTodoDone, ResultTodoTitles, type ResultTodoLink } from "./result-todo-done";
import { badgeVariants } from "./ui/badge";
import { ChevronIcon } from "./ui/icons";
import { Link } from "./ui/link";

/**
 * A message from another session as one summary row: the sender's title, status, a preview
 * line while collapsed and a Done checkbox for each linked to-do. Expanding shows the whole
 * message (never a nested scroller) and a footer naming the to-dos beside a link to the
 * original. The title appears once; it is never repeated inside the body.
 */
export const SessionMessage = observer(function SessionMessage({
  source,
  title: explicitTitle,
  relation = "request",
  badges = [],
  preview,
  sources = [],
  originals = [],
  open: controlledOpen,
  onToggle,
  todo,
  children,
}: {
  source?: { sessionId?: string; title?: string; href?: string };
  /** Overrides the title resolved from the source session. */
  title?: string;
  relation?: "request" | "reply" | "notice";
  badges?: readonly CrossSessionBadge[];
  /** Markdown whose opening text previews the collapsed message. */
  preview?: string;
  /** Exact originals shown in the body; they own expansion and load when first opened. */
  sources?: readonly MessageReferencePreviewStore[];
  /** Exact originals behind a message that has its own text, each behind a nested disclosure. */
  originals?: readonly MessageReferencePreviewStore[];
  open?: boolean;
  onToggle?(): void;
  todo?: ResultTodoLink;
  children?: ReactNode;
}) {
  const actions = useMarkdownLinkActions();
  const contentId = useId();
  const [localOpen, setLocalOpen] = useState(true);
  const id = source?.sessionId?.trim();
  // Catalog identity can recover a title omitted by an older report and follows renames.
  // The send-time title remains useful when the source is no longer in the catalog.
  const recordedTitle =
    (id ? actions?.sessionTitle?.(id) : undefined)?.trim() || source?.title?.trim();
  const sourceTitle =
    recordedTitle && recordedTitle !== id && recordedTitle !== `Session ${id}`
      ? recordedTitle
      : undefined;
  const title =
    explicitTitle ?? sourceTitle ?? (id ? "Untitled session" : "Source session unavailable");
  const open = sources.length
    ? sources.some((store) => store.expanded)
    : (controlledOpen ?? localOpen);
  const toggle = () => {
    if (sources.length) {
      for (const store of sources) if (store.expanded === open) store.toggle();
    } else if (onToggle) onToggle();
    else setLocalOpen(!localOpen);
  };
  const opening = markdownSummary(preview || sources.find((store) => store.page)?.page?.text || "");
  // A preview that restates the title adds nothing; show what follows it.
  const summary = opening?.startsWith(title)
    ? opening.slice(title.length).replace(/^[\s:·—–-]+/, "")
    : opening;
  const reference = (sources[0] ?? originals[0])?.props.reference;
  const linkedTodos = todo?.origin ? (todo.todos?.itemsForResult(todo.origin) ?? []) : [];
  const href = reference ?? source?.href ?? (id ? `cake://session/${encodeURIComponent(id)}` : "");
  const openSource = () => {
    if (reference) {
      const target = messageNavigationTarget(reference);
      actions?.openSession(target.sessionId, target.messageId);
      return;
    }
    const worker = parseSubagentLink(href);
    if (worker) actions?.openSubagent?.(worker.parentSessionId, worker.handleId, worker.messageId);
    else if (id) actions?.openSession(id);
  };
  return (
    <section
      data-slot="session-message"
      aria-label={
        relation === "notice" ? "Notice about another session" : "Message from another session"
      }
      className="min-w-0 rounded-lg border border-border bg-card text-card-foreground"
    >
      <div className="flex min-h-10 min-w-0 items-center gap-1 py-1 pr-1.5 pl-1">
        <button
          type="button"
          data-slot="response-disclosure"
          data-cake-hint="off"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          aria-label={title}
          title={title}
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none select-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toggle}
        >
          <ChevronIcon
            className={cn(
              "shrink-0 text-muted-foreground transition-transform duration-150",
              !open && "-rotate-90",
            )}
          />
          <span className="max-w-[45%] min-w-[3em] shrink truncate text-sm font-medium">
            {title}
          </span>
          {badges.map((badge) => (
            <span
              key={badge.label}
              title={badge.description}
              className={cn(badgeVariants({ variant: badge.tone }), "shrink-0")}
            >
              {badge.label}
            </span>
          ))}
          {!open && summary && (
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{summary}</span>
          )}
        </button>
        <ResultTodoDone {...todo} />
      </div>
      {open && (
        <>
          <div
            id={contentId}
            className="flex min-w-0 flex-col gap-3 border-t border-border/60 px-5 pt-3.5 pb-4"
          >
            {children}
            {sources.map((store) => (
              <MessageSourceBody key={store.props.reference} store={store} />
            ))}
            {originals.map((store) => (
              <OriginalResponse key={store.props.reference} store={store} />
            ))}
          </div>
          {(linkedTodos.length > 0 || (href && actions) || sources[0]?.page) && (
            <footer className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-5 py-2 text-xs text-muted-foreground">
              <ResultTodoTitles {...todo} />
              {href && actions && (
                <Link
                  href={href}
                  title={reference ? "Open the original message" : "Open source conversation"}
                  className="ml-auto font-medium text-inherit decoration-transparent hover:text-foreground hover:decoration-current"
                  onClick={(event) => {
                    event.preventDefault();
                    openSource();
                  }}
                >
                  {reference ? "Full response" : "Open conversation"}
                </Link>
              )}
              {sources[0] && <MessageSourceCopy store={sources[0]} />}
            </footer>
          )}
        </>
      )}
    </section>
  );
});
