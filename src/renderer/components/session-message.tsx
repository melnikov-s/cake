import { useId, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { MarkdownLink, useMarkdownLinkActions } from "./ai-elements/markdown";
import type { CrossSessionBadge } from "../lib/cross-session-presentation";
import { markdownSummary } from "../lib/message-summary";
import { cn } from "../lib/utils";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { MessageSourceBody, MessageSourceCopy, OriginalResponse } from "./message-source-body";
import { ResultTodoDone, ResultTodoTitles, type ResultTodoLink } from "./result-todo-done";
import { badgeVariants } from "./ui/badge";
import { Button } from "./ui/button";
import { ChevronIcon } from "./ui/icons";
import { FullscreenButton } from "./ui/fullscreen-button";
import { FullscreenSurface } from "./fullscreen-surface";

/** Incoming session content with independent title navigation and disclosure. */
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
  messageActions,
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
  messageActions?: ReactNode;
  children?: ReactNode;
}) {
  const actions = useMarkdownLinkActions();
  const contentId = useId();
  const [localOpen, setLocalOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
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
  const renderTodos = () =>
    linkedTodos.length > 0 && (
      <footer className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-5 py-2 text-xs text-muted-foreground">
        <ResultTodoTitles {...todo} />
      </footer>
    );
  return (
    <section
      data-slot="session-message"
      aria-label={
        relation === "notice" ? "Notice about another session" : "Message from another session"
      }
      className="group/session-message min-w-0"
    >
      <div
        data-slot="session-message-card"
        className="min-w-0 rounded-lg border border-border bg-card text-card-foreground"
      >
        <div className="flex min-h-10 min-w-0 items-center gap-1 py-1 pr-1.5 pl-1">
          <div
            data-slot="response-header"
            className="relative flex h-8 min-w-0 flex-1 items-center"
          >
            <Button
              variant="ghost"
              data-slot="response-disclosure"
              data-cake-hint="off"
              aria-expanded={open}
              aria-controls={open ? contentId : undefined}
              aria-label={title}
              title={title}
              className="absolute inset-0 h-full w-full justify-start px-2 hover:bg-muted/60"
              onClick={toggle}
            >
              <ChevronIcon
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform duration-150",
                  !open && "-rotate-90",
                )}
              />
            </Button>
            <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 pr-2 pl-8">
              <span className="max-w-[45%] min-w-[3em] shrink text-sm font-medium">
                {href && actions ? (
                  <MarkdownLink
                    href={href}
                    showIcon={false}
                    title={reference ? "Open the original message" : "Open source conversation"}
                    className="pointer-events-auto max-w-full text-inherit decoration-transparent hover:decoration-current"
                  >
                    {title}
                  </MarkdownLink>
                ) : (
                  <span className="block truncate">{title}</span>
                )}
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
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {summary}
                </span>
              )}
            </div>
          </div>
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
            {renderTodos()}
          </>
        )}
      </div>
      <div
        data-slot="message-actions"
        aria-label="Message actions"
        className="mt-1.5 flex min-h-7 items-center gap-1 opacity-0 transition-opacity group-hover/session-message:opacity-100 group-focus-within/session-message:opacity-100"
      >
        {messageActions}
        {sources[0] && <MessageSourceCopy store={sources[0]} />}
        <FullscreenButton
          className="shrink-0 translate-x-0 translate-y-0"
          label={`View message fullscreen: ${title}`}
          onClick={() => setFullscreen(true)}
        />
      </div>
      {fullscreen && (
        <FullscreenSurface
          eyebrow="Message"
          title={title}
          onClose={() => setFullscreen(false)}
          toolbar={linkedTodos.length > 0 ? <ResultTodoDone {...todo} /> : undefined}
        >
          <div className="flex min-w-0 flex-col gap-3">
            {children}
            {[...sources, ...originals].map((store) => (
              <MessageSourceBody key={store.props.reference} store={store.fullscreenReader} />
            ))}
            {renderTodos()}
            {(sources[0] ?? originals[0]) && (
              <MessageSourceCopy store={(sources[0] ?? originals[0])!.fullscreenReader} />
            )}
          </div>
        </FullscreenSurface>
      )}
    </section>
  );
});
