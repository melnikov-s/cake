import { observer } from "r-state-tree/react";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { IconButton } from "./ui/icon-button";
import { BrowserIcon, CanvasIcon, ChatIcon, TerminalIcon, VsCodeIcon } from "./ui/icons";
import { WorkspaceModeSlot } from "./ui/workspace-header";

const modeButtonClassName =
  "h-6 w-8 rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[inset_0_1px_0_var(--surface-rim),0_1px_2px_rgb(0_0_0/0.14)] aria-pressed:hover:bg-card focus-visible:outline-foreground/60 focus-visible:-outline-offset-2";

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
          className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-foreground/[0.05] px-0.5 py-px select-none"
        >
          <IconButton
            tooltip="Main"
            iconSize="navigation"
            className={modeButtonClassName}
            pressedAppearance="subtle"
            aria-pressed={mode === "normal"}
            onClick={onBackToAgent}
          >
            <ChatIcon />
          </IconButton>
          {ideAvailable && (
            <IconButton
              tooltip="VS Code"
              iconSize="navigation"
              pressedAppearance="subtle"
              aria-pressed={mode === "vscode"}
              className={`${modeButtonClassName} phone:hidden`}
              onClick={onOpenIde}
            >
              <VsCodeIcon />
            </IconButton>
          )}
          {!browserHost && (
            <IconButton
              tooltip="Browser"
              iconSize="navigation"
              className={modeButtonClassName}
              pressedAppearance="subtle"
              aria-pressed={mode === "browser"}
              onClick={onOpenBrowser}
            >
              <BrowserIcon />
            </IconButton>
          )}
          {onOpenCanvas && (
            <IconButton
              tooltip="Project Canvas"
              iconSize="navigation"
              pressedAppearance="subtle"
              aria-pressed={mode === "canvas"}
              className={modeButtonClassName}
              onClick={onOpenCanvas}
            >
              <CanvasIcon />
            </IconButton>
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
