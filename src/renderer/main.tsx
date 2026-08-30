import { StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider as LegacyStoreProvider } from "r-state-tree/react";
import { mount } from "effect-state-tree";
import { StoreProvider } from "effect-state-tree/react";
import Scene from "virtual:cake-scene";
import "virtual:cake-plugins";
import { RendererErrorBoundary } from "./components/renderer-error-boundary";
import { CustomizationRecovery } from "./components/customization-recovery";
import { LoadingState } from "./components/ui/loading-state";
import { MarkdownLinkProvider } from "./components/ai-elements/markdown";
import type { CakeDesktopBridge } from "../ipc/desktop-ipc";
import { makeCakeIpcPromiseClient } from "../ipc/client/CakeIpcClient";
import { createDesktopClient } from "./desktop-client";
import { installStaleAssetRecovery } from "./stale-asset-recovery";
import { mountRootStore } from "./mount-root-store";
import { makeRendererRuntime } from "./RendererLive";
import {
  ModelPresetSettingsStore,
  ModelPresetSettingsStoreFactory,
} from "./stores/ModelPresetSettingsStore";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Cake renderer root element is unavailable");
const root = createRoot(rootElement);
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
  const startRenderer = async (bridge: CakeDesktopBridge) => {
    const rendererRuntime = makeRendererRuntime(bridge.rpc);
    const modelPresets = await rendererRuntime
      .runPromise(
        mount(ModelPresetSettingsStoreFactory, {
          catalog: [],
          loading: true,
          saving: false,
          sectionRequestRevision: 0,
          revision: 0,
        }),
      )
      .catch(async (error: unknown) => {
        await rendererRuntime.dispose();
        throw error;
      });
    await rendererRuntime.runPromise(modelPresets.instance.awaitHydrated());
    const cakeIpc = makeCakeIpcPromiseClient(rendererRuntime);
    let rootStore: ReturnType<typeof mountRootStore>;
    try {
      rootStore = mountRootStore(createDesktopClient(bridge, cakeIpc), modelPresets.instance);
    } catch (error) {
      await rendererRuntime.runPromise(modelPresets.dispose);
      await rendererRuntime.dispose();
      throw error;
    }
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
          <StoreProvider stores={[[ModelPresetSettingsStore, modelPresets.instance]]}>
            <LegacyStoreProvider store={rootStore}>
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
            </LegacyStoreProvider>
          </StoreProvider>
        </StrictMode>
      </RendererErrorBoundary>,
    );
    window.addEventListener(
      "pagehide",
      () => {
        disposeStaleAssetRecovery();
        rootStore[Symbol.dispose]();
        void rendererRuntime
          .runPromise(modelPresets.dispose)
          .finally(() => rendererRuntime.dispose());
      },
      { once: true },
    );
  };

  void startRenderer(window.cake).catch((error: unknown) => {
    disposeStaleAssetRecovery();
    root.render(
      <main className="grid h-screen place-items-center bg-background p-6 text-foreground">
        <output>
          Cake could not initialize renderer state:{" "}
          {error instanceof Error ? error.message : String(error)}
        </output>
      </main>,
    );
  });
}
