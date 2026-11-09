import { DesktopConnectionStatus } from "./desktop-connection-status";
import { BrowserConnectionStatus } from "./browser-connection-status";
import type { BrowserConnectionStore } from "../stores/BrowserConnectionStore";
import { StrictMode, useMemo, type ComponentProps } from "react";
import { observer, StoreProvider } from "r-state-tree/react";
import type { RootStore } from "../stores/RootStore";
import { App } from "./app";
import { CakeChatOverlayApp } from "./cake-chat-overlay-app";
import { NewSessionDialog } from "./new-session-dialog";
import { IconButtonHotkeyProvider } from "./ui/icon-button";
import { MarkdownLinkProvider } from "./ai-elements/markdown";
import { RendererErrorBoundary } from "./renderer-error-boundary";
import { ArtifactReferencePreview } from "./artifact-reference-preview";
import { ArtifactMenuSurface } from "./artifact-menu-surface";
import { ConversationMarkdownResourceContext } from "./conversation-markdown-resource-context";
import { ConversationMarkdownProvider } from "./conversation-markdown-provider";
import { formatArtifactRef, parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";

interface RendererRootProps {
  rootStore: RootStore;
  /** The drop-down overlay renders only the shared Cake Chat surface. */
  variant?: "app" | "cake-chat-overlay";
  browserConnection?: BrowserConnectionStore;
  openExternalUrl(url: string): void;
  openSession(sessionId: string, messageId?: string, attachmentId?: string): void;
  openSubagent(parentSessionId: string, handleId: string, messageId?: string): void;
}

export const RendererRoot = observer(function RendererRoot({
  rootStore,
  variant = "app",
  browserConnection,
  openExternalUrl,
  openSession,
  openSubagent,
}: RendererRootProps) {
  // Window capabilities stay stable; navigation/catalog state is read when used,
  // not observed here and broadcast through every conversation's Markdown context.
  const actions = useMemo<ComponentProps<typeof MarkdownLinkProvider>["actions"]>(() => {
    const openArtifact = (lineageId: string, revision?: number) =>
      rootStore.navigationStore.openArtifact(
        rootStore.appShellStore.activeConversation?.sessionId,
        lineageId,
        revision,
      );
    return {
      openExternalUrl,
      openArtifact: (reference) => {
        const { lineageId, revision } = parseArtifactRef(reference);
        openArtifact(lineageId, revision);
      },
      openSession,
      openSubagent,
      sessionIds: () => [
        ...rootStore.sessionCatalogStore.authoritativeSessionIds,
        ...rootStore.props.projection.automations.unresolvedSessions.map((item) => item.sessionId),
        ...rootStore.automationSessionsStore.identities.map((item) => item.sessionId),
      ],
      // Passive summaries only: rendering a reference must never load a conversation.
      sessionTitle: (sessionId) =>
        rootStore.sessionCatalogStore.find(sessionId)?.title ??
        rootStore.cakeChatCollectionStore.summaries.find(
          (session) => session.sessionId === sessionId,
        )?.title ??
        rootStore.props.projection.automations.unresolvedSessions.find(
          (item) => item.sessionId === sessionId,
        )?.title ??
        (rootStore.automationSessionsStore.identities.some((item) => item.sessionId === sessionId)
          ? rootStore.automationSessionsStore.sessions.find(
              (session) => session.sessionId === sessionId,
            )?.displayTitle
          : undefined),
      renderArtifactReference: (reference, label) => (
        <ArtifactReferencePreview
          reference={formatArtifactRef(parseArtifactRef(reference))}
          store={rootStore.artifactReferencePreviewStore}
          children={label}
          onOpen={openArtifact}
        />
      ),
    };
  }, [rootStore, openExternalUrl, openSession, openSubagent]);
  const filesystem = rootStore.client.filesystem;
  const inlineArtifacts = rootStore.inlineArtifactPreviewStore;
  const inlineWidgets = rootStore.inlineWidgetStore;
  const resources = useMemo(
    () => ({ filesystem, inlineArtifacts, inlineWidgets }),
    [filesystem, inlineArtifacts, inlineWidgets],
  );
  return (
    <RendererErrorBoundary>
      <StrictMode>
        <StoreProvider store={rootStore}>
          <StoreProvider store={rootStore.dictationStore}>
            <StoreProvider store={rootStore.fullscreenSurfaceStore}>
              <MarkdownLinkProvider actions={actions}>
                <ConversationMarkdownResourceContext value={resources}>
                  <ConversationMarkdownProvider>
                    <IconButtonHotkeyProvider
                      bindingFor={(id) => rootStore.settingsStore.hotkeys.bindingFor(id)}
                    >
                      <div className="flex h-full min-h-0 flex-col">
                        {rootStore.desktopConnection && (
                          <DesktopConnectionStatus connection={rootStore.desktopConnection} />
                        )}
                        {browserConnection && (
                          <BrowserConnectionStatus connection={browserConnection} />
                        )}
                        {variant === "cake-chat-overlay" && <ArtifactMenuSurface />}
                        <div className="min-h-0 flex-1">
                          {variant === "cake-chat-overlay" ? (
                            <CakeChatOverlayApp />
                          ) : (
                            <>
                              <App browserMode={Boolean(browserConnection)} />
                              <NewSessionDialog store={rootStore.newSessionStore} />
                            </>
                          )}
                        </div>
                      </div>
                    </IconButtonHotkeyProvider>
                  </ConversationMarkdownProvider>
                </ConversationMarkdownResourceContext>
              </MarkdownLinkProvider>
            </StoreProvider>
          </StoreProvider>
        </StoreProvider>
      </StrictMode>
    </RendererErrorBoundary>
  );
});
