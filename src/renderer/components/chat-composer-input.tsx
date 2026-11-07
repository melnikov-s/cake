import { useState, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { StoreProvider, useOptionalStore } from "r-state-tree/react";
import { CaptureDestinationPicker } from "./capture-destination-picker";
import { sessionLink } from "../../contracts/conversations/message-reference";
import { DictationStore } from "../stores/DictationStore";
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
    ComposerSelection & { kind?: "session" | "move"; model?: ModelReferenceSelection }
  >();
  const referenceAnchor = useRef<HTMLElement | null>(null);
  const dictation = useOptionalStore(DictationStore);
  const [referenceInteraction, setReferenceInteraction] = useState(false);
  const restoreWritingFocus = useRef(true);
  const suspendReferenceDictation = () => {
    // Opt out before opening the native menu: ordinary blur deliberately keeps capturing.
    restoreWritingFocus.current = !dictation?.enabled || dictation.muted || dictation.capturing;
    flushSync(() => setReferenceInteraction(true));
    inputRef.current?.blur();
  };
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
  const insertReference = (token: string) => {
    if (!reference || store.draft !== reference.draft) {
      setReference(undefined);
      setReferenceInteraction(false);
      return;
    }
    store.setDraft(
      reference.draft.slice(0, reference.start) + token + reference.draft.slice(reference.end),
    );
    const cursor = reference.start + token.length;
    setReference(undefined);
    requestAnimationFrame(() => {
      // Focus while still opted out, then let normal focus eligibility re-register the field.
      // A manually stopped user must not be re-armed by the textarea-to-chip-input swap.
      if (restoreWritingFocus.current) {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(cursor, cursor);
      } else focusRef.current?.parkingAnchor()?.focus({ preventScroll: true });
      setReferenceInteraction(false);
    });
  };
  const conversation = store.conversationMode;
  const voiceOwnsInput =
    conversation &&
    conversation.workflow.sessionId === conversation.target.sessionId &&
    (conversation.workflow.phase === "active" || conversation.workflow.phase === "preparing");
  return (
    <>
      {reference?.kind === "session" && store.sessionReferencePicker && (
        <StoreProvider store={store.sessionReferencePicker}>
          <CaptureDestinationPicker
            disabled={false}
            ariaLabel="Session reference"
            anchorRef={referenceAnchor}
            open
            onOpenChange={(open) => {
              if (!open) {
                setReference(undefined);
                setReferenceInteraction(false);
              }
            }}
            onSelect={(destination) =>
              insertReference(`[Session](${sessionLink(destination.sessionId)})`)
            }
          />
        </StoreProvider>
      )}
      {reference?.kind === "move" && store.draftMovePicker && (
        <StoreProvider store={store.draftMovePicker}>
          <CaptureDestinationPicker
            disabled={false}
            ariaLabel="Move draft to session"
            anchorRef={referenceAnchor}
            open
            onOpenChange={(open) => {
              if (!open) {
                setReference(undefined);
                setReferenceInteraction(false);
              }
            }}
            onSelect={(destination) => {
              setReference(undefined);
              setReferenceInteraction(false);
              void store.moveDraft(destination);
            }}
          />
        </StoreProvider>
      )}
      {reference && !reference.kind && configuration && (
        <ModelPicker
          anchorRef={referenceAnchor}
          open
          onOpenChange={(open) => {
            if (!open) {
              setReference(undefined);
              setReferenceInteraction(false);
            }
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
            insertReference(
              serializeModelReference({
                ...model,
                ...(model.preset?.id === reference.model?.preset?.id && reference.model?.presetName
                  ? { presetName: reference.model.presetName }
                  : null),
              }),
            )
          }
          onSelectPreset={(preset) =>
            insertReference(
              serializeModelReference({
                provider: preset.provider,
                modelId: preset.modelId,
                thinkingLevel: preset.thinkingLevel,
                fastMode: preset.fastMode,
                preset: {
                  id: preset.id,
                  ...(preset.promptFile ? { promptFile: preset.promptFile } : null),
                },
                presetName: preset.name,
              }),
            )
          }
        />
      )}
      <SlashCommandCombobox
        dictation={!voiceOwnsInput && !referenceInteraction}
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
                suspendReferenceDictation();
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
          suspendReferenceDictation();
          void store
            .showComposerContextMenu(selection.text, event.clientX, event.clientY)
            .then((action) => {
              if (action === "insert-model") openReference(selection, input);
              else if (action === "insert-session" || action === "move-draft") {
                referenceAnchor.current = input;
                setReference({ ...selection, kind: action === "move-draft" ? "move" : "session" });
              } else {
                setReferenceInteraction(false);
                if (action === "reword") onReword(selection);
                else if (action === "reword-with-prompt") onPromptedReword(selection);
              }
            })
            .catch(() => setReferenceInteraction(false));
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
