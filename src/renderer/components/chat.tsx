import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import { AnnotationSummary } from "@/components/annotation-summary";
import { ChatComposer } from "@/components/chat-composer";
import { ChatComposerInput } from "@/components/chat-composer-input";
import { ChatSubmitAction } from "@/components/chat-submit-action";
import { ImagePreview } from "@/components/image-preview";
import { ChatTranscript, type ChatTranscriptBehavior } from "@/components/chat-transcript";
import { QueuedPrompts } from "@/components/queued-prompts";
import { ScheduledPrompts } from "@/components/scheduled-prompts";
import { RewordPromptDialog } from "@/components/reword-prompt-dialog";
import { SourceAttachment } from "@/components/source-attachment";
import { SubagentStatus } from "@/components/subagent-status";
import { Chip } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { PaperclipIcon } from "@/components/ui/icons";
import { TooltipBubble, useTooltip } from "@/components/ui/tooltip";
import type { ChatStore } from "../stores/ChatStore";

function formatCompactTokenCount(tokens: number | null | undefined) {
  if (tokens === null || tokens === undefined) return "Unknown";
  if (tokens < 1_000) return tokens.toLocaleString();

  const [divisor, suffix] = tokens >= 1_000_000 ? [1_000_000, "m"] : [1_000, "k"];
  const value = tokens / divisor;
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(decimals))}${suffix}`;
}

// Observer-wrapped: reads ChatStore.usage (an observable props getter), so usage
// updates at the end of a turn re-render the gauge even while Chat itself is idle.
const Usage = observer(function Usage({ store }: { store: ChatStore }) {
  const usage = store.usage;
  const { anchor, hide, show } = useTooltip();
  if (!usage) return null;
  const context = usage.context;
  const percent =
    context?.percent === null || context?.percent === undefined
      ? undefined
      : Math.round(context.percent);
  const contextLabel =
    percent === undefined ? "Context usage unavailable" : `${percent}% context used`;
  const contextTitle = context
    ? `${context.tokens === null ? "Unknown" : context.tokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens`
    : "Context usage is unavailable";
  const contextTokenSummary = context
    ? `${formatCompactTokenCount(context.tokens)} / ${formatCompactTokenCount(context.contextWindow)} tokens`
    : "Context usage unavailable";
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground tabular-nums select-none hover:bg-muted/70 hover:text-foreground transition-colors cursor-default"
      aria-label={`${contextLabel}; ${contextTokenSummary}`}
      title={`${contextTitle} · ${usage.tokens.total.toLocaleString()} billed tokens`}
      tabIndex={0}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseOver={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
      }}
      onBlur={hide}
    >
      <svg className="size-3.5 shrink-0 overflow-visible" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          className="fill-none stroke-muted-foreground/30 [stroke-width:2]"
          cx="8"
          cy="8"
          r="6"
          pathLength="100"
        />
        <circle
          className="fill-none stroke-foreground/80 [stroke-width:2] [stroke-linecap:round] -rotate-90 origin-center"
          cx="8"
          cy="8"
          r="6"
          pathLength="100"
          strokeDasharray={`${Math.min(100, percent ?? 0)} 100`}
        />
      </svg>
      <span className="font-semibold text-foreground max-[540px]:hidden">
        {percent === undefined ? "—" : `${percent}%`}
      </span>
      {context && (
        <span className="text-muted-foreground/60 max-[640px]:hidden">
          ·{" "}
          {`${formatCompactTokenCount(context.tokens)}/${formatCompactTokenCount(context.contextWindow)}`}
        </span>
      )}
      {anchor && <TooltipBubble label={contextTokenSummary} anchor={anchor} placement="above" />}
    </div>
  );
});

export const Chat = observer(function Chat({
  store,
  transcriptBehavior,
  empty,
  footer,
  error,
  status,
  composerContent,
  composerHeader,
  pluginActions,
  className = "",
  embedded = false,
  compact = false,
}: {
  store: ChatStore;
  transcriptBehavior?: ChatTranscriptBehavior;
  empty?: ReactNode;
  footer?: ReactNode;
  error?: { message: string; details?: string; title?: string };
  status?: ReactNode;
  composerContent?: ReactNode;
  composerHeader?: ReactNode;
  pluginActions?: ReactNode;
  className?: string;
  embedded?: boolean;
  compact?: boolean;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const [promptedSelection, setPromptedSelection] = useState<{
    draft: string;
    start: number;
    end: number;
    text: string;
  }>();
  const composerVisible = store.composerVisible;
  const activatingDraft = store.isDraftSession && !store.editingMessage;
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const dock = composerDockRef.current;
    if (!layout) return;
    if (embedded || !dock) {
      layout.style.setProperty("--composer-dock-height", "0px");
      return;
    }

    const transcript = layout.querySelector<HTMLElement>(".transcript");
    const isAtBottom = () =>
      transcript !== null &&
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 2;
    let followingBottom = isAtBottom();
    let scrollFrame: number | undefined;
    const captureBottomState = () => {
      followingBottom = isAtBottom();
    };
    transcript?.addEventListener("scroll", captureBottomState, { passive: true });
    const updateInset = () => {
      const composerTop = dock
        .querySelector<HTMLElement>(".workbench-composer")
        ?.getBoundingClientRect().top;
      const inset =
        composerTop === undefined
          ? dock.offsetHeight
          : layout.getBoundingClientRect().bottom - composerTop;
      layout.style.setProperty("--composer-dock-height", `${inset}px`);
      if (followingBottom && transcript) {
        if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => {
          transcript.scrollTop = transcript.scrollHeight;
          followingBottom = isAtBottom();
        });
      }
    };
    updateInset();
    const resizeObserver =
      "ResizeObserver" in globalThis ? new globalThis.ResizeObserver(updateInset) : undefined;
    resizeObserver?.observe(dock);
    return () => {
      resizeObserver?.disconnect();
      transcript?.removeEventListener("scroll", captureBottomState);
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    };
  }, [composerVisible, embedded]);
  const restoreSelection = (selection: { start: number; end: number }) => {
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(selection.start, selection.end);
    });
  };
  const reword = async (
    selection: { draft: string; start: number; end: number; text: string },
    prompt?: string,
  ) => {
    const rewritten = await store.rewordComposerSelection(selection.text, prompt);
    if (!rewritten || store.draft !== selection.draft) {
      setPromptedSelection(undefined);
      if (store.draft === selection.draft) restoreSelection(selection);
      return;
    }
    const input = composerInputRef.current;
    if (!input) {
      setPromptedSelection(undefined);
      return;
    }
    input.focus();
    input.setSelectionRange(selection.start, selection.end);
    // Chromium's editing command records the replacement as one native undo step.
    const recordedUndo = document.execCommand("insertText", false, rewritten);
    if (!recordedUndo)
      store.setDraft(
        `${selection.draft.slice(0, selection.start)}${rewritten}${selection.draft.slice(selection.end)}`,
      );
    setPromptedSelection(undefined);
    restoreSelection({
      start: selection.start + rewritten.length,
      end: selection.start + rewritten.length,
    });
  };
  const renderNestedChat = (nestedStore: ChatStore) => (
    <Chat
      store={nestedStore}
      embedded
      compact
      transcriptBehavior={
        transcriptBehavior?.openSourceLocation || transcriptBehavior?.workspacePath
          ? {
              openSourceLocation: transcriptBehavior.openSourceLocation,
              workspacePath: transcriptBehavior.workspacePath,
            }
          : undefined
      }
    />
  );
  const composer = composerVisible && (
    <div
      ref={composerDockRef}
      data-slot="composer-dock"
      className={
        embedded
          ? "min-w-0"
          : "absolute inset-x-0 bottom-0 z-10 w-full max-w-full min-w-0 pointer-events-none bg-gradient-to-b from-transparent to-background/28 px-6 pb-4 pt-5 max-[620px]:px-2.5"
      }
    >
      <ChatComposer
        className={embedded ? "chat-embedded-workbench-composer" : undefined}
        configuration={store.configuration}
        header={
          (transcriptBehavior?.subagents || composerHeader) && (
            <>
              {transcriptBehavior?.subagents && (
                <SubagentStatus
                  store={transcriptBehavior.subagents}
                  renderChat={renderNestedChat}
                />
              )}
              {composerHeader}
            </>
          )
        }
        onSubmit={(event) => {
          event.preventDefault();
          if (activatingDraft) void store.activateDraft();
          else void store.submit();
        }}
        input={
          activatingDraft ? undefined : (
            <ChatComposerInput
              store={store}
              inputRef={composerInputRef}
              onReword={(selection) => void reword(selection)}
              onPromptedReword={setPromptedSelection}
            />
          )
        }
        toolbarLeading={
          !activatingDraft && (
            <>
              {store.canAttach && (
                <IconButton tooltip="Attach files" onClick={() => void store.addAttachments()}>
                  <PaperclipIcon />
                </IconButton>
              )}
              {store.canAttach && store.configuration && (
                <div className="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true" />
              )}
            </>
          )
        }
        toolbarActions={
          <>
            {!activatingDraft && <Usage store={store} />}
            {!activatingDraft && pluginActions}
            <ChatSubmitAction store={store} />
          </>
        }
      >
        {!activatingDraft && <ScheduledPrompts store={store} />}
        {!activatingDraft && <QueuedPrompts store={store} />}
        {!activatingDraft && store.rewording && (
          <div className="px-2 pb-2 text-xs text-muted-foreground" role="status">
            Rewording selection…
          </div>
        )}
        {!activatingDraft && composerContent}
        {!activatingDraft && (
          <AnnotationSummary
            annotations={store.annotations}
            onRemove={(id) => store.removeAnnotation(id)}
          />
        )}
        {!activatingDraft && store.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1.5 pb-1.5 pt-0.5">
            {store.attachments.map((attachment, index) =>
              attachment.kind === "annotation" ? null : attachment.kind === "source" ? (
                <SourceAttachment
                  key={`${attachment.kind}-${attachment.name}-${index}`}
                  attachment={attachment}
                  onOpen={transcriptBehavior?.openSourceLocation}
                  onRemove={() => store.removeAttachment(index)}
                />
              ) : attachment.kind === "image" ? (
                <div
                  className="relative grid h-[82px] w-[112px] overflow-hidden rounded-[10px] border border-border bg-background"
                  key={`${attachment.kind}-${attachment.name}-${index}`}
                >
                  <ImagePreview
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt={attachment.name}
                  />
                  <span className="absolute inset-x-0 bottom-0 flex justify-between gap-1 overflow-hidden bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-3 font-sans text-xs text-white truncate">
                    {attachment.name}
                  </span>
                  <IconButton
                    className="absolute right-[3px] top-[3px] grid size-[18px] place-items-center rounded-full bg-black/70 p-0 text-[13px] leading-none text-white hover:bg-black/90 cursor-pointer"
                    tooltip={`Remove ${attachment.name}`}
                    onClick={() => store.removeAttachment(index)}
                  >
                    ×
                  </IconButton>
                </div>
              ) : (
                <Chip
                  key={`${attachment.kind}-${attachment.name}-${index}`}
                  onClick={() => store.removeAttachment(index)}
                  className="font-mono text-xs"
                  trailing={<span>×</span>}
                >
                  @ {attachment.name}
                </Chip>
              ),
            )}
          </div>
        )}
      </ChatComposer>
      {status}
      {promptedSelection && (
        <RewordPromptDialog
          busy={store.rewording}
          onCancel={() => {
            const selection = promptedSelection;
            setPromptedSelection(undefined);
            restoreSelection(selection);
          }}
          onSubmit={(prompt) => void reword(promptedSelection, prompt)}
        />
      )}
    </div>
  );
  return (
    <div
      ref={layoutRef}
      data-slot="chat"
      className={cn(
        "relative grid h-full w-full max-w-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden",
        compact && "chat-layout-compact",
        className,
      )}
    >
      <ChatTranscript
        store={store}
        behavior={transcriptBehavior}
        empty={empty}
        footer={footer}
        error={error}
        virtualized={!compact}
        renderChat={renderNestedChat}
      />
      {!composerVisible && store.scheduledMessages.length > 0 && (
        <div className="border-t border-border bg-background px-6 py-2 max-[620px]:px-2.5">
          <ScheduledPrompts store={store} />
        </div>
      )}
      {composer}
    </div>
  );
});
