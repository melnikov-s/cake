import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { createStore, effect, mount, onSnapshot, toSnapshot } from "r-state-tree";
import { BrowserConnectionStore } from "./stores/BrowserConnectionStore";
import { Schema } from "effect";
import { makeNetworkRuntime } from "./runtime";
import { makeClient } from "./client/ClientLive";
import { BrowserFiles } from "./client/BrowserFiles";
import { BrowserMenuStore } from "./stores/BrowserMenuStore";
import { ContextActionMenu } from "./components/ui/context-action-menu";
import { RootProjection } from "./models/RootProjection";
import { RendererRoot } from "./components/renderer-root";
import { mountRootStore } from "./bootstrap/mount-root-store";
import { observeModels, observeAgentAvailability, observeApplicationState } from "./observers";
import { observeApplicationEvents } from "./observers/application-events";
import { observeArtifactEvents } from "./observers/artifact-events";
import { observeSavedDrafts } from "./observers/saved-drafts";
import { observeTerminalEvents } from "./observers/terminal-events";
import { storeSnapshotSchema } from "./persistence/StoreSnapshot";
import { extractSavedDrafts } from "../services/storage/WindowStateStorage";
import "streamdown/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Browser entry root is missing");
const root = createRoot(rootElement);
const projection = RootProjection.create();
const snapshotKey = "cake.browser.presentation.v1";
const uncertaintyKey = "cake.browser.delivery-uncertain.v1";
const snapshot = (() => {
  try {
    const saved = sessionStorage.getItem(snapshotKey);
    return saved ? Schema.decodeUnknownSync(storeSnapshotSchema)(JSON.parse(saved)) : undefined;
  } catch {
    sessionStorage.removeItem(snapshotKey);
    return undefined;
  }
})();
const url = new URL("/rpc", window.location.href);
url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const connection = mount(
  createStore(BrowserConnectionStore, {
    initialUncertainOperation: sessionStorage.getItem(uncertaintyKey) ?? undefined,
  }),
);
const stopConnectionPersistence = effect(() => {
  // A refresh must not turn a retained, potentially accepted prompt back into a safe retry.
  if (connection.uncertainOperation)
    sessionStorage.setItem(uncertaintyKey, connection.uncertainOperation);
  else sessionStorage.removeItem(uncertaintyKey);
});
let started = false;
const runtime = makeNetworkRuntime(url.href, (value) => {
  if (value && connection.everConnected && !connection.connected)
    rootStore.inlineWidgetStore.backendReconnected();
  connection.connectionChanged(value);
  if (value && !started) {
    started = true;
    void initialize(rootStore);
  }
  if (!value) {
    rootStore.terminalStore.disconnected();
    rootStore.projectWorkbenchStore.presentationStore.embeddedEditorStore.disconnected();
  }
});
const files = new BrowserFiles();
const fullscreenSurfaces = new Set<string>();
let ownsFullscreen = false;
const onFullscreenChange = () => {
  if (!document.fullscreenElement) {
    ownsFullscreen = false;
    fullscreenSurfaces.clear();
  }
};
document.addEventListener("fullscreenchange", onFullscreenChange);
const menus = mount(createStore(BrowserMenuStore));
const client = makeClient(runtime, {
  kind: "browser",
  files,
  menus,
  saveDrawExport: async ({ format, suggestedName, data }) => {
    const name = `${suggestedName.replace(/[<>:"/\\|?*]/g, "-").replace(/\p{Cc}/gu, "-")}.${format}`;
    if (format === "png" && !data.startsWith("data:image/png;base64,"))
      throw new Error("Draw export is not a PNG data URL");
    const blob =
      format === "png"
        ? await (await fetch(data)).blob()
        : new Blob([data], { type: format === "svg" ? "image/svg+xml" : "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      return name;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  },
  setFullscreenSurfaceOpen: async (surfaceId, open) => {
    if (open) {
      fullscreenSurfaces.add(surfaceId);
      if (!document.fullscreenElement) {
        try {
          await document.documentElement.requestFullscreen();
          ownsFullscreen = true;
          if (!fullscreenSurfaces.size) {
            ownsFullscreen = false;
            await document.exitFullscreen();
          }
        } catch (error) {
          fullscreenSurfaces.delete(surfaceId);
          throw error;
        }
      }
    } else {
      fullscreenSurfaces.delete(surfaceId);
      if (!fullscreenSurfaces.size && ownsFullscreen && document.fullscreenElement) {
        ownsFullscreen = false;
        await document.exitFullscreen();
      }
    }
  },
  showNotification: async ({ title, body }) => {
    if (!("Notification" in window) || Notification.permission !== "granted")
      throw new Error("Enable browser notifications for Cake in site settings");
    new Notification(title, { body });
  },
  connected: () => connection.connected,
  blocked: () => Boolean(connection.uncertainOperation),
  uncertain: (operation) => connection.deliveryUncertain(operation),
  openExternalUrl: async (value) => {
    const external = new URL(value);
    if (!["https:", "http:", "mailto:"].includes(external.protocol))
      throw new Error("Only web and mail links can be opened in this browser");
    window.open(external.href, "_blank", "noopener,noreferrer");
  },
});
const rootStore = mountRootStore(
  client,
  snapshot ?? { state: {}, children: {} },
  async () => persist(),
  projection,
  undefined,
  () => connection.connected && !connection.uncertainOperation,
  true,
);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  try {
    // Browser navigation and drafts are tab-local; never write the desktop window record.
    sessionStorage.setItem(
      snapshotKey,
      JSON.stringify(
        extractSavedDrafts(JSON.parse(JSON.stringify(toSnapshot(rootStore)))).windowSnapshot,
      ),
    );
  } catch (error) {
    rootStore.toastStore.show({
      tone: "warning",
      title: "Tab state could not be saved",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
const stopPersistence = onSnapshot(rootStore, () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 180);
});
const stopModels = observeModels(runtime, projection, rootStore);
const stopApplicationState = observeApplicationState(runtime, rootStore);
const stopAgentAvailability = observeAgentAvailability(runtime, rootStore);
const stopApplicationEvents = observeApplicationEvents(runtime, rootStore, "browser");
const stopArtifactEvents = observeArtifactEvents(runtime, rootStore);
const stopTerminalEvents = observeTerminalEvents(runtime, rootStore);
const stopSavedDrafts = observeSavedDrafts(
  runtime,
  (records) => rootStore.sessionRegistry.pendingSessions.applySavedDraftSnapshot(records),
  (error) =>
    rootStore.toastStore.show({
      tone: "warning",
      title: "Saved Draft updates disconnected",
      message: error instanceof Error ? error.message : String(error),
    }),
);
async function initialize(rootStore: ReturnType<typeof mountRootStore>) {
  void rootStore.settingsStore.modelPresets.hydrate();
  void rootStore.settingsStore.providers.hydrate();
  try {
    await rootStore.sessionRegistry.pendingSessions.refreshSavedDrafts();
  } catch (error) {
    rootStore.toastStore.show({
      tone: "warning",
      title: "Saved Drafts could not be loaded",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await rootStore.initialize();
  } catch (error) {
    rootStore.toastStore.show({
      tone: "error",
      title: "Could not restore navigation",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
const reportLinkError = (error: unknown) =>
  rootStore.toastStore.show({
    tone: "error",
    title: "Could not open link",
    message: error instanceof Error ? error.message : String(error),
  });
root.render(
  createElement(
    Fragment,
    null,
    createElement(RendererRoot, {
      rootStore,
      browserConnection: connection,
      openExternalUrl: (value) => void rootStore.openExternalUrl(value).catch(reportLinkError),
      openSession: (id) => void rootStore.openSessionLink(id).catch(reportLinkError),
    }),
    createElement(ContextActionMenu, { store: menus }),
  ),
);
window.addEventListener(
  "pagehide",
  () => {
    if (saveTimer) clearTimeout(saveTimer);
    persist();
    stopPersistence();
    stopConnectionPersistence();
    stopModels();
    stopApplicationState();
    stopAgentAvailability();
    stopApplicationEvents();
    stopArtifactEvents();
    stopTerminalEvents();
    stopSavedDrafts();
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    root.unmount();
    rootStore[Symbol.dispose]();
    connection[Symbol.dispose]();
    menus[Symbol.dispose]();
    projection[Symbol.dispose]();
    void runtime.dispose();
  },
  { once: true },
);
