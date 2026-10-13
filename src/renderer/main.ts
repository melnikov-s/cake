import { observeDictation } from "./observers/dictation";
import { observeSpeechOutput } from "./observers/speech-output";
import { Schema } from "effect";
import { createStore, mount, effect as reactiveEffect, untracked } from "r-state-tree";
import { cakeBuildId } from "../ipc/protocol/BackendConnectionRpc";
import { DesktopConnectionStore } from "./stores/DesktopConnectionStore";
import { DesktopConnectionScreen } from "./components/desktop-connection-screen";
import type { Client } from "./client/Client";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { StartupError } from "./components/startup-error";
import { RendererRoot } from "./components/renderer-root";
import { ScreenCaptureOverlay } from "./components/screen-capture-overlay";
import { ScreenCaptureOverlayStore } from "./stores/ScreenCaptureOverlayStore";
import { renderCaptureImage } from "./screen-capture/render-capture";
import { makeRuntime, makeRemoteRuntime, type Runtime } from "./runtime";
import { makeClient } from "./client/ClientLive";
import {
  observeAgentAvailability,
  observeApplicationState,
  observeModels,
  observeEvents,
  observeVsCodeState,
} from "./observers";
import { observeDesktopSharing } from "./observers/desktop-sharing";
import { observeSavedDrafts } from "./observers/saved-drafts";
import { RootProjection } from "./models/RootProjection";
import { installStaleAssetRecovery } from "./lib/stale-asset-recovery";
import { mountRootStore } from "./bootstrap/mount-root-store";
import { storeSnapshotSchema } from "./persistence/StoreSnapshot";
import { WindowStatePersistence } from "./persistence/WindowStatePersistence";
import { migrateSavedDrafts } from "./persistence/migrate-saved-drafts";
import "streamdown/styles.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const disposeStaleAssetRecovery = installStaleAssetRecovery();
interface PersistenceRef {
  current?: WindowStatePersistence;
}

if (!window.cake)
  root.render(
    createElement(StartupError, {
      error: new Error("Cake's desktop bridge did not load. Restart Cake to try again."),
    }),
  );
else if (new URLSearchParams(window.location.search).get("screenCapture") === "1") {
  const runtime = makeRuntime(window.cake.rpc);
  const store = mount(
    createStore(ScreenCaptureOverlayStore, {
      client: makeClient(runtime).electron,
      renderImage: renderCaptureImage,
    }),
  );
  root.render(createElement(ScreenCaptureOverlay, { store }));
  void store.initialize();
  window.addEventListener(
    "pagehide",
    () => {
      store[Symbol.dispose]();
      void runtime.dispose();
    },
    { once: true },
  );
} else
  void bootstrap(window.cake).catch((error: unknown) => {
    console.error("[cake] Startup failed", error);
    root.render(createElement(StartupError, { error }));
  });

async function bootstrap(bridge: NonNullable<typeof window.cake>) {
  const initialRuntime = makeRuntime(bridge.rpc);
  const host = await makeClient(initialRuntime).desktopHost.current();
  let runtime: Runtime = initialRuntime;
  let client: Client;
  let started = false;
  const connection = mount(
    createStore(DesktopConnectionStore, {
      host,
      client: () => client,
      connect: async () => {
        await client.backendConnection.connect(
          { buildId: cakeBuildId },
          { signal: AbortSignal.timeout(10_000) },
        );
        connection.connectionChanged(true);
        if (!started) {
          started = true;
          await mountDesktop(runtime, client, connection);
        }
      },
    }),
  );
  if (host.kind === "remote") {
    await initialRuntime.dispose();
    runtime = makeRemoteRuntime(bridge.rpc, host.url, (connected) => {
      connection.connectionChanged(false);
      if (connected && started)
        void client.backendConnection
          .connect({ buildId: cakeBuildId }, { signal: AbortSignal.timeout(10_000) })
          .then(() => connection.connectionChanged(true))
          .catch((error: unknown) => {
            connection.error = error instanceof Error ? error.message : String(error);
          });
    });
    client = makeClient(runtime, {
      kind: "remote",
      connected: () => connection.connected,
      blocked: () => Boolean(connection.uncertainOperation),
      uncertain: (operation) => connection.deliveryUncertain(operation),
    });
    root.render(createElement(DesktopConnectionScreen, { connection }));
    void connection.retry();
  } else {
    client = makeClient(runtime);
    await mountDesktop(runtime, client, connection);
  }
  window.addEventListener(
    "pagehide",
    () => {
      connection[Symbol.dispose]();
      void runtime.dispose();
    },
    { once: true },
  );
}

