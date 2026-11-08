import { observer } from "r-state-tree/react";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { IconButton } from "./ui/icon-button";
import { BrowserIcon, SidebarIcon, TerminalIcon, VsCodeIcon } from "./ui/icons";

export const WorkspaceModeControls = observer(function WorkspaceModeControls({
  mode,
  terminalAvailable,
  terminalOpen,
  browserHost = false,
  ideAvailable = true,
  onBackToAgent,
  onOpenBrowser,
  onOpenIde,
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
  onToggleTerminal(): void;
}) {
  return (
    <div role="group" aria-label="Workspace tools" className="flex shrink-0 items-center gap-1">
      <div
        role="group"
        aria-label="Conversation workspace"
        className="flex shrink-0 items-center gap-0.5 [&_button>svg]:size-5 [&_button[aria-pressed=true]]:bg-accent/10"
      >
        <IconButton
          tooltip="Main"
          pressedAppearance="subtle"
          aria-pressed={mode === "normal"}
          onClick={onBackToAgent}
        >
          <SidebarIcon />
        </IconButton>
        {ideAvailable && (
          <IconButton
            tooltip="VS Code"
            pressedAppearance="subtle"
            aria-pressed={mode === "vscode"}
            className="phone:hidden"
            onClick={onOpenIde}
          >
            <VsCodeIcon />
          </IconButton>
        )}
        {!browserHost && (
          <IconButton
            tooltip="Browser"
            pressedAppearance="subtle"
            aria-pressed={mode === "browser"}
            onClick={onOpenBrowser}
          >
            <BrowserIcon />
          </IconButton>
        )}
      </div>
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border/60 phone:hidden" />
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
