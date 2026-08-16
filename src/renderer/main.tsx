import { StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import Scene from "virtual:cake-scene";
import "virtual:cake-plugins";
import { RendererErrorBoundary } from "./components/renderer-error-boundary";
import { CustomizationRecovery } from "./components/customization-recovery";
import { createDesktopClient } from "./desktop-client";
import { mountRootStore } from "./stores/RootStore";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "./styles.css";
import "./customization-recovery.css";

const root = createRoot(document.getElementById("root")!);
const customizationRevision = typeof __CAKE_CUSTOMIZATION_REVISION__ === "undefined" ? undefined : __CAKE_CUSTOMIZATION_REVISION__;

function CustomizationHealth() {
  useEffect(() => {
    if (customizationRevision) void window.cake?.request({ type: "customization-rendered", revision: customizationRevision });
  }, []);
  return null;
}

if (!window.cake) {
  root.render(
    <main>
      <section>
        <h1>Cake</h1>
        <output>Cake's desktop bridge did not load. Restart the app and inspect the preload diagnostics.</output>
      </section>
    </main>
  );
} else {
  const rootStore = mountRootStore(createDesktopClient(window.cake));
  root.render(
    <RendererErrorBoundary>
      <StrictMode>
        <StoreProvider store={rootStore}>
          <Suspense fallback={<main className="loading-screen"><span className="cake-mark">C</span><p>Hydrating customization…</p></main>}>
            <Scene />
            <CustomizationHealth />
          </Suspense>
          <CustomizationRecovery />
        </StoreProvider>
      </StrictMode>
    </RendererErrorBoundary>
  );
  window.addEventListener("pagehide", () => rootStore[Symbol.dispose](), { once: true });
}
