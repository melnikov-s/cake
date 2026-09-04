import type { FormEvent, ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { Composer, ComposerToolbar } from "@/components/ai-elements/composer";
import { ChatConfigurationSelector } from "@/components/chat-configuration-selector";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";
import { cn } from "@/lib/utils";

/** The authoritative composer frame shared by every Cake chat surface. */
export const ChatComposer = observer(function ChatComposer({
  configuration,
  onSubmit,
  input,
  children,
  header,
  toolbarLeading,
  toolbarActions,
  toolbarSeparated = true,
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
  className?: string;
}) {
  return (
    <div
      className={cn(
        "workbench-composer pointer-events-auto mx-auto w-full max-w-[51.25rem] min-w-0",
        className,
      )}
    >
      {header}
      <Composer
        className="relative z-10 border-border/90 bg-composer shadow-[0_24px_80px_-30px_hsl(var(--shadow)/0.55),0_2px_10px_hsl(var(--shadow)/0.08)]"
        onSubmit={onSubmit}
      >
        {children}
        {input}
        <ComposerToolbar
          data-slot="composer-toolbar"
          separated={toolbarSeparated}
          className="flex min-w-0 items-center justify-between gap-3 px-1.5 py-1"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {toolbarLeading}
            {configuration && <ChatConfigurationSelector configuration={configuration} />}
          </div>
          <div className="flex shrink-0 items-center gap-1">{toolbarActions}</div>
        </ComposerToolbar>
      </Composer>
    </div>
  );
});
