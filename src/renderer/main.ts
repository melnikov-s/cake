import { Schema } from "effect";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DesktopBridgeError } from "./components/desktop-bridge-error";
import { RendererRoot } from "./components/renderer-root";
import { makeRendererRuntime } from "./RendererRuntime";
import { makeClient } from "./client/ClientLive";
import {
  observeAgentAvailability,
  observeApplicationState,
  observeModels,
  observeNativeEvents,
  observeVsCodeState,
} from "./observers";
import { RootProjection } from "./models/RootProjection";
import { installStaleAssetRecovery } from "./stale-asset-recovery";
import { mountRootStore } from "./mount-root-store";
import { storeSnapshotSchema } from "./persistence/StoreSnapshot";
import { WindowStatePersistence } from "./persistence/WindowStatePersistence";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const disposeStaleAssetRecovery = installStaleAssetRecovery();
interface PersistenceRef {
  current?: WindowStatePersistence;
}

if (!window.cake) root.render(createElement(DesktopBridgeError));
else void bootstrap(window.cake);

async function bootstrap(bridge: NonNullable<typeof window.cake>) {
  const rendererRuntime = makeRendererRuntime(bridge.rpc);
  const client = makeClient(rendererRuntime);
  const projection = RootProjection.create();
  let hydrationError: unknown;
  const snapshot = await client.windowState
    .load()
    .then(Schema.decodeUnknownSync(storeSnapshotSchema))
    .catch((error) => {
      hydrationError = error;
      return { state: {}, children: {} };
    });
  const persistenceRef: PersistenceRef = {};
  const rootStore = mountRootStore(
    client,
    snapshot,
    () => persistenceRef.current?.flush() ?? Promise.resolve(),
    projection,
  );
  const stopObservingApplicationState = observeApplicationState(rendererRuntime, rootStore);
  const stopObservingAgentAvailability = observeAgentAvailability(rendererRuntime, rootStore);
  const stopObservingVsCodeState = observeVsCodeState(rendererRuntime, rootStore);
  const persistence = new WindowStatePersistence(client, (error) =>
    rootStore.toastStore.show({
      tone: "error",
      title: "Window state could not be saved",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  persistenceRef.current = persistence;
  persistence.observe(rootStore);
  const stopObservingModels = observeModels(rendererRuntime, projection, rootStore);
  const stopObservingNativeEvents = observeNativeEvents(rendererRuntime, projection, rootStore);
  void rootStore.settingsStore.modelPresets.hydrate();
  void rootStore.initialize();
  if (hydrationError)
    rootStore.toastStore.show({
      tone: "warning",
      title: "Window state could not be restored",
      message: hydrationError instanceof Error ? hydrationError.message : String(hydrationError),
    });
  const reportLinkError = (error: unknown) =>
    rootStore.toastStore.show({
      tone: "error",
      title: "Could not open link",
      message: error instanceof Error ? error.message : String(error),
    });
  root.render(
    createElement(RendererRoot, {
      rootStore,
      openExternalUrl: (url) => {
        void rootStore.openExternalUrl(url).catch(reportLinkError);
      },
      openSession: (sessionId) => {
        void rootStore.openSessionLink(sessionId).catch(reportLinkError);
      },
    }),
  );
  window.addEventListener(
    "pagehide",
    () => {
      disposeStaleAssetRecovery();
      persistence?.[Symbol.dispose]();
      stopObservingNativeEvents();
      stopObservingVsCodeState();
      stopObservingAgentAvailability();
      stopObservingApplicationState();
      stopObservingModels();
      rootStore[Symbol.dispose]();
      projection[Symbol.dispose]();
      void rendererRuntime.dispose();
    },
    { once: true },
  );
}
