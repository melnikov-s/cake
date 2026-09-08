import { StrictMode } from "react";
import { StoreProvider } from "r-state-tree/react";
import type { RootStore } from "../stores/RootStore";
import { App } from "./app";
import { MarkdownLinkProvider } from "./ai-elements/markdown";
import { RendererErrorBoundary } from "./renderer-error-boundary";

interface RendererRootProps {
  rootStore: RootStore;
  openExternalUrl(url: string): void;
  openSession(sessionId: string): void;
}

export function RendererRoot({ rootStore, openExternalUrl, openSession }: RendererRootProps) {
  return (
    <RendererErrorBoundary>
      <StrictMode>
        <StoreProvider store={rootStore}>
          <StoreProvider store={rootStore.fullscreenSurfaceStore}>
            <MarkdownLinkProvider actions={{ openExternalUrl, openSession }}>
              <App />
            </MarkdownLinkProvider>
          </StoreProvider>
        </StoreProvider>
      </StrictMode>
    </RendererErrorBoundary>
  );
}
