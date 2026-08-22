import { type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { ChatComposer } from "@/components/chat-composer";
import { ImagePreview } from "@/components/image-preview";
import { ChatTranscript, type ChatTranscriptBehavior } from "@/components/chat-transcript";
import { QueuedPrompts } from "@/components/queued-prompts";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import { IconButton } from "@/components/ui/icon-button";
import type { ChatStore } from "../stores/ChatStore";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const PaperclipIcon = () => (
  <Icon>
    <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9" />
  </Icon>
);
const SendIcon = () => (
  <Icon>
    <path d="m5 12 7-7 7 7M12 19V5" />
  </Icon>
);
const StopIcon = () => (
  <Icon>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Icon>
);

// Observer-wrapped: reads ChatStore.usage (an observable props getter), so usage
// updates at the end of a turn re-render the gauge even while Chat itself is idle.
const Usage = observer(function Usage({ store }: { store: ChatStore }) {
  const usage = store.usage;
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
  return (
    <div
      className="session-usage"
      aria-label={contextLabel}
      title={`${contextTitle} · ${usage.tokens.total.toLocaleString()} billed tokens`}
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
  pluginActions?: ReactNode;
  className?: string;
  embedded?: boolean;
  compact?: boolean;
}) {
  const submit = async (value?: string) => {
    await store.submit(value ?? store.draft);
  };
  const composer = store.composerVisible && (
    <div className={embedded ? "chat-embedded-composer" : "composer-dock"}>
      <ChatComposer
        className={embedded ? "chat-embedded-workbench-composer" : undefined}
        configuration={store.configuration}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        input={
          <SlashCommandCombobox
            autoFocus
            aria-label={store.inputLabel}
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
            onSubmit={(value) => void submit(value)}
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
              const hasInput = store.draft.trim().length > 0 || store.attachments.length > 0;
              // While a prompt is running, stop only applies to an empty composer;
              // typing a new message turns the button back into queue-and-submit.
              if (store.loading && store.canAbort && !hasInput) {
                return (
                  <IconButton
                    className="send-button"
                    tooltip="Stop"
                    onClick={() => void store.abort()}
                  >
                    <StopIcon />
                  </IconButton>
                );
              }
              if (!store.loading || hasInput) {
                return (
                  <IconButton
                    className="send-button"
                    tooltip="Send"
                    type="submit"
                    disabled={!store.canSubmitDraft(store.draft)}
                  >
                    <SendIcon />
                  </IconButton>
                );
              }
              return null;
            })()}
          </>
        }
      >
        <QueuedPrompts store={store} />
        {composerContent}
        {store.attachments.length > 0 && (
          <div className="attachment-list">
            {store.attachments.map((attachment, index) =>
              attachment.kind === "image" ? (
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
    </div>
  );
  return (
    <div
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
              transcriptBehavior?.openFileInEditor || transcriptBehavior?.openFilePath
                ? {
                    openFileInEditor: transcriptBehavior.openFileInEditor,
                    openFilePath: transcriptBehavior.openFilePath,
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
