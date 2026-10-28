import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import type { ArtifactRecord } from "../../contracts/artifacts/artifact-contract";
import { RootStore } from "../stores/RootStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { cakeChatTranscriptBehaviorFor } from "../lib/cake-chat-transcript-behavior";
import { InlineArtifactContext } from "./inline-artifact-context";
import { ArtifactTranscriptContext } from "./artifact-transcript-context";
import { ArtifactPresentationChatContext } from "./artifact-presentation-chat-context";
import { FullscreenSurface } from "./fullscreen-surface";
import { WorkspacePanelToggle } from "./ui/workspace-panel-toggle";
import { Chat } from "./chat";
import { SideChatLayout } from "./side-chat-layout";
import { NestedChat } from "./nested-chat";
import { ProjectComposerHeader } from "./project-composer-header";
import { BlockingInterviews } from "./blocking-interviews";

/** Fullscreen artifact with the owning conversation's existing ChatStore, not a new discussion. */
export const ArtifactPresentationSurface = observer(function ArtifactPresentationSurface({
  record,
  sessionId,
  children,
  onClose,
}: {
  record: ArtifactRecord;
  sessionId?: string;
  children: ReactNode;
  onClose(): void;
}) {
  const root = useStore(RootStore);
  const inline = useContext(InlineArtifactContext);
  const transcript = useContext(ArtifactTranscriptContext);
  useLayoutEffect(() => transcript?.retain(), [transcript]);
  // ChatStore IDs can be display-only (for example private workers). Only a
  // canonical conversation identity can scope artifact access and input context.
  const ownerId = inline
    ? inline.behavior?.messageReferenceSessionId
    : (sessionId ?? record.artifact.sessionId);
  const store = root.artifactPresentationStore;
  const surfaceId = useRef(crypto.randomUUID()).current;
  const artifact = record.artifact;
  const project = ownerId ? root.sessionRegistry.findSession(ownerId) : undefined;
  const cakeChat = ownerId ? root.cakeChatCollectionStore.registry.find(ownerId) : undefined;
  const session = project ?? cakeChat;
  const behavior =
    (ownerId ? inline?.behavior : undefined) ??
    (project
      ? projectTranscriptBehaviorFor(root, project)
      : cakeChat
        ? cakeChatTranscriptBehaviorFor(root, cakeChat)
        : undefined);
  const chat =
    (ownerId ? inline?.behavior?.store : undefined) ?? session?.conversationSessionStore.chatStore;
  const conversationTitle =
    (ownerId ? root.sessionCatalogStore.find(ownerId)?.title : undefined) ??
    root.cakeChatCollectionStore.summaries.find((summary) => summary.sessionId === ownerId)
      ?.title ??
    "Conversation";
  const activeSessionId = root.appShellStore.activeConversation?.sessionId;
  const originSessionId = useRef(activeSessionId).current;

  useLayoutEffect(() => {
    if (ownerId)
      store.show(surfaceId, {
        sessionId: ownerId,
        artifactId: artifact.id,
        revision: artifact.revision,
      });
    else store.close(surfaceId);
  }, [store, surfaceId, ownerId, artifact.id, artifact.revision]);
  useLayoutEffect(() => () => store.close(surfaceId), [store, surfaceId]);
  useLayoutEffect(() => {
    if (activeSessionId !== originSessionId) onClose();
  }, [activeSessionId, originSessionId, onClose]);

  const conversation =
    chat && behavior ? (
      <Chat
        className="h-full"
        store={chat}
        transcriptBehavior={behavior}
        composerHeader={project ? <ProjectComposerHeader session={project} /> : undefined}
        composerContent={
          session ? (
            <BlockingInterviews
              interviews={session.conversationSessionStore.interviewStore.interviews}
              parts={session.model.uiParts}
              inlineWidgets={root.inlineWidgetStore}
            />
          ) : undefined
        }
      />
    ) : null;

  return (
    <FullscreenSurface
      mode={artifact.kind === "widget" || artifact.kind === "html" ? "canvas" : "reader"}
      eyebrow="Artifact"
      title={artifact.title ?? artifact.id}
      onClose={onClose}
      toolbar={
        chat && (
          <WorkspacePanelToggle
            panel="chat"
            visible={store.chatVisible}
            onToggle={() => store.toggleChat()}
          />
        )
      }
      chatSidebar={{
        chatSidebarVisible: Boolean(chat && store.chatVisible),
        chatSidebarWidth: store.chatWidth,
        onChatSidebarWidthChange: (width) => store.setChatWidth(width),
        chatSidebar: (
          <ArtifactPresentationChatContext value={artifact.id}>
            <header className="flex h-[35px] shrink-0 items-center border-b border-border px-3">
              <strong className="min-w-0 truncate text-xs">{conversationTitle}</strong>
            </header>
            <div className="min-h-0 flex-1">
              {session && behavior ? (
                <SideChatLayout
                  store={session.conversationSessionStore.sideChatStore}
                  hideTodos
                  renderChat={(nested) => <NestedChat store={nested} parentBehavior={behavior} />}
                >
                  {conversation}
                </SideChatLayout>
              ) : (
                conversation
              )}
            </div>
          </ArtifactPresentationChatContext>
        ),
      }}
    >
      {children}
    </FullscreenSurface>
  );
});
