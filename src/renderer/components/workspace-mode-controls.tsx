import { observer } from "r-state-tree/react";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { BrowserIcon, CanvasIcon, ChatIcon, TerminalIcon, VsCodeIcon } from "./ui/icons";
import { WorkspaceModeSlot } from "./ui/workspace-header";
import { cn } from "@/lib/utils";

const modeButtonClassName =
  "h-6 gap-1.5 rounded-[6px] px-2 text-xs font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[inset_0_1px_0_var(--surface-rim),0_1px_2px_rgb(0_0_0/0.12)] aria-pressed:hover:bg-card focus-visible:outline-foreground/60 focus-visible:-outline-offset-2 max-[960px]:w-8 max-[960px]:px-0";

const modeLabelClassName = "max-[960px]:hidden";

export const WorkspaceModeControls = observer(function WorkspaceModeControls({
  mode,
  terminalAvailable,
  terminalOpen,
  browserHost = false,
  ideAvailable = true,
  onBackToAgent,
  onOpenBrowser,
  onOpenIde,
  onOpenCanvas,
  onToggleTerminal,
}: {
  mode: ProjectSessionPresentationMode;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  browserHost?: boolean;
  ideAvailable?: boolean;
  onBackToAgent(): void;
  onOpenBrowser(): void;
  onOpenIde(): void;
  onOpenCanvas?(): void;
  onToggleTerminal(): void;
}) {
  return (
    <div role="group" aria-label="Workspace tools" className="flex shrink-0 items-center gap-1">
      <WorkspaceModeSlot>
        <div
          role="group"
          aria-label="Conversation workspace"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-foreground/[0.05] p-0.5 select-none"
        >
          <Button
            variant="ghost"
            size="sm"
            iconSize="inline"
            title="Main"
            aria-label="Main"
            className={modeButtonClassName}
            aria-pressed={mode === "normal"}
            onClick={onBackToAgent}
          >
            <ChatIcon />
            <span className={modeLabelClassName}>Chat</span>
          </Button>
          {ideAvailable && (
            <Button
              variant="ghost"
              size="sm"
              iconSize="inline"
              title="VS Code"
              aria-label="VS Code"
              aria-pressed={mode === "vscode"}
              className={cn(modeButtonClassName, "phone:hidden")}
              onClick={onOpenIde}
            >
              <VsCodeIcon />
              <span className={modeLabelClassName}>Code</span>
            </Button>
          )}
          {!browserHost && (
            <Button
              variant="ghost"
              size="sm"
              iconSize="inline"
              title="Browser"
              aria-label="Browser"
              className={modeButtonClassName}
              aria-pressed={mode === "browser"}
              onClick={onOpenBrowser}
            >
              <BrowserIcon />
              <span className={modeLabelClassName}>Browser</span>
            </Button>
          )}
          {onOpenCanvas && (
            <Button
              variant="ghost"
              size="sm"
              iconSize="inline"
              title="Project Canvas"
              aria-label="Project Canvas"
              aria-pressed={mode === "canvas"}
              className={modeButtonClassName}
              onClick={onOpenCanvas}
            >
              <CanvasIcon />
              <span className={modeLabelClassName}>Canvas</span>
            </Button>
          )}
        </div>
      </WorkspaceModeSlot>
      <IconButton
        data-cake-hint-key="t"
        className="phone:hidden"
        tooltip="Terminal"
        hotkey="toggle-terminal"
        disabled={!terminalAvailable}
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
      >
        <TerminalIcon />
      </IconButton>
    </div>
  );
});
