import { StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import Scene from "virtual:cake-scene";
import "virtual:cake-plugins";
import { RendererErrorBoundary } from "./components/renderer-error-boundary";
import { CustomizationRecovery } from "./components/customization-recovery";
import { LoadingState } from "./components/ui/loading-state";
import { MarkdownLinkProvider } from "./components/ai-elements/markdown";
import { createDesktopClient } from "./desktop-client";
import { makeRendererRuntime } from "./RendererRuntime";
import { makeRendererClient } from "./client/RendererClientLive";
import { RendererModelSynchronizer } from "./RendererModelSynchronizer";
import { installStaleAssetRecovery } from "./stale-asset-recovery";
import { mountRootStore } from "./mount-root-store";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const disposeStaleAssetRecovery = installStaleAssetRecovery();
const customizationRevision =
  typeof __CAKE_CUSTOMIZATION_REVISION__ === "undefined"
    ? undefined
    : __CAKE_CUSTOMIZATION_REVISION__;

function CustomizationHealth() {
  useEffect(() => {
    if (customizationRevision)
      void window.cake?.request({
        type: "customization-rendered",
        revision: customizationRevision,
      });
  }, []);
  return null;
}

if (!window.cake) {
  root.render(
    <main>
      <section>
        <h1>Cake</h1>
        <output>
          Cake's desktop bridge did not load. Restart the app and inspect the preload diagnostics.
        </output>
      </section>
    </main>,
  );
} else {
  const rendererRuntime = makeRendererRuntime(window.cake.rpc);
  const rendererClient = makeRendererClient(rendererRuntime);
  const synchronizer = new RendererModelSynchronizer(rendererRuntime);
  const desktopClient = createDesktopClient(window.cake);
  const rootStore = mountRootStore(desktopClient, rendererClient, synchronizer);
  const reportLinkError = (error: unknown) =>
    rootStore.toastStore.show({
      tone: "error",
      title: "Could not open link",
      message: error instanceof Error ? error.message : String(error),
    });
  const markdownLinkActions = {
    openExternalUrl: (url: string) => {
      void rootStore.openExternalUrl(url).catch(reportLinkError);
    },
    openSession: (sessionId: string) => {
      void rootStore.openSessionLink(sessionId).catch(reportLinkError);
    },
  };
  root.render(
    <RendererErrorBoundary>
      <StrictMode>
        <StoreProvider store={rootStore}>
          <MarkdownLinkProvider actions={markdownLinkActions}>
            <Suspense
              fallback={
                <main className="grid h-screen place-items-center bg-background text-foreground">
                  <span className="grid size-12 place-items-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground shadow-lg">
                    C
                  </span>
                  <LoadingState label="Hydrating customization" />
                </main>
              }
            >
              <Scene />
              <CustomizationHealth />
            </Suspense>
            <CustomizationRecovery />
          </MarkdownLinkProvider>
        </StoreProvider>
      </StrictMode>
    </RendererErrorBoundary>,
  );
  window.addEventListener(
    "pagehide",
    () => {
      disposeStaleAssetRecovery();
      rootStore[Symbol.dispose]();
      synchronizer[Symbol.dispose]();
      void rendererRuntime.dispose();
    },
    { once: true },
  );
}
