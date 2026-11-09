import { observer } from "r-state-tree/react";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { IconButton } from "./ui/icon-button";
import { BrowserIcon, ChatIcon, TerminalIcon, VsCodeIcon } from "./ui/icons";
import { SegmentedControlGroup } from "./ui/segmented-control";
import { WorkspaceModeSlot } from "./ui/workspace-header";

const modeButtonClassName =
  "rounded-sm aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs aria-pressed:ring-1 aria-pressed:ring-border/50 aria-pressed:hover:bg-card focus-visible:outline-foreground/60";

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
      <WorkspaceModeSlot>
        <SegmentedControlGroup aria-label="Conversation workspace" className="shrink-0">
          <IconButton
            tooltip="Main"
            iconSize="view"
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
              iconSize="view"
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
              iconSize="view"
              className={modeButtonClassName}
              pressedAppearance="subtle"
              aria-pressed={mode === "browser"}
              onClick={onOpenBrowser}
            >
              <BrowserIcon />
            </IconButton>
          )}
        </SegmentedControlGroup>
      </WorkspaceModeSlot>
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
