import { StrictMode } from "react";
import { observer, StoreProvider } from "r-state-tree/react";
import type { RootStore } from "../stores/RootStore";
import { App } from "./app";
import { MarkdownLinkProvider } from "./ai-elements/markdown";
import { RendererErrorBoundary } from "./renderer-error-boundary";
import { ArtifactReferencePreview } from "./artifact-reference-preview";
import { formatArtifactRef, parseArtifactRef } from "../../domain/artifacts/artifact-lineage";

interface RendererRootProps {
  rootStore: RootStore;
  openExternalUrl(url: string): void;
  openSession(sessionId: string): void;
}

export const RendererRoot = observer(function RendererRoot({
  rootStore,
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
              <App />
            </MarkdownLinkProvider>
          </StoreProvider>
        </StoreProvider>
      </StrictMode>
    </RendererErrorBoundary>
  );
});
