import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import { App } from "./app";
import { createDesktopClient } from "./desktop-client";
import { mountWindowStore } from "./stores/window-store";
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
  const windowStore = mountWindowStore(createDesktopClient(window.cake));
  root.render(
    <StrictMode>
      <StoreProvider store={windowStore}>
        <App />
      </StoreProvider>
    </StrictMode>
  );
  window.addEventListener("pagehide", () => windowStore[Symbol.dispose](), { once: true });
}
