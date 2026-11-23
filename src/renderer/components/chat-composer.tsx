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
  const accessoryNode = leadingAccessory && (
    <div
      data-slot="composer-leading-accessory"
      className={cn(
        "flex shrink-0 items-center transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none [&_button]:size-7 [&_[data-slot=avatar]]:size-5",
        leadingAccessoryVisible
          ? "scale-100 opacity-100"
          : "pointer-events-none scale-75 opacity-0",
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
        "max-w-[51.25rem]",
        className,
      )}
    >
      {header}
      <div className="relative">
        <DictationIndicatorContext.Provider value={dictationSlot}>
          <Composer
            className={cn(
              "relative z-10 border-hairline bg-composer text-composer-foreground shadow-[inset_0_1px_0_var(--surface-rim),0_20px_60px_-28px_hsl(var(--shadow)/0.55),0_2px_10px_hsl(var(--shadow)/0.1)]",
              inline &&
                "flex items-center gap-1.5 border-0 bg-transparent p-1.5 shadow-none focus-within:ring-0 [&_textarea]:min-h-8 [&_textarea]:max-h-40 [&_textarea]:px-2.5 [&_textarea]:py-1 [&_textarea]:text-xs [&_textarea]:shadow-none [&_[contenteditable=true]]:min-h-8 [&_[contenteditable=true]]:max-h-40 [&_[contenteditable=true]]:px-2.5 [&_[contenteditable=true]]:py-1 [&_[contenteditable=true]]:text-xs [&_[contenteditable=true]]:shadow-none",
            )}
            onSubmit={onSubmit}
          >
            {children}
            {inline && dictationNode}
            {input && (
              <div
                data-slot="composer-input"
                className={cn("relative", inline && "min-w-0 flex-1")}
              >
                {input}
              </div>
            )}
            <ComposerToolbar
              data-slot="composer-toolbar"
              separated={!inline && toolbarSeparated}
              className={cn(
                "flex min-w-0 items-center justify-between gap-x-3 gap-y-1 px-1.5 py-1",
                inline && "flex-none p-0",
              )}
            >
              {!inline && (
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                  {accessoryNode}
                  {dictationNode}
                  {toolbarLeading}
                  {configuration && <ChatConfigurationSelector configuration={configuration} />}
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
