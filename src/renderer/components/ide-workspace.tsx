import { useState, type CSSProperties, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import type { ChatTranscriptBehavior } from "./chat-message";
import type { ChatStore } from "../stores/ChatStore";
import type { EmbeddedEditorStore } from "../stores/EmbeddedEditorStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { Button } from "./ui/button";
import { Chat } from "./chat";
import { EmbeddedEditorPane } from "./embedded-editor";
import { ResizeHandle } from "./ui/resize-handle";

function anchorTitle(anchor: NonNullable<ReviewsStore["draftAnchor"]>) {
  const start = anchor.start.newLine ?? anchor.start.oldLine;
  const end = anchor.end.newLine ?? anchor.end.oldLine;
  if (!start) return anchor.path;
  return end && end !== start ? `${anchor.path} · L${start}–${end}` : `${anchor.path} · L${start}`;
}

export const IdeWorkspace = observer(function IdeWorkspace({
  editor,
  reviews,
  projectChat,
  projectComposerHeader,
  projectSidebar,
  projectSidebarVisible,
  projectSidebarWidth,
  onProjectSidebarWidthChange,
  sessionTitle,
  transcriptBehavior,
}: {
  editor: EmbeddedEditorStore;
  reviews: ReviewsStore;
  projectChat: ChatStore;
  projectComposerHeader?: ReactNode;
  projectSidebar: ReactNode;
  projectSidebarVisible: boolean;
  projectSidebarWidth: number;
  onProjectSidebarWidthChange(width: number): void;
  sessionTitle: string;
  transcriptBehavior: ChatTranscriptBehavior;
}) {
  const [resizing, setResizing] = useState(false);
  const chatSidebarMax = Math.max(
    320,
    window.innerWidth - (projectSidebarVisible ? projectSidebarWidth : 0) - 480,
  );
  const visibleChatSidebarWidth = Math.min(editor.chatSidebarWidth, chatSidebarMax);
  const projectSidebarMax = Math.max(
    220,
    window.innerWidth - (editor.chatSidebarVisible ? visibleChatSidebarWidth : 0) - 360,
  );
  const visibleProjectSidebarWidth = Math.min(projectSidebarWidth, projectSidebarMax);
  const workspaceStyle: CSSProperties &
    Record<"--ide-chat-sidebar-width" | "--ide-project-sidebar-width", string> = {
    "--ide-chat-sidebar-width": `${visibleChatSidebarWidth}px`,
    "--ide-project-sidebar-width": `${visibleProjectSidebarWidth}px`,
  };
  const draftAnchor = reviews.draftAnchor;
  const activeThread = reviews.activeThreadId
    ? reviews.threads.find(
        (thread) => thread.id === reviews.activeThreadId && thread.anchor.view !== "message",
      )
    : undefined;
  const contextualAnchor = draftAnchor ?? activeThread?.anchor;
  const contextualChat = draftAnchor
    ? reviews.draftChatStore
    : activeThread
      ? reviews.chatStore(activeThread.id)
      : undefined;
  const chat = contextualChat ?? projectChat;
  const closeContext = () => {
    if (draftAnchor) reviews.cancelDraft();
    reviews.clearActiveThread();
  };

  return (
    <main
      className={cn(
        "relative flex h-screen min-h-0 w-screen overflow-hidden bg-background text-foreground",
        resizing && "cursor-col-resize select-none",
      )}
      style={workspaceStyle}
    >
      {projectSidebarVisible ? (
        <>
          <div className="w-[var(--ide-project-sidebar-width)] min-w-0 shrink-0">
            {projectSidebar}
          </div>
          <ResizeHandle
            className="left-[calc(var(--ide-project-sidebar-width)-5px)]"
            label="Resize project sidebar"
            value={visibleProjectSidebarWidth}
            min={220}
            max={projectSidebarMax}
            edge="left"
            onChange={onProjectSidebarWidthChange}
            onResizeStart={() => setResizing(true)}
            onResizeEnd={() => setResizing(false)}
          />
        </>
      ) : null}
      <section className="min-w-0 flex-1" aria-label="VS Code workspace">
        <EmbeddedEditorPane store={editor} />
      </section>
      {editor.chatSidebarVisible ? (
        <>
          <ResizeHandle
            className="right-[calc(var(--ide-chat-sidebar-width)-5px)]"
            label="Resize current session sidebar"
            value={visibleChatSidebarWidth}
            min={320}
            max={chatSidebarMax}
            edge="right"
            onChange={(width) => editor.setChatSidebarWidth(width)}
            onResizeStart={() => setResizing(true)}
            onResizeEnd={() => setResizing(false)}
          />
          <aside className="flex w-[var(--ide-chat-sidebar-width)] min-w-0 flex-col border-l border-border bg-background shadow-[-12px_0_32px_color-mix(in_oklab,var(--foreground)_8%,transparent)]">
            <header
              className={cn(
                "flex select-none items-center justify-between gap-3 border-b border-border px-3 [-webkit-app-region:drag]",
                contextualAnchor ? "h-14" : "h-[35px]",
              )}
            >
              <div className="min-w-0">
                <strong className="block truncate text-xs">
                  {contextualAnchor ? "Chat about selection" : sessionTitle}
                </strong>
                {contextualAnchor ? (
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {anchorTitle(contextualAnchor)}
                  </span>
                ) : null}
              </div>
              {contextualAnchor ? (
                <Button
                  className="[-webkit-app-region:no-drag]"
                  variant="ghost"
                  size="sm"
                  onClick={closeContext}
                >
                  Project chat
                </Button>
              ) : null}
            </header>
            <div className="min-h-0 flex-1">
              <Chat
                className="h-full"
                store={chat}
                transcriptBehavior={transcriptBehavior}
                composerHeader={contextualChat ? undefined : projectComposerHeader}
              />
            </div>
          </aside>
        </>
      ) : null}
    </main>
  );
});
