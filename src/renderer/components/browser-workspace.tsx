import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import type { ChatTranscriptBehavior } from "./chat-message";
import type { BrowserStore } from "../stores/BrowserStore";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { Chat } from "./chat";
import { SideChatLayout } from "./side-chat-layout";
import { WorkspaceChatLayout } from "./workspace-chat-layout";
import { IconButton } from "./ui/icon-button";
import { Input } from "./ui/input";
import { BackIcon, ForwardIcon, InspectIcon, ReloadIcon, StopIcon } from "./ui/icons";

/** Browser Mode workspace with native Chromium viewport and the authoritative project chat. */
export const BrowserWorkspace = observer(function BrowserWorkspace({
  browser,
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
}: {
  browser: BrowserStore;
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
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      browser.setMeasuredBounds({
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
      browser.setMeasuredBounds(undefined);
    };
  }, [browser]);

  const conversation = (
    <SideChatLayout
      store={sideChat}
      renderChat={(store) => <Chat store={store} embedded compact />}
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

  const workspace = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 border-b border-border px-2 [-webkit-app-region:drag]",
          !projectSidebarVisible && "pl-[84px]",
        )}
      >
        <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          <IconButton
            tooltip="Back"
            disabled={!browser.canGoBack}
            onClick={() => void browser.action("back")}
          >
            <BackIcon />
          </IconButton>
          <IconButton
            tooltip="Forward"
            disabled={!browser.canGoForward}
            onClick={() => void browser.action("forward")}
          >
            <ForwardIcon />
          </IconButton>
          <IconButton
            tooltip={browser.loading ? "Stop loading" : "Reload"}
            onClick={() => void browser.action(browser.loading ? "stop" : "reload")}
          >
            {browser.loading ? <StopIcon /> : <ReloadIcon />}
          </IconButton>
        </div>
        <Input
          className="h-7 flex-1 [-webkit-app-region:no-drag]"
          aria-label="Browser address"
          value={browser.address}
          onFocus={() => browser.beginAddressEditing()}
          onBlur={() => browser.endAddressEditing()}
          onChange={(event) => browser.setAddress(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void browser.navigate(event.currentTarget.value);
          }}
        />
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <IconButton
            tooltip="Select an element"
            aria-pressed={browser.inspecting}
            onClick={() => void browser.inspect()}
          >
            <InspectIcon />
          </IconButton>
        </div>
      </div>
      {browser.error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 font-mono text-xs text-destructive">
          {browser.error}
        </div>
      ) : null}
      <div ref={viewportRef} className="min-h-0 flex-1" aria-label="Browser viewport" />
    </div>
  );

  return (
    <WorkspaceChatLayout
      workspace={workspace}
      workspaceLabel="Browser workspace"
      chatSidebarVisible={browser.chatSidebarVisible}
      chatSidebarWidth={browser.chatSidebarWidth}
      onChatSidebarWidthChange={(width) => browser.setChatSidebarWidth(width)}
      projectSidebar={projectSidebar}
      projectSidebarVisible={projectSidebarVisible}
      projectSidebarWidth={projectSidebarWidth}
      onProjectSidebarWidthChange={onProjectSidebarWidthChange}
      terminalDock={terminalDock}
      chatSidebar={
        <>
          <header className="flex h-[35px] select-none items-center justify-between gap-3 border-b border-border px-3 [-webkit-app-region:drag]">
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
