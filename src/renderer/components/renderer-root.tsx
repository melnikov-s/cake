import { DesktopConnectionStatus } from "./desktop-connection-status";
import { BrowserConnectionStatus } from "./browser-connection-status";
import type { BrowserConnectionStore } from "../stores/BrowserConnectionStore";
import { StrictMode } from "react";
import { observer, StoreProvider } from "r-state-tree/react";
import type { RootStore } from "../stores/RootStore";
import { App } from "./app";
import { IconButtonHotkeyProvider } from "./ui/icon-button";
import { MarkdownLinkProvider } from "./ai-elements/markdown";
import { RendererErrorBoundary } from "./renderer-error-boundary";
import { ArtifactReferencePreview } from "./artifact-reference-preview";
import { formatArtifactRef, parseArtifactRef } from "../../domain/artifacts/artifact-lineage";

interface RendererRootProps {
  rootStore: RootStore;
  browserConnection?: BrowserConnectionStore;
  openExternalUrl(url: string): void;
  openSession(sessionId: string): void;
}

export const RendererRoot = observer(function RendererRoot({
  rootStore,
  browserConnection,
  openExternalUrl,
  openSession,
}: RendererRootProps) {
  const activeSessionId =
    rootStore.appShellStore.activeConversation?.kind === "project-session"
      ? rootStore.appShellStore.activeConversation.sessionId
      : undefined;
  const activeWorkingDirectory = activeSessionId
    ? rootStore.sessionCatalogStore.find(activeSessionId)?.workingDirectory
    : undefined;
  return (
    <RendererErrorBoundary>
      <StrictMode>
        <StoreProvider store={rootStore}>
          <StoreProvider store={rootStore.dictationStore}>
            <StoreProvider store={rootStore.fullscreenSurfaceStore}>
              <MarkdownLinkProvider
                actions={{
                  openExternalUrl,
                  openSession,
                  loadWorkspaceImage: (path, signal) => {
                    if (!activeWorkingDirectory)
                      return Promise.reject(new Error("No active project Working Directory"));
                    return rootStore.client.filesystem.readImage(activeWorkingDirectory, path, {
                      signal,
                    });
                  },
                  renderArtifactReference: (reference) => (
                    <ArtifactReferencePreview
                      reference={formatArtifactRef(parseArtifactRef(reference))}
                      store={rootStore.artifactReferencePreviewStore}
                      sessions={rootStore.sessionCatalogStore}
                      activeSessionId={activeSessionId}
                      onOpen={(lineageId) =>
                        rootStore.showArtifactLibrary(activeSessionId, lineageId)
                      }
                    />
                  ),
                }}
              >
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
                    <div className="min-h-0 flex-1">
                      <App browserMode={Boolean(browserConnection)} />
                    </div>
                  </div>
                </IconButtonHotkeyProvider>
              </MarkdownLinkProvider>
            </StoreProvider>
          </StoreProvider>
        </StoreProvider>
      </StrictMode>
    </RendererErrorBoundary>
  );
});
