import type { FormEvent, ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { Composer, ComposerToolbar } from "@/components/ai-elements/composer";
import { ModelCombobox } from "@/components/model-combobox";
import { ThinkingLevelSelect } from "@/components/thinking-level-select";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";

/** The authoritative composer frame shared by every Cake chat surface. */
export const ChatComposer = observer(function ChatComposer({ configuration, onSubmit, input, children, toolbarLeading, toolbarActions, className }: {
  configuration?: ChatConfigurationStore;
  onSubmit(event: FormEvent): void;
  input: ReactNode;
  children?: ReactNode;
  toolbarLeading?: ReactNode;
  toolbarActions: ReactNode;
  className?: string;
}) {
  const session = configuration?.session;
  const selectedModel = session?.model;
  return <Composer className={`workbench-composer${className ? ` ${className}` : ""}`} onSubmit={onSubmit}>
    {children}
    {input}
    <ComposerToolbar className="composer-toolbar">
      <div className="composer-context">
        {toolbarLeading}
        {configuration && <>
          <ModelCombobox ariaLabel="Model" groups={configuration.connectedModelsByProvider} value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onSelect={(value) => void configuration.selectModel(value)} />
          <ThinkingLevelSelect ariaLabel="Thinking level" value={session?.thinkingLevel ?? "off"} levels={session?.availableThinkingLevels ?? ["off"]} onSelect={(level) => void configuration.selectThinkingLevel(level)} />
        </>}
      </div>
      <div className="composer-actions">{toolbarActions}</div>
    </ComposerToolbar>
  </Composer>;
});
