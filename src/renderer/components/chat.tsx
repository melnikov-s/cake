import { useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { AnnotationSummary } from "@/components/annotation-summary";
import { ChatComposer } from "@/components/chat-composer";
import { ImagePreview } from "@/components/image-preview";
import { ChatTranscript, type ChatTranscriptBehavior } from "@/components/chat-transcript";
import { QueuedPrompts } from "@/components/queued-prompts";
import { RewordPromptDialog } from "@/components/reword-prompt-dialog";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import { SourceAttachment } from "@/components/source-attachment";
import { IconButton } from "@/components/ui/icon-button";
import { PaperclipIcon, SendIcon, StopIcon } from "@/components/ui/icons";
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
      className="session-usage"
      aria-label={`${contextLabel}; ${contextTokenSummary}`}
      title={`${contextTitle} · ${usage.tokens.total.toLocaleString()} billed tokens`}
      tabIndex={0}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
      }}
      onBlur={hide}
    >
      <svg className="context-gauge" viewBox="0 0 36 36" aria-hidden="true">
        <circle className="context-gauge-track" cx="18" cy="18" r="15.5" pathLength="100" />
        <circle
          className="context-gauge-value"
          cx="18"
          cy="18"
          r="15.5"
          pathLength="100"
          strokeDasharray={`${Math.min(100, percent ?? 0)} 100`}
        />
        <text x="18" y="18">
          {percent === undefined ? "—" : `${percent}%`}
        </text>
      </svg>
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
  // The input keeps its DOM draft locally, while ChatStore remains canonical.
  // Force the surrounding toolbar to re-read semantic submit state in the same event.
  const [, draftChanged] = useReducer((revision: number) => revision + 1, 0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const draftHoldTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressSendClickRef = useRef(false);
  const [promptedSelection, setPromptedSelection] = useState<{
    draft: string;
    start: number;
    end: number;
    text: string;
  }>();
  const composerVisible = store.composerVisible;
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
    let followingBottom = true;
    let scrollFrame: number | undefined;
    let bottomUpdatePending = false;
    const captureBottomState = () => {
      if (!bottomUpdatePending && isAtBottom()) followingBottom = true;
    };
    const stopFollowing = () => {
      followingBottom = false;
      bottomUpdatePending = false;
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    };
    const stopFollowingForScrollbar = (event: PointerEvent) => {
      if (event.target === transcript) stopFollowing();
    };
    transcript?.addEventListener("scroll", captureBottomState, { passive: true });
    transcript?.addEventListener("wheel", stopFollowing, { passive: true });
    transcript?.addEventListener("touchmove", stopFollowing, { passive: true });
    transcript?.addEventListener("pointerdown", stopFollowingForScrollbar);
    transcript?.addEventListener("keydown", stopFollowing);
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
        bottomUpdatePending = true;
        if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => {
          transcript.scrollTop = transcript.scrollHeight;
          bottomUpdatePending = false;
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
      transcript?.removeEventListener("wheel", stopFollowing);
      transcript?.removeEventListener("touchmove", stopFollowing);
      transcript?.removeEventListener("pointerdown", stopFollowingForScrollbar);
      transcript?.removeEventListener("keydown", stopFollowing);
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    };
  }, [composerVisible, embedded]);
  const submit = async (value?: string) => {
    await store.submit(value ?? store.draft);
    draftChanged();
  };
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
    if (!recordedUndo) {
      store.setDraft(
        `${selection.draft.slice(0, selection.start)}${rewritten}${selection.draft.slice(selection.end)}`,
      );
      draftChanged();
    }
    setPromptedSelection(undefined);
    restoreSelection({
      start: selection.start + rewritten.length,
      end: selection.start + rewritten.length,
    });
  };
  const composer = composerVisible && (
    <div ref={composerDockRef} className={embedded ? "chat-embedded-composer" : "composer-dock"}>
      <ChatComposer
        className={embedded ? "chat-embedded-workbench-composer" : undefined}
        configuration={store.configuration}
        header={composerHeader}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        input={
          <SlashCommandCombobox
            autoFocus
            aria-label={store.inputLabel}
            aria-busy={store.rewording}
            inputRef={(input) => {
              composerInputRef.current = input;
            }}
            commands={store.commands}
            focusRequestRevision={store.focusRequestRevision}
            suggestFiles={
              store.canSuggestFiles ? (prefix) => store.suggestFiles(prefix) : undefined
            }
            placeholder={store.placeholder}
            value={store.draft}
            disabled={store.submittingLocally}
            onValueChange={(value) => {
              store.setDraft(value);
              draftChanged();
            }}
            onContextMenu={(event) => {
              if (!store.canRewordComposerSelection || store.rewording) return;
              const input = event.currentTarget;
              const start = input.selectionStart;
              const end = input.selectionEnd;
              if (start === end) return;
              event.preventDefault();
              const selection = {
                draft: input.value,
                start,
                end,
                text: input.value.slice(start, end),
              };
              void store
                .showComposerContextMenu(selection.text, event.clientX, event.clientY)
                .then((action) => {
                  if (action === "reword") void reword(selection);
                  else if (action === "reword-with-prompt") setPromptedSelection(selection);
                });
            }}
            onPaste={(event) => {
              if (!store.canPasteImages) return;
              const images = [...event.clipboardData.files].filter((file) =>
                file.type.startsWith("image/"),
              );
              if (images.length === 0)
                for (const item of event.clipboardData.items) {
                  if (!item.type.startsWith("image/")) continue;
                  const file = item.getAsFile();
                  if (file) images.push(file);
                }
              if (images.length === 0) return;
              event.preventDefault();
              void store.addPastedImages(images);
            }}
            onSubmit={(value) => submit(value)}
            onEscape={store.canStop ? () => void store.abort() : undefined}
          />
        }
        toolbarLeading={
          store.canAttach && (
            <IconButton tooltip="Attach files" onClick={() => void store.addAttachments()}>
              <PaperclipIcon />
            </IconButton>
          )
        }
        toolbarActions={
          <>
            <Usage store={store} />
            {pluginActions}
            {(() => {
              const hasInput =
                store.draft.trim().length > 0 ||
                store.attachments.length > 0 ||
                store.annotations.length > 0;
              return (
                <>
                  {(!store.loading || hasInput) && (
                    <IconButton
                      className="send-button"
                      tooltip={
                        store.editingMessage
                          ? store.isDraftSession
                            ? "Save draft"
                            : "Save and regenerate"
                          : store.canCreateDraft
                            ? "Send · hold to save as draft"
                            : "Send"
                      }
                      type="submit"
                      disabled={!store.canSubmitDraft(store.draft)}
                      onClick={(event) => {
                        if (!suppressSendClickRef.current) return;
                        event.preventDefault();
                        suppressSendClickRef.current = false;
                      }}
                      onContextMenu={(event) => {
                        if (!store.canCreateDraft) return;
                        event.preventDefault();
                        void store.showDraftMenu(event.clientX, event.clientY).then((action) => {
                          if (action === "create-draft") void store.createDraft();
                        });
                      }}
                      onPointerDown={(event) => {
                        if (!store.canCreateDraft) return;
                        suppressSendClickRef.current = false;
                        const { clientX, clientY } = event;
                        draftHoldTimerRef.current = setTimeout(() => {
                          suppressSendClickRef.current = true;
                          void store.showDraftMenu(clientX, clientY).then((action) => {
                            if (action === "create-draft") void store.createDraft();
                          });
                        }, 600);
                      }}
                      onPointerUp={() => {
                        if (draftHoldTimerRef.current) clearTimeout(draftHoldTimerRef.current);
                      }}
                      onPointerCancel={() => {
                        if (draftHoldTimerRef.current) clearTimeout(draftHoldTimerRef.current);
                      }}
                      onPointerLeave={() => {
                        if (draftHoldTimerRef.current) clearTimeout(draftHoldTimerRef.current);
                      }}
                    >
                      <SendIcon />
                    </IconButton>
                  )}
                  {store.canStop && !hasInput && (
                    <IconButton
                      className="send-button"
                      tooltip="Stop"
                      onClick={() => void store.abort()}
                    >
                      <StopIcon />
                    </IconButton>
                  )}
                </>
              );
            })()}
          </>
        }
      >
        <QueuedPrompts store={store} />
        {store.rewording && (
          <div className="px-2 pb-2 text-xs text-muted-foreground" role="status">
            Rewording selection…
          </div>
        )}
        {composerContent}
        <AnnotationSummary
          annotations={store.annotations}
          onRemove={(id) => store.removeAnnotation(id)}
        />
        {store.attachments.length > 0 && (
          <div className="attachment-list">
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
                  className="image-attachment"
                  key={`${attachment.kind}-${attachment.name}-${index}`}
                >
                  <ImagePreview
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt={attachment.name}
                  />
                  <span>{attachment.name}</span>
                  <IconButton
                    className="image-attachment-remove"
                    tooltip={`Remove ${attachment.name}`}
                    onClick={() => store.removeAttachment(index)}
                  >
                    ×
                  </IconButton>
                </div>
              ) : (
                <button
                  type="button"
                  key={`${attachment.kind}-${attachment.name}-${index}`}
                  onClick={() => store.removeAttachment(index)}
                >
                  @ {attachment.name} <span>×</span>
                </button>
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
      className={`chat-layout${embedded ? " chat-layout-embedded" : ""}${compact ? " chat-layout-compact" : ""} ${className}`.trim()}
    >
      <ChatTranscript
        store={store}
        behavior={transcriptBehavior}
        empty={empty}
        footer={footer}
        error={error}
        virtualized={!compact}
        renderChat={(nestedStore) => (
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
        )}
      />
      {composer}
    </div>
  );
});
