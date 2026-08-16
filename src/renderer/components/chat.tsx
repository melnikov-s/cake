import { forwardRef, type ComponentProps, type ReactNode, type RefObject } from "react";
import { observer } from "r-state-tree/react";
import { Conversation } from "@/components/ai-elements/conversation";
import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageContent, MessageLabel } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { ChatComposer } from "@/components/chat-composer";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import type { UiPart } from "../../ipc/session-contract";
import type { ChatStore } from "../stores/ChatStore";

function Icon({ children }: { children: ReactNode }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

const PaperclipIcon = () => <Icon><path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9" /></Icon>;
const SendIcon = () => <Icon><path d="m5 12 7-7 7 7M12 19V5" /></Icon>;

export function chatWorkIsActive(parts: UiPart[], streaming: boolean, submitting: boolean) {
  if (streaming) return true;
  if (!submitting) return false;
  const latestUserIndex = parts.findLastIndex((part) => (part.kind === "text" && part.role === "user") || (part.kind === "attachment" && part.attachmentKind === "image"));
  return latestUserIndex < 0 || latestUserIndex === parts.length - 1;
}

export const ChatTextMessage = forwardRef<HTMLElement, {
  part: Extract<UiPart, { kind: "text" }>;
  contentRef?: RefObject<HTMLDivElement | null>;
  onMouseUp?: ComponentProps<"div">["onMouseUp"];
  children?: ReactNode;
}>(function ChatTextMessage({ part, contentRef, onMouseUp, children }, ref) {
  const assistant = part.role === "assistant";
  const userLabel = part.deliveryState === "queued" ? "You · queued" : part.deliveryState === "steering" ? "You · steering next" : part.deliveryState === "sending" ? "You · sending" : "You";
  return <Message ref={ref} className={assistant ? "assistant-message mr-auto w-full" : "ml-auto w-[min(88%,42rem)]"}>
    <MessageLabel>{assistant ? part.status === "streaming" ? "Cake · working" : "Cake" : userLabel}</MessageLabel>
    <MessageContent ref={contentRef} className={assistant ? "assistant-message-content" : "user-message"} onMouseUp={onMouseUp}>
      <Markdown>{part.text}</Markdown>
    </MessageContent>
    {children}
  </Message>;
});

const DefaultChatTranscript = observer(function DefaultChatTranscript({ store, empty }: { store: ChatStore; empty?: ReactNode }) {
  const textParts = store.parts.filter((part): part is Extract<UiPart, { kind: "text" }> => part.kind === "text");
  const showLoading = chatWorkIsActive(store.parts, store.streaming, store.submitting);
  return <div className="transcript chat-basic-transcript"><Conversation>
    {textParts.length === 0 ? empty : textParts.map((part) => <ChatTextMessage key={part.id} part={part} />)}
    {showLoading && <LoadingState />}
    {store.error?.message && <div className="notice notice-error" role="alert"><strong>{store.error.title ?? "Operation failed"}</strong><span>{store.error.message}</span></div>}
  </Conversation></div>;
});

function Usage({ store }: { store: ChatStore }) {
  const usage = store.usage;
  if (!usage) return null;
  const context = usage.context;
  const percent = context?.percent === null || context?.percent === undefined ? undefined : Math.round(context.percent);
  const contextLabel = percent === undefined ? "Context usage unavailable" : `${percent}% context used`;
  const contextTitle = context ? `${context.tokens === null ? "Unknown" : context.tokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens` : "Context usage is unavailable";
  return <div className="session-usage" aria-label={`${contextLabel}, session cost $${usage.cost.toFixed(3)}`} title={`${contextTitle} · ${usage.tokens.total.toLocaleString()} billed tokens`}><svg className="context-gauge" viewBox="0 0 36 36" aria-hidden="true"><circle className="context-gauge-track" cx="18" cy="18" r="15.5" pathLength="100" /><circle className="context-gauge-value" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${Math.min(100, percent ?? 0)} 100`} /><text x="18" y="18">{percent === undefined ? "—" : `${percent}%`}</text></svg><span className="session-cost">${usage.cost.toFixed(3)}</span></div>;
}

export const Chat = observer(function Chat({ store, transcript, empty, footer, status, composerContent, pluginActions, className = "", embedded = false, composerOnly = false, onSubmitted }: {
  store: ChatStore;
  transcript?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  status?: ReactNode;
  composerContent?: ReactNode;
  pluginActions?: ReactNode;
  className?: string;
  embedded?: boolean;
  composerOnly?: boolean;
  onSubmitted?(): void;
}) {
  const submit = async (value?: string, mode: "send" | "steer" = "send") => {
    if (await store.submit(value, mode)) onSubmitted?.();
  };
  const composer = store.composerVisible && <div className={embedded ? "chat-embedded-composer" : "composer-dock"}>
    <ChatComposer className={embedded ? "chat-embedded-workbench-composer" : undefined} configuration={store.configuration} onSubmit={(event) => { event.preventDefault(); void submit(); }} input={<SlashCommandCombobox autoFocus aria-label={store.inputLabel} commands={store.commands} focusRequestRevision={store.focusRequestRevision} suggestFiles={store.canSuggestFiles ? (prefix) => store.suggestFiles(prefix) : undefined} placeholder={store.placeholder} value={store.draft} disabled={store.submittingLocally} onValueChange={(value) => store.setDraft(value)} onPaste={(event) => {
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
      <Button className="send-button" size="sm" type="submit" disabled={!store.canSubmit}>{store.submitting ? "Sending…" : store.streaming ? "Queue" : "Send"}<SendIcon /></Button>
    </>}>
      {composerContent}
      {store.attachments.length > 0 && <div className="attachment-list">{store.attachments.map((attachment, index) => attachment.kind === "image"
        ? <button className="image-attachment" type="button" aria-label={`Remove ${attachment.name}`} key={`${attachment.kind}-${attachment.name}-${index}`} onClick={() => store.removeAttachment(index)}><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /><span>{attachment.name}<b aria-hidden="true">×</b></span></button>
        : <button type="button" key={`${attachment.kind}-${attachment.name}-${index}`} onClick={() => store.removeAttachment(index)}>@ {attachment.name} <span>×</span></button>)}</div>}
    </ChatComposer>
    {status}
  </div>;
  if (composerOnly) return composer;
  return <div className={`chat-layout ${className}`.trim()}>{transcript ?? <DefaultChatTranscript store={store} empty={empty} />}{footer}{composer}</div>;
});
