import { observer } from "r-state-tree/react";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { ToolbarGroup } from "./ui/toolbar-group";
import { IconButton } from "./ui/icon-button";
import { BrowserIcon, CakeIcon, TerminalIcon, VsCodeIcon } from "./ui/icons";

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
  mode: Exclude<ProjectSessionPresentationMode, "normal">;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  browserHost?: boolean;
  ideAvailable?: boolean;
  onBackToAgent(): void;
  onOpenBrowser(): void;
  onOpenIde(): void;
  onToggleTerminal(): void;
}) {
  const modeControl = (target: Exclude<ProjectSessionPresentationMode, "normal">) => {
    if (target === mode)
      return (
        <IconButton key={target} tooltip="Back to agent" onClick={onBackToAgent}>
          <CakeIcon />
        </IconButton>
      );

    if (target === "browser")
      return browserHost ? null : (
        <IconButton key={target} tooltip="Open Browser Mode" onClick={onOpenBrowser}>
          <BrowserIcon />
        </IconButton>
      );

    if (!ideAvailable) return null;
    return (
      <IconButton
        key={target}
        data-cake-hint-key="v"
        className="phone:hidden"
        tooltip="Open VS Code"
        hotkey="open-editor"
        onClick={onOpenIde}
      >
        <VsCodeIcon />
      </IconButton>
    );
  };

  return (
    <ToolbarGroup label="Workspace tools">
      {(["browser", "vscode"] as const).map(modeControl)}
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
    </ToolbarGroup>
  );
});
