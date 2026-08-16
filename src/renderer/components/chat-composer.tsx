import type { FormEvent, ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { Composer, ComposerToolbar } from "@/components/ai-elements/composer";
import { ModelCombobox } from "@/components/model-combobox";
import { thinkingLevelSchema } from "../../ipc/session-contract";
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
          <select aria-label="Thinking level" value={session?.thinkingLevel ?? "off"} onChange={(event) => void configuration.selectThinkingLevel(thinkingLevelSchema.parse(event.target.value))}>{session?.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "No reasoning" : `${level.charAt(0).toUpperCase()}${level.slice(1)} reasoning`}</option>)}</select>
        </>}
      </div>
      <div className="composer-actions">{toolbarActions}</div>
    </ComposerToolbar>
  </Composer>;
});