async function mountDesktop(runtime: Runtime, client: Client, connection: DesktopConnectionStore) {
  const projection = RootProjection.create();
  let hydrationError: unknown;
  let savedDraftsReady = false;
  const loadedWindow = await client.windowState.load().catch((error: unknown) => {
    hydrationError = error;
    return { state: {}, children: {} };
  });
  let windowSnapshot = loadedWindow;
  try {
    windowSnapshot = await migrateSavedDrafts(client, loadedWindow);
    savedDraftsReady = true;
  } catch (error) {
    // Remote disconnect/uncertain delivery cannot erase the still-local legacy record.
    hydrationError = error;
  }
  const snapshot = (() => {
    try {
      return Schema.decodeUnknownSync(storeSnapshotSchema)(windowSnapshot);
    } catch (error) {
      hydrationError = error;
      return { state: {}, children: {} };
    }
  })();
  const persistenceRef: PersistenceRef = {};
  const rootStore = mountRootStore(
    client,
    snapshot,
    () => persistenceRef.current?.flush() ?? Promise.resolve(),
    projection,
    connection,
  );
  const stopObservingConnection = reactiveEffect(() => {
    if (connection.remote && !connection.connected)
      untracked(() => {
        rootStore.terminalStore.disconnected();
        rootStore.projectWorkbenchStore.presentationStore.embeddedEditorStore.disconnected();
      });
  });
  const stopObservingSharing = connection.remote
    ? () => {}
    : observeDesktopSharing(runtime, rootStore.settingsStore.desktopSharing);
  const stopObservingApplicationState = observeApplicationState(runtime, rootStore);
  const stopObservingAgentAvailability = observeAgentAvailability(runtime, rootStore);
  const stopObservingVsCodeState = observeVsCodeState(runtime, rootStore);
  const stopObservingDictation = observeDictation(runtime, rootStore.dictationStore);
  const stopObservingSpeech = observeSpeechOutput(runtime, rootStore.speechSettingsStore);
  const stopVoiceOnBlur = () => {
    void rootStore.conversationModeStore.exit();
  };
  window.addEventListener("blur", stopVoiceOnBlur);
  const persistence = new WindowStatePersistence(
    client,
    (error) =>
      rootStore.toastStore.show({
        tone: "error",
        title: "Window state could not be saved",
        message: error instanceof Error ? error.message : String(error),
      }),
    savedDraftsReady,
  );
  persistenceRef.current = persistence;
  persistence.observe(rootStore);
  void rootStore.screenCaptureStore.configure();
  const stopObservingModels = observeModels(runtime, projection, rootStore);
  const stopObservingEvents = observeEvents(runtime, projection, rootStore);
  const stopObservingSavedDrafts = observeSavedDrafts(
    runtime,
    (records) => rootStore.sessionRegistry.pendingSessions.applySavedDraftSnapshot(records),
    (error) =>
      rootStore.toastStore.show({
        tone: "warning",
        title: "Saved Draft updates disconnected",
        message: error instanceof Error ? error.message : String(error),
      }),
  );
  void rootStore.settingsStore.modelPresets.hydrate();
  void rootStore.settingsStore.providers.hydrate();
  void rootStore.sessionRegistry.pendingSessions
    .refreshSavedDrafts()
    .catch((error: unknown) =>
      rootStore.toastStore.show({
        tone: "warning",
        title: "Saved Drafts could not be loaded",
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    .then(() => rootStore.initialize())
    .catch((error: unknown) =>
      rootStore.toastStore.show({
        tone: "error",
        title: "Could not restore navigation",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
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
        void rootStore.navigationStore.openSessionLink(sessionId).catch(reportLinkError);
      },
    }),
  );
  window.addEventListener(
    "pagehide",
    () => {
      disposeStaleAssetRecovery();
      persistence?.[Symbol.dispose]();
      stopObservingConnection();
      stopObservingSharing();
      stopObservingEvents();
      stopObservingDictation();
      stopObservingSpeech();
      window.removeEventListener("blur", stopVoiceOnBlur);
      stopObservingSavedDrafts();
      stopObservingVsCodeState();
      stopObservingAgentAvailability();
      stopObservingApplicationState();
      stopObservingModels();
      root.unmount();
      rootStore[Symbol.dispose]();
      projection[Symbol.dispose]();
    },
    { once: true },
  );
}
