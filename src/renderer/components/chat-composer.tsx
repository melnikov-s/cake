import { useState, type FormEvent, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { Composer, ComposerToolbar } from "@/components/ai-elements/composer";
import { ChatConfigurationSelector } from "@/components/chat-configuration-selector";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";
import { cn } from "@/lib/utils";
import { DictationIndicatorContext } from "../dictation/dictation-indicator-context";

/** The authoritative composer frame shared by chat and annotation surfaces. */
export const ChatComposer = observer(function ChatComposer({
  configuration,
  onSubmit,
  input,
  children,
  header,
  toolbarLeading,
  toolbarActions,
  toolbarSeparated = true,
  inline = false,
  leadingAccessory,
  leadingAccessoryVisible = false,
  className,
}: {
  configuration?: ChatConfigurationStore;
  onSubmit(event: FormEvent): void;
  input?: ReactNode;
  children?: ReactNode;
  header?: ReactNode;
  toolbarLeading?: ReactNode;
  toolbarActions: ReactNode;
  toolbarSeparated?: boolean;
  /** Compact voice/input/submit row; normal chat keeps its configuration toolbar. */
  inline?: boolean;
  leadingAccessory?: ReactNode;
  leadingAccessoryVisible?: boolean;
  className?: string;
}) {
  const [dictationSlot, setDictationSlot] = useState<HTMLDivElement | null>(null);
  const dictationNode = (
    <div
      ref={setDictationSlot}
      data-slot="composer-dictation"
      className="flex shrink-0 items-center empty:hidden"
    />
  );
  // Anchor the accessory to the input row when one exists so it tracks the textarea
  // beneath annotations and attachments; the offsets compensate for the Composer
  // frame's 0.75rem padding and 1px border so the resting position is unchanged.
  const accessoryNode = leadingAccessory && (
    <div
      data-slot="composer-leading-accessory"
      className={cn(
        "absolute z-20 block transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none @4xl/composer-dock:left-auto @4xl/composer-dock:right-full",
        input
          ? "left-[calc(0.25rem-1px)] top-[calc(0.25rem-1px)] @4xl/composer-dock:top-[calc(1rem-1px)] @4xl/composer-dock:mr-[calc(1.5rem+1px)]"
          : "left-4 top-4 @4xl/composer-dock:top-7 @4xl/composer-dock:mr-3",
        leadingAccessoryVisible
          ? "scale-100 opacity-100"
          : "pointer-events-none translate-x-2 scale-75 opacity-0",
      )}
      aria-hidden={!leadingAccessoryVisible}
      inert={!leadingAccessoryVisible ? true : undefined}
    >
      {leadingAccessory}
    </div>
  );
  return (
    <div
      className={cn(
        "workbench-composer @container/context-composer pointer-events-auto mx-auto w-full min-w-0 has-[[data-slot=inset-disclosures]]:[&_form]:rounded-t-none has-[[data-slot=inset-disclosures]]:[&_form]:rounded-b-[14px]",
        // The composer itself stays centered; a wide dock hangs the leading accessory
        // outside its left edge instead of padding the composer for it.
        "max-w-[51.25rem]",
        className,
      )}
    >
      {header}
      <div className="relative">
        {!input && accessoryNode}
        <DictationIndicatorContext.Provider value={dictationSlot}>
          <Composer
            className={cn(
              "relative z-10 border-hairline bg-composer text-composer-foreground shadow-[inset_0_1px_0_var(--surface-rim),0_20px_60px_-28px_hsl(var(--shadow)/0.55),0_2px_10px_hsl(var(--shadow)/0.1)]",
              leadingAccessory &&
                "[&_textarea]:pl-12 [&_[contenteditable=true]]:pl-12 @4xl/composer-dock:[&_textarea]:pl-2 @4xl/composer-dock:[&_[contenteditable=true]]:pl-2",
              inline &&
                "flex items-center gap-1.5 border-0 bg-transparent p-1.5 shadow-none focus-within:ring-0 [&_textarea]:min-h-8 [&_textarea]:max-h-40 [&_textarea]:px-2.5 [&_textarea]:py-1 [&_textarea]:text-xs [&_textarea]:shadow-none [&_[contenteditable=true]]:min-h-8 [&_[contenteditable=true]]:max-h-40 [&_[contenteditable=true]]:px-2.5 [&_[contenteditable=true]]:py-1 [&_[contenteditable=true]]:text-xs [&_[contenteditable=true]]:shadow-none",
            )}
            onSubmit={onSubmit}
          >
            {children}
            {!inline && configuration?.antigravity?.selected && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {configuration.antigravity.projectChat
                  ? "Each turn starts fresh. Google Antigravity receives your message, Cake instructions, and selected chat excerpts, not Pi replies, attachments, or tool logs. It can access the workspace. Only a local Cake window can allow Cake operations. One approval covers the operation and sharing its result with Google."
                  : "Cake sends its instructions and this message, not Pi history. Antigravity can access the workspace and may remember its own earlier turns."}
              </p>
            )}
            {inline && dictationNode}
            {input && (
              <div
                data-slot="composer-input"
                className={cn("relative", inline && "min-w-0 flex-1")}
              >
                {accessoryNode}
                {input}
              </div>
            )}
            <ComposerToolbar
              data-slot="composer-toolbar"
              separated={!inline && toolbarSeparated}
              className={cn(
                "flex min-w-0 items-center justify-between gap-x-3 gap-y-1 px-1.5 py-1",
                leadingAccessory && !input && "pl-12 @4xl/composer-dock:pl-1.5",
                inline && "flex-none p-0",
              )}
            >
              {!inline && (
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                  {dictationNode}
                  {toolbarLeading}
                  {configuration && (
                    <ChatConfigurationSelector configuration={configuration} inComposer />
                  )}
                </div>
              )}
              <div
                className={cn(
                  "flex shrink-0 items-center gap-1",
                  !inline && "ml-auto min-w-0 max-w-full flex-wrap justify-end",
                )}
              >
                {toolbarActions}
              </div>
            </ComposerToolbar>
          </Composer>
        </DictationIndicatorContext.Provider>
      </div>
    </div>
  );
});
