import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import { App } from "./app";
import { RendererErrorBoundary } from "./components/renderer-error-boundary";
import { createDesktopClient } from "./desktop-client";
import { mountRootStore } from "./stores/RootStore";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

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
  const mainChatStore = rootStore.mainChatStore;
  root.render(
    <RendererErrorBoundary>
      <StrictMode>
        <StoreProvider store={rootStore}>
          <StoreProvider store={mainChatStore}>
            <App />
          </StoreProvider>
        </StoreProvider>
      </StrictMode>
    </RendererErrorBoundary>
  );
  window.addEventListener("pagehide", () => rootStore[Symbol.dispose](), { once: true });
}
