import type { FormEvent, ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { Composer, ComposerToolbar } from "@/components/ai-elements/composer";
import { ChatConfigurationSelector } from "@/components/chat-configuration-selector";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";

/** The authoritative composer frame shared by every Cake chat surface. */
export const ChatComposer = observer(function ChatComposer({
  configuration,
  onSubmit,
  input,
  children,
  header,
  toolbarLeading,
  toolbarActions,
  className,
}: {
  configuration?: ChatConfigurationStore;
  onSubmit(event: FormEvent): void;
  input: ReactNode;
  children?: ReactNode;
  header?: ReactNode;
  toolbarLeading?: ReactNode;
  toolbarActions: ReactNode;
  className?: string;
}) {
  return (
    <Composer
      className={`workbench-composer${className ? ` ${className}` : ""}`}
      onSubmit={onSubmit}
    >
      {header}
      {children}
      {input}
      <ComposerToolbar className="composer-toolbar">
        <div className="composer-context">
          {toolbarLeading}
          {configuration && <ChatConfigurationSelector configuration={configuration} />}
        </div>
        <div className="composer-actions">{toolbarActions}</div>
      </ComposerToolbar>
    </Composer>
  );
});
