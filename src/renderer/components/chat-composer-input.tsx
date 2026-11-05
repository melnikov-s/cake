import { useState, useRef, type RefObject } from "react";
import { ModelPicker } from "./model-picker";
import {
  serializeModelReference,
  type ModelReferenceSelection,
} from "../../contracts/model-presets/model-reference";
import type { ComposerInputElement } from "../lib/composer-input-element";
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
  inputRef: RefObject<ComposerInputElement | null>;
  focusRef: RefObject<ComposerFocusHandle | null>;
  focusEnabled: boolean;
  parkFocusWhileDictating: boolean;
  onReword(selection: ComposerSelection): void;
  onPromptedReword(selection: ComposerSelection): void;
  onSubmit(value: string): Promise<void>;
}) {
  const [reference, setReference] = useState<
    ComposerSelection & { model?: ModelReferenceSelection }
  >();
  const referenceAnchor = useRef<HTMLElement | null>(null);
  const configuration = store.configuration;
  const openReference = (
    selection: ComposerSelection,
    anchor: HTMLElement,
    model?: ModelReferenceSelection,
  ) => {
    referenceAnchor.current = anchor;
    setReference({ ...selection, model });
    if (configuration) void configuration.catalog.ensureLoaded();
  };
  const selectReference = (model: ModelReferenceSelection) => {
    if (!reference || store.draft !== reference.draft) {
      setReference(undefined);
      return;
    }
    const token = serializeModelReference(model);
    store.setDraft(
      reference.draft.slice(0, reference.start) + token + reference.draft.slice(reference.end),
    );
    const cursor = reference.start + token.length;
    setReference(undefined);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  };
  const conversation = store.conversationMode;
  const voiceOwnsInput =
    conversation &&
    conversation.workflow.sessionId === conversation.target.sessionId &&
    (conversation.workflow.phase === "active" || conversation.workflow.phase === "preparing");
  return (
    <>
      {reference && configuration && (
        <ModelPicker
          anchorRef={referenceAnchor}
          open
          onOpenChange={(open) => {
            if (!open) setReference(undefined);
          }}
          ariaLabel="Model reference"
          groups={() => configuration.connectedModelsByProvider}
          presets={configuration.presets}
          utilityModel={configuration.utilityModel}
          activePreset={configuration.presets.find(
            (preset) => preset.id === reference.model?.preset?.id,
          )}
          value={reference.model}
          error={configuration.catalog.error?.message}
          onSelect={(model) =>
            selectReference({
              ...model,
              ...(model.preset?.id === reference.model?.preset?.id && reference.model?.presetName
                ? { presetName: reference.model.presetName }
                : null),
            })
          }
          onSelectPreset={(preset) =>
            selectReference({
              provider: preset.provider,
              modelId: preset.modelId,
              thinkingLevel: preset.thinkingLevel,
              fastMode: preset.fastMode,
              preset: { id: preset.id, ...(preset.prompt ? { prompt: preset.prompt } : null) },
              presetName: preset.name,
            })
          }
        />
      )}
      <SlashCommandCombobox
        dictation={!voiceOwnsInput}
        dictationSubmit={
          !store.editingMessage && !store.submitsAsDraft && !store.isDraftSession
            ? () => onSubmit(inputRef.current?.value ?? store.draft)
            : undefined
        }
        provisionalText={voiceOwnsInput ? conversation.workflow.provisionalInput : undefined}
        autoFocus={focusEnabled}
        focusEnabled={focusEnabled}
        parkFocusWhileDictating={parkFocusWhileDictating}
        focusRef={focusRef}
        data-cake-hint-key="i"
        data-dictation-submission-owner={store.id}
        aria-label={store.inputLabel}
        aria-busy={store.rewording}
        inputRef={(input) => {
          inputRef.current = input;
        }}
        commands={store.commands.slice()}
        focusRequestRevision={store.focusRequestRevision}
        focusRequestIsExplicit={store.focusRequestIsExplicit}
        suggestFiles={store.canSuggestFiles ? (prefix) => store.suggestFiles(prefix) : undefined}
        placeholder={store.placeholder}
        value={store.draft}
        onValueChange={(value) => store.setDraft(value)}
        onEditModelReference={
          configuration
            ? (segment, anchor) => {
                openReference(
                  {
                    draft: store.draft,
                    start: segment.start,
                    end: segment.end,
                    text: segment.text,
                  },
                  anchor,
                  segment.model,
                );
              }
            : undefined
        }
        onContextMenu={(event) => {
          const input = inputRef.current;
          if (!input) return;
          const start = input.selectionStart;
          const end = input.selectionEnd;
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
              if (action === "insert-model") openReference(selection, input);
              else if (action === "reword") onReword(selection);
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
              const input = inputRef.current;
              if (!input) return;
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
    </>
  );
});
