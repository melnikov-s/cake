import { observer } from "r-state-tree/react";
import type { ProjectSessionPresentationMode } from "../../domain/project-sessions/project-session-presentation";
import type { ChatStore } from "../stores/ChatStore";
import { WorkLogControls } from "./work-log-controls";
import { IconButton } from "./ui/icon-button";
import {
  BrowserIcon,
  CakeIcon,
  TerminalIcon,
  TreeIcon,
  VsCodeIcon,
  WhiteboardIcon,
} from "./ui/icons";

export const WorkspaceModeControls = observer(function WorkspaceModeControls({
  mode,
  chat,
  treeOpen,
  terminalAvailable,
  terminalOpen,
  terminalAcceleratorHint,
  onToggleTree,
  onBackToAgent,
  onOpenDraw,
  onOpenBrowser,
  onOpenIde,
  onToggleTerminal,
}: {
  mode: Exclude<ProjectSessionPresentationMode, "normal">;
  chat: ChatStore;
  treeOpen: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalAcceleratorHint: string;
  onToggleTree(): void;
  onBackToAgent(): void;
  onOpenDraw(): void;
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

    if (target === "draw")
      return (
        <IconButton key={target} tooltip="Open Cake Draw" onClick={onOpenDraw}>
          <WhiteboardIcon />
        </IconButton>
      );

    if (target === "browser")
      return (
        <IconButton key={target} tooltip="Open Browser Mode" onClick={onOpenBrowser}>
          <BrowserIcon />
        </IconButton>
      );

    return (
      <IconButton key={target} data-cake-hint-key="v" tooltip="Open VS Code" onClick={onOpenIde}>
        <VsCodeIcon />
      </IconButton>
    );
  };

  return (
    <>
      <IconButton
        data-cake-hint-key="r"
        tooltip="Session tree"
        aria-pressed={treeOpen}
        onClick={onToggleTree}
      >
        <TreeIcon />
      </IconButton>
      <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />
      <WorkLogControls store={chat} />
      <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />
      {(["draw", "browser", "vscode"] as const).map(modeControl)}
      <IconButton
        data-cake-hint-key="t"
        tooltip={`Terminal (${terminalAcceleratorHint})`}
        disabled={!terminalAvailable}
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
      >
        <TerminalIcon />
      </IconButton>
    </>
  );
});
