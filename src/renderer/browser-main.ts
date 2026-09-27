import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { makeNetworkRuntime } from "./runtime";
import { makeClient } from "./client/ClientLive";
import { RootProjection } from "./models/RootProjection";
import { BrowserShellStore } from "./stores/BrowserShellStore";
import { BrowserShell } from "./components/browser-shell";
import { observeBrowser } from "./observers/browser";
import { observeSavedDrafts } from "./observers/saved-drafts";
import "streamdown/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Browser entry root is missing");
const root = createRoot(rootElement);
const projection = RootProjection.create();
const url = new URL("/rpc", window.location.href);
url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const runtime = makeNetworkRuntime(url.href, (connected) => {
  store.connectionChanged(connected);
  if (connected) store.error = undefined;
});
const client = makeClient(runtime, {
  kind: "browser",
  connected: () => store.connected,
  openExternalUrl: async (value) => {
    const external = new URL(value);
    if (
      external.protocol !== "https:" &&
      external.protocol !== "http:" &&
      external.protocol !== "mailto:"
    )
      throw new Error("That link is unavailable in basic browser chat");
    window.open(external.href, "_blank", "noopener,noreferrer");
  },
});
const store = mount(createStore(BrowserShellStore, { client, projection }));
const stop = observeBrowser(runtime, projection, store);
const stopSavedDrafts = observeSavedDrafts(
  runtime,
  (records) => store.applySavedDraftSnapshot(records),
  (error) => store.reportError(error),
);
root.render(createElement(BrowserShell, { store }));
window.addEventListener(
  "pagehide",
  () => {
    stop();
    stopSavedDrafts();
    root.unmount();
    store[Symbol.dispose]();
    projection[Symbol.dispose]();
    void runtime.dispose();
  },
  { once: true },
);
