import { useId, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { MarkdownLink, useMarkdownLinkActions } from "./ai-elements/markdown";
import { Message } from "./ai-elements/message";
import type { CrossSessionBadge } from "../lib/cross-session-presentation";
import { markdownSummary } from "../lib/message-summary";
import { reportMessagePresentation } from "../lib/report-message-presentation";
import { canFullscreenText } from "../lib/text-fullscreen";
import { cn } from "../lib/utils";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { MessageSourceBody, MessageSourceCopy, OriginalResponse } from "./message-source-body";
import { ResultTodoDone, type ResultTodoLink } from "./result-todo-done";
import { badgeVariants } from "./ui/badge";
import { Button } from "./ui/button";
import { ChevronIcon, LinkIcon } from "./ui/icons";
import { FullscreenSurface } from "./fullscreen-surface";

/** An assistant message with source navigation, disclosure and linked to-dos. */
export const SessionMessage = observer(function SessionMessage({
  source,
  title: explicitTitle,
  relation = "request",
  badges = [],
  preview,
  sources = [],
  originals = [],
  open: controlledOpen,
  defaultOpen = true,
  onToggle,
  todo,
  messageActions,
  replyAction,
  compact = false,
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
  /** Initial disclosure for inline content; subsequent renders preserve the user's choice. */
  defaultOpen?: boolean;
  onToggle?(): void;
  todo?: ResultTodoLink;
  messageActions?: ReactNode;
  replyAction?: ReactNode;
  /** Update summaries keep actions in the header, without exterior toolbar rows. */
  compact?: boolean;
  children?: ReactNode;
}) {
  const actions = useMarkdownLinkActions();
  const contentId = useId();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
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
  // Source pages carry the full length, even when the current page is short.
  // Unopened sources stay lazy; eligibility becomes known when they are read.
  const canOpenFullscreen = canFullscreenText(
    (preview?.length ?? 0) +
      [...sources, ...originals].reduce(
        (length, store) => length + (store.page?.totalChars ?? 0),
        0,
      ),
  );
  const opening = markdownSummary(
    reportMessagePresentation(preview || sources.find((store) => store.page)?.page?.text || "")
      .body,
  );
  // A preview that restates the title adds nothing; show what follows it.
  const summary = opening?.startsWith(title)
    ? opening.slice(title.length).replace(/^[\s:·—–-]+/, "")
    : opening;
  const reference = (sources[0] ?? originals[0])?.props.reference;
  const linkedTodos = todo?.origin ? (todo.todos?.itemsForResult(todo.origin) ?? []) : [];
  const href = reference ?? source?.href ?? (id ? `cake://session/${encodeURIComponent(id)}` : "");
  const messageToolbar = (
    <>
      {messageActions}
      {sources[0] && <MessageSourceCopy store={sources[0]} />}
      {replyAction}
    </>
  );
  const renderTodos = () =>
    linkedTodos.length > 0 && (
      <footer className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-5 py-2 text-xs text-muted-foreground">
        {/* Reports are evidence, not a task-completion authority. Explicit human completion
            remains available in the To-do pane, using its existing lifecycle checks. */}
        <ResultTodoDone {...todo} readOnly />
      </footer>
    );
  return (
    <Message
      role="region"
      data-slot="session-message"
      aria-label={
        relation === "notice" ? "Notice about another session" : "Message from another session"
      }
      actions={compact ? undefined : messageToolbar}
      fullscreen={
        canOpenFullscreen
          ? {
              label: `View message fullscreen: ${title}`,
              onClick: () => {
                for (const store of [...sources, ...originals]) store.openFullscreen();
                setFullscreen(true);
              },
            }
          : undefined
      }
    >
      <div
        data-slot="session-message-card"
        className="min-w-0 rounded-lg border border-border bg-card text-card-foreground"
      >
        <div className="flex min-h-10 min-w-0 items-center gap-1 py-1 pr-10 pl-1">
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
              <span className={cn("min-w-0 shrink text-sm font-medium", !open && "max-w-[45%]")}>
                <span className="block truncate">{title}</span>
              </span>
              {!open && summary && (
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {summary}
                </span>
              )}
            </div>
          </div>
          {badges.length > 0 && (
            <div
              data-slot="session-message-badges"
              className="ml-auto flex max-w-[45%] shrink-0 flex-wrap justify-end gap-1"
            >
              {badges.map((badge) => (
                <span
                  key={badge.label}
                  title={badge.description}
                  className={cn(
                    badgeVariants({ variant: badge.tone }),
                    "min-w-0 whitespace-normal text-right",
                  )}
                >
                  {badge.label}
                </span>
              ))}
            </div>
          )}
          {href && actions && (
            <MarkdownLink
              href={href}
              presentation="icon"
              aria-label={reference || source?.href ? "Open source" : "Open session"}
              title={reference || source?.href ? "Open source" : "Open session"}
            >
              <LinkIcon />
            </MarkdownLink>
          )}
          {compact && (
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100">
              {messageToolbar}
            </div>
          )}
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
      {fullscreen && (
        <FullscreenSurface eyebrow="Message" title={title} onClose={() => setFullscreen(false)}>
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
    </Message>
  );
});
