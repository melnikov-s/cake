import type { RefObject } from "react";
import { observer } from "r-state-tree/react";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import type { ChatStore } from "../stores/ChatStore";

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
  onReword,
  onPromptedReword,
  onSubmit,
}: {
  store: ChatStore;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onReword(selection: ComposerSelection): void;
  onPromptedReword(selection: ComposerSelection): void;
  onSubmit(value: string): Promise<void>;
}) {
  return (
    <SlashCommandCombobox
      autoFocus
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
      onSubmit={onSubmit}
      onEscape={store.canStop ? () => void store.abort() : undefined}
    />
  );
});
