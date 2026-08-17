import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { ChatComposer } from "@/components/chat-composer";
import { ChatTranscript, type ChatTranscriptBehavior } from "@/components/chat-transcript";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import type { ChatStore } from "../stores/ChatStore";

function Icon({ children }: { children: ReactNode }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

const PaperclipIcon = () => <Icon><path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9" /></Icon>;
const SendIcon = () => <Icon><path d="m5 12 7-7 7 7M12 19V5" /></Icon>;

function Usage({ store }: { store: ChatStore }) {
  const usage = store.usage;
  if (!usage) return null;
  const context = usage.context;
  const percent = context?.percent === null || context?.percent === undefined ? undefined : Math.round(context.percent);
  const contextLabel = percent === undefined ? "Context usage unavailable" : `${percent}% context used`;
  const contextTitle = context ? `${context.tokens === null ? "Unknown" : context.tokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens` : "Context usage is unavailable";
  return <div className="session-usage" aria-label={`${contextLabel}, session cost $${usage.cost.toFixed(3)}`} title={`${contextTitle} · ${usage.tokens.total.toLocaleString()} billed tokens`}><svg className="context-gauge" viewBox="0 0 36 36" aria-hidden="true"><circle className="context-gauge-track" cx="18" cy="18" r="15.5" pathLength="100" /><circle className="context-gauge-value" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${Math.min(100, percent ?? 0)} 100`} /><text x="18" y="18">{percent === undefined ? "—" : `${percent}%`}</text></svg><span className="session-cost">${usage.cost.toFixed(3)}</span></div>;
}

export const Chat = observer(function Chat({ store, transcriptBehavior, empty, footer, error, status, composerContent, pluginActions, className = "", embedded = false, composerOnly = false, composerDraft, onSubmitted }: {
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
  composerOnly?: boolean;
  composerDraft?: { value: string; onChange(value: string): void };
  onSubmitted?(): void;
}) {
  const visibleDraft = composerDraft?.value ?? store.draft;
  const submit = async (value?: string, mode: "send" | "steer" = "send") => {
    const submitted = await store.submit(value ?? visibleDraft, mode);
    if (!submitted) return;
    onSubmitted?.();
  };
  const composer = store.composerVisible && <div className={embedded ? "chat-embedded-composer" : "composer-dock"}>
    <ChatComposer className={embedded ? "chat-embedded-workbench-composer" : undefined} configuration={store.configuration} onSubmit={(event) => { event.preventDefault(); void submit(); }} input={<SlashCommandCombobox autoFocus aria-label={store.inputLabel} commands={store.commands} focusRequestRevision={store.focusRequestRevision} suggestFiles={store.canSuggestFiles ? (prefix) => store.suggestFiles(prefix) : undefined} placeholder={store.placeholder} value={visibleDraft} disabled={store.submittingLocally} onValueChange={(value) => { composerDraft?.onChange(value); store.setDraft(value); }} onPaste={(event) => {
      if (!store.canPasteImages) return;
      const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) for (const item of event.clipboardData.items) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) images.push(file);
      }
      if (images.length === 0) return;
      event.preventDefault();
      void store.addPastedImages(images);
    }} onSubmit={(value) => void submit(value)} />} toolbarLeading={store.canAttach && <button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={() => void store.addAttachments()}><PaperclipIcon /></button>} toolbarActions={<>
      <Usage store={store} />
      {pluginActions}
      {store.streaming && store.canAbort && <Button variant="ghost" size="sm" type="button" onClick={() => void store.abort()}>Stop</Button>}
      {store.streaming && store.allowSteer && <Button variant="outline" size="sm" type="button" disabled={!store.canSubmit} onClick={() => void submit(undefined, "steer")}>Steer</Button>}
      <Button className="send-button" size="sm" type="submit" disabled={!store.canSubmitDraft(visibleDraft)}>{store.submitting ? "Sending…" : store.streaming ? "Queue" : "Send"}<SendIcon /></Button>
    </>}>
      {composerContent}
      {store.attachments.length > 0 && <div className="attachment-list">{store.attachments.map((attachment, index) => attachment.kind === "image"
        ? <button className="image-attachment" type="button" aria-label={`Remove ${attachment.name}`} key={`${attachment.kind}-${attachment.name}-${index}`} onClick={() => store.removeAttachment(index)}><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /><span>{attachment.name}<b aria-hidden="true">×</b></span></button>
        : <button type="button" key={`${attachment.kind}-${attachment.name}-${index}`} onClick={() => store.removeAttachment(index)}>@ {attachment.name} <span>×</span></button>)}</div>}
    </ChatComposer>
    {status}
  </div>;
  if (composerOnly) return composer;
  return <div className={`chat-layout${embedded ? " chat-layout-embedded" : ""} ${className}`.trim()}>
    <ChatTranscript store={store} behavior={transcriptBehavior} empty={empty} footer={footer} error={error} renderChat={(nestedStore, nestedOnSubmitted, options) => <Chat store={nestedStore} embedded composerOnly={options?.composerOnly} composerDraft={options?.draftValue === undefined || !options.onDraftValueChange ? undefined : { value: options.draftValue, onChange: options.onDraftValueChange }} onSubmitted={nestedOnSubmitted} />} />
    {composer}
  </div>;
});
