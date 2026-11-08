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
import { StartupTimingProbe } from "./components/startup-timing-probe";
import { rendererStartupTiming } from "./lib/startup-timing";
import { startCakeChatOverlay } from "./bootstrap/start-cake-chat-overlay";
import { CAKE_CHAT_OVERLAY_QUERY } from "../contracts/desktop/cake-chat-overlay-data";
import { ScreenCaptureOverlay } from "./components/screen-capture-overlay";
import { ScreenCaptureOverlayStore } from "./stores/ScreenCaptureOverlayStore";
import { microphone } from "./dictation/microphone";
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

rendererStartupTiming("renderer-entry");
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
  const client = makeClient(runtime);
  const store = mount(
    createStore(ScreenCaptureOverlayStore, {
      client: client.electron,
      speech: {
        client: client.dictation,
        postProcess: client.workspaces.postProcessDictation,
        microphone,
      },
      renderImage: renderCaptureImage,
      copy: (image, annotationText) => client.electron.copyScreenCapture({ image, annotationText }),
    }),
  );
  const stopDictation = observeDictation(runtime, store.dictationStore);
  root.render(createElement(ScreenCaptureOverlay, { store }));
  void store.initialize();
  window.addEventListener(
    "pagehide",
    () => {
      stopDictation();
      store[Symbol.dispose]();
      void runtime.dispose();
    },
    { once: true },
  );
} else
  void bootstrap(
    window.cake,
    new URLSearchParams(window.location.search).get(CAKE_CHAT_OVERLAY_QUERY) === "1",
  ).catch((error: unknown) => {
    console.error("[cake] Startup failed", error);
    root.render(createElement(StartupError, { error }));
  });

async function bootstrap(bridge: NonNullable<typeof window.cake>, overlay: boolean) {
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
          await mountDesktop(runtime, client, connection, overlay);
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
    await mountDesktop(runtime, client, connection, overlay);
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

/**
 * Mounts a desktop window. The drop-down Cake Chat overlay mounts the same Root Store against the
 * same backend, so it shows the live shared conversation; it reads the main window's snapshot for
 * preferences such as theme but never writes window state, migrates drafts, or registers shortcuts.
 */
async function mountDesktop(
  runtime: Runtime,
  client: Client,
  connection: DesktopConnectionStore,
  overlay: boolean,
) {
  const projection = RootProjection.create();
  let hydrationError: unknown;
  let savedDraftsReady = false;
  rendererStartupTiming("window-state-load-start");
  const loadedWindow = await client.windowState.load().catch((error: unknown) => {
    hydrationError = error;
    return { state: {}, children: {} };
  });
  rendererStartupTiming("window-state-load-end");
  let windowSnapshot = loadedWindow;
  if (!overlay)
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
  rendererStartupTiming("window-state-hydrated");
  rendererStartupTiming("renderer-observers-start");
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
  rendererStartupTiming("renderer-observers-end");
  rendererStartupTiming("window-persistence-start");
  const persistence = overlay
    ? undefined
    : new WindowStatePersistence(
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
  persistence?.observe(rootStore);
  rendererStartupTiming("window-persistence-end");
  rendererStartupTiming("capture-overlays-setup-start");
  if (!overlay) {
    void rootStore.screenCaptureStore.configure();
    void rootStore.settingsStore.cakeChatOverlay.configure();
  }
  rendererStartupTiming("capture-overlays-setup-end");
  rendererStartupTiming("model-observers-start");
  const stopObservingModels = observeModels(runtime, projection, rootStore);
  const stopObservingEvents = observeEvents(runtime, projection, rootStore);
  rendererStartupTiming("model-observers-end");
  rendererStartupTiming("saved-drafts-observe-start");
  const stopObservingSavedDrafts = observeSavedDrafts(
    runtime,
    (records) => {
      rootStore.sessionRegistry.pendingSessions.applySavedDraftSnapshot(records);
      rendererStartupTiming("saved-drafts-initial-received");
    },
    (error) =>
      rootStore.toastStore.show({
        tone: "warning",
        title: "Saved Draft updates disconnected",
        message: error instanceof Error ? error.message : String(error),
      }),
  );
  rendererStartupTiming("model-provider-hydration-start");
  void Promise.allSettled([
    rootStore.modelCatalogStore.ensureLoaded(),
    rootStore.settingsStore.providers.hydrate(),
  ]).then(() => {
    if (!rootStore.signal.aborted) rendererStartupTiming("model-provider-hydration-settled");
  });
  rendererStartupTiming("model-provider-hydration-scheduled");
  // Saved Draft observation is current-first and already reconciles interrupted claims.
  // A second startup list duplicated that work and unnecessarily gated app controls.
  // Navigation and persisted composer drafts were hydrated before mounting the Store.
  rendererStartupTiming("app-controls-start");
  void (overlay ? startCakeChatOverlay(rootStore) : rootStore.initialize())
    .then(() => rendererStartupTiming("app-controls-end"))
    .catch((error: unknown) => {
      rendererStartupTiming("app-controls-failed");
      rootStore.toastStore.show({
        tone: "error",
        title: "Could not start app controls",
        message: error instanceof Error ? error.message : String(error),
      });
    });
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
  rendererStartupTiming("render-scheduled");
  root.render(
    createElement(StartupTimingProbe, {
      rootStore,
      children: createElement(RendererRoot, {
        rootStore,
        variant: overlay ? "cake-chat-overlay" : "app",
        openExternalUrl: (url) => {
          void rootStore.openExternalUrl(url).catch(reportLinkError);
        },
        openSubagent: (parentSessionId, handleId, messageId) => {
          void rootStore.navigationStore
            .openSubagentLink(parentSessionId, handleId, messageId)
            .catch(reportLinkError);
        },
        openSession: (sessionId, messageId, attachmentId) => {
          void rootStore.navigationStore
            .openSessionLink(sessionId, messageId, attachmentId)
            .catch(reportLinkError);
        },
      }),
    }),
  );
  // The window is already visible; the model loads in main's speech process, off this thread.
  if (!overlay) rootStore.dictationStore.preloadOnLaunch();
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
