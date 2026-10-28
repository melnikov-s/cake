import { DesktopConnectionStatus } from "./desktop-connection-status";
import { BrowserConnectionStatus } from "./browser-connection-status";
import type { BrowserConnectionStore } from "../stores/BrowserConnectionStore";
import { StrictMode } from "react";
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
  const activeSessionId = rootStore.appShellStore.activeConversation?.sessionId;
  const sessionIds = rootStore.sessionCatalogStore.authoritativeSessionIds;
  return (
    <RendererErrorBoundary>
      <StrictMode>
        <StoreProvider store={rootStore}>
          <StoreProvider store={rootStore.dictationStore}>
            <StoreProvider store={rootStore.fullscreenSurfaceStore}>
              <MarkdownLinkProvider
                actions={{
                  openExternalUrl,
                  openArtifact: (reference) => {
                    const { lineageId, revision } = parseArtifactRef(reference);
                    rootStore.navigationStore.showArtifactLibrary(
                      activeSessionId,
                      lineageId,
                      revision,
                    );
                  },
                  openSession,
                  openSubagent,
                  sessionIds: () => sessionIds,
                  sessionTitle: (sessionId) =>
                    rootStore.sessionCatalogStore.find(sessionId)?.title ??
                    rootStore.cakeChatCollectionStore.summaries.find(
                      (session) => session.sessionId === sessionId,
                    )?.title,
                  renderArtifactReference: (reference, label) => (
                    <ArtifactReferencePreview
                      reference={formatArtifactRef(parseArtifactRef(reference))}
                      store={rootStore.artifactReferencePreviewStore}
                      children={label}
                      onOpen={(lineageId, revision) =>
                        rootStore.navigationStore.showArtifactLibrary(
                          activeSessionId,
                          lineageId,
                          revision,
                        )
                      }
                    />
                  ),
                }}
              >
                <ConversationMarkdownResourceContext
                  value={{
                    filesystem: rootStore.client.filesystem,
                    inlineArtifacts: rootStore.inlineArtifactPreviewStore,
                    inlineWidgets: rootStore.inlineWidgetStore,
                  }}
                >
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
