import { observer } from "r-state-tree/react";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { ToolbarGroup } from "./ui/toolbar-group";
import { IconButton } from "./ui/icon-button";
import { TerminalIcon } from "./ui/icons";
import { SegmentedControlButton, SegmentedControlGroup } from "./ui/segmented-control";
import { WorkspacePanelToggle } from "./ui/workspace-panel-toggle";

export const WorkspaceModeControls = observer(function WorkspaceModeControls({
  mode,
  terminalAvailable,
  terminalOpen,
  browserHost = false,
  ideAvailable = true,
  chatSidebarVisible,
  onToggleChatSidebar,
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
  chatSidebarVisible?: boolean;
  onToggleChatSidebar?(): void;
  onBackToAgent(): void;
  onOpenBrowser(): void;
  onOpenIde(): void;
  onToggleTerminal(): void;
}) {
  return (
    <ToolbarGroup label="Workspace tools">
      <SegmentedControlGroup size="sm" aria-label="Conversation workspace">
        <SegmentedControlButton
          size="sm"
          active={mode === "normal"}
          aria-label={mode === "normal" ? "Chat" : "Back to agent"}
          onClick={onBackToAgent}
        >
          Chat
        </SegmentedControlButton>
        {ideAvailable && (
          <SegmentedControlButton
            size="sm"
            active={mode === "vscode"}
            aria-label="Open VS Code"
            className="phone:hidden"
            onClick={onOpenIde}
          >
            VS Code
          </SegmentedControlButton>
        )}
        {!browserHost && (
          <SegmentedControlButton
            size="sm"
            active={mode === "browser"}
            aria-label="Open Browser Mode"
            onClick={onOpenBrowser}
          >
            Browser
          </SegmentedControlButton>
        )}
      </SegmentedControlGroup>
      {mode !== "normal" && onToggleChatSidebar && (
        <WorkspacePanelToggle
          panel="chat"
          visible={chatSidebarVisible === true}
          onToggle={onToggleChatSidebar}
        />
      )}
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
