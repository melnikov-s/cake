import type { ComponentProps, ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { ChatTranscriptBehavior } from "./chat-message";
import type { ChatStore } from "../stores/ChatStore";
import type { DrawStore } from "../stores/DrawStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { Chat } from "./chat";
import { DrawBoardToolbar } from "./draw-board-toolbar";
import { DrawCanvas } from "./draw-canvas";
import { SideChatLayout } from "./side-chat-layout";
import { WorkspaceChatLayout } from "./workspace-chat-layout";

export const DrawWorkspace = observer(function DrawWorkspace({
  draw,
  sidebarCollapsed,
  canGoBack,
  canGoForward,
  onBackToAgent,
  onToggleSidebar,
  onGoBack,
  onGoForward,
  projectChat,
  sideChat,
  headerActions,
  conversationAccessory,
  projectComposerHeader,
  projectComposerContent,
  projectComposerLeadingAccessory,
  projectSidebar,
  projectSidebarVisible,
  projectSidebarWidth,
  onProjectSidebarWidthChange,
  sessionTitle,
  terminalDock,
  transcriptBehavior,
  chatSidebarVisible,
  chatSidebarWidth,
  onChatSidebarWidthChange,
}: {
  draw: DrawStore;
  sidebarCollapsed: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBackToAgent(): void;
  onToggleSidebar(): void;
  onGoBack(): void;
  onGoForward(): void;
  projectChat: ChatStore;
  sideChat: SideChatStore;
  headerActions?: ReactNode;
  conversationAccessory?(children: ReactNode): ReactNode;
  projectComposerHeader?: ReactNode;
  projectComposerContent?: ReactNode;
  projectComposerLeadingAccessory?: ComponentProps<typeof Chat>["composerLeadingAccessory"];
  projectSidebar: ReactNode;
  projectSidebarVisible: boolean;
  projectSidebarWidth: number;
  onProjectSidebarWidthChange(width: number): void;
  sessionTitle: string;
  terminalDock?: ReactNode;
  transcriptBehavior: ChatTranscriptBehavior;
  chatSidebarVisible: boolean;
  chatSidebarWidth: number;
  onChatSidebarWidthChange(width: number): void;
}) {
  const sideChatTranscriptBehavior =
    transcriptBehavior.openSourceLocation || transcriptBehavior.workspacePath
      ? {
          openSourceLocation: transcriptBehavior.openSourceLocation,
          workspacePath: transcriptBehavior.workspacePath,
        }
      : undefined;
  const conversation = (
    <SideChatLayout
      store={sideChat}
      renderChat={(sideChatStore) => (
        <Chat
          store={sideChatStore}
          embedded
          compact
          transcriptBehavior={sideChatTranscriptBehavior}
        />
      )}
    >
      <Chat
        className="h-full"
        store={projectChat}
        transcriptBehavior={transcriptBehavior}
        composerHeader={projectComposerHeader}
        composerContent={projectComposerContent}
        composerLeadingAccessory={projectComposerLeadingAccessory}
      />
    </SideChatLayout>
  );

  return (
    <WorkspaceChatLayout
      workspace={
        <div className="flex h-full min-h-0 flex-col">
          <DrawBoardToolbar
            store={draw}
            sidebarCollapsed={sidebarCollapsed}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onBackToAgent={onBackToAgent}
            onToggleSidebar={onToggleSidebar}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
          />
          <div className="min-h-0 flex-1">
            {draw.activeBoardId && !draw.loading ? (
              <DrawCanvas key={draw.activeBoardId} store={draw} />
            ) : null}
          </div>
        </div>
      }
      workspaceLabel="Cake Draw whiteboard"
      chatSidebarVisible={chatSidebarVisible}
      chatSidebarWidth={chatSidebarWidth}
      onChatSidebarWidthChange={onChatSidebarWidthChange}
      projectSidebar={projectSidebar}
      projectSidebarVisible={projectSidebarVisible}
      projectSidebarWidth={projectSidebarWidth}
      onProjectSidebarWidthChange={onProjectSidebarWidthChange}
      terminalDock={terminalDock}
      chatSidebar={
        <>
          <header className="flex h-[46px] select-none items-center justify-between gap-3 border-b border-border px-3 [-webkit-app-region:drag]">
            <strong className="block min-w-0 truncate text-xs">{sessionTitle}</strong>
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              {headerActions}
            </div>
          </header>
          <div className="min-h-0 flex-1">
            {conversationAccessory ? conversationAccessory(conversation) : conversation}
          </div>
        </>
      }
    />
  );
});
