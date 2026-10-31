import type { RefObject } from "react";
import { observer } from "r-state-tree/react";
import {
  SlashCommandCombobox,
  type ComposerFocusHandle,
} from "@/components/slash-command-combobox";
import type { ChatStore } from "../stores/ChatStore";
import { isLargePaste } from "../../contracts/conversations/task-input";

interface ComposerSelection {
  draft: string;
  start: number;
  end: number;
  text: string;
}

/** Draft-bound composer input, isolated so typing does not render the surrounding chat. */
export const ChatComposerInput = observer(function ChatComposerInput({
  store,
  inputRef,
  focusRef,
  focusEnabled,
  parkFocusWhileDictating,
  onReword,
  onPromptedReword,
  onSubmit,
}: {
  store: ChatStore;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  focusRef: RefObject<ComposerFocusHandle | null>;
  focusEnabled: boolean;
  parkFocusWhileDictating: boolean;
  onReword(selection: ComposerSelection): void;
  onPromptedReword(selection: ComposerSelection): void;
  onSubmit(value: string): Promise<void>;
}) {
  const conversation = store.conversationMode;
  const voiceOwnsInput =
    conversation &&
    conversation.workflow.sessionId === conversation.target.sessionId &&
    (conversation.workflow.phase === "active" || conversation.workflow.phase === "preparing");
  return (
    <SlashCommandCombobox
      dictation={!voiceOwnsInput}
      provisionalText={voiceOwnsInput ? conversation.workflow.provisionalInput : undefined}
      autoFocus={focusEnabled}
      focusEnabled={focusEnabled}
      parkFocusWhileDictating={parkFocusWhileDictating}
      focusRef={focusRef}
      data-cake-hint-key="i"
      aria-label={store.inputLabel}
      aria-busy={store.rewording}
      inputRef={(input) => {
        inputRef.current = input;
      }}
      commands={store.commands}
      focusRequestRevision={store.focusRequestRevision}
      suggestFiles={store.canSuggestFiles ? (prefix) => store.suggestFiles(prefix) : undefined}
      placeholder={store.placeholder}
      value={store.draft}
      onValueChange={(value) => store.setDraft(value)}
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
            if (action === "reword") onReword(selection);
            else if (action === "reword-with-prompt") onPromptedReword(selection);
          });
      }}
      onPaste={(event) => {
        const text = store.canPasteText ? event.clipboardData.getData("text/plain") : "";
        const images = store.canPasteImages
          ? [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"))
          : [];
        if (store.canPasteImages && images.length === 0)
          for (const item of event.clipboardData.items) {
            if (!item.type.startsWith("image/")) continue;
            const file = item.getAsFile();
            if (file) images.push(file);
          }
        if (images.length > 0) {
          event.preventDefault();
          // A screenshot copy offers both formats. Suppressing native paste for the image
          // must not throw away its numbered annotation text (or paste it twice).
          if (text && !isLargePaste(text)) {
            const input = event.currentTarget;
            store.setDraft(
              input.value.slice(0, input.selectionStart) +
                text +
                input.value.slice(input.selectionEnd),
            );
          } else if (text) store.addPastedText(text);
          void store.addPastedImages(images);
        } else if (store.canPasteText && isLargePaste(text)) {
          event.preventDefault();
          store.addPastedText(text);
        }
      }}
      onSubmit={onSubmit}
      onEscape={store.canStop ? () => void store.abort() : undefined}
    />
  );
});
