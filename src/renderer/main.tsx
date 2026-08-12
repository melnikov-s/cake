import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import { App } from "./app";
import { createDesktopClient } from "./desktop-client";
import { mountRootStore } from "./stores/root-store";
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
  const windowStore = rootStore.windowStore;
  root.render(
    <StrictMode>
      <StoreProvider store={rootStore}>
        <StoreProvider store={windowStore}>
          <App />
        </StoreProvider>
      </StoreProvider>
    </StrictMode>
  );
  window.addEventListener("pagehide", () => rootStore[Symbol.dispose](), { once: true });
}
