import { StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import Scene from "virtual:cake-scene";
import "virtual:cake-plugins";
import { RendererErrorBoundary } from "./components/renderer-error-boundary";
import { CustomizationRecovery } from "./components/customization-recovery";
import { LoadingState } from "./components/ui/loading-state";
import { MarkdownLinkProvider } from "./components/ai-elements/markdown";
import {
  desktopResponseSchema,
  type DesktopRequest,
  type DesktopResponse,
} from "../ipc/desktop-ipc";
import { createDesktopClient } from "./desktop-client";
import { makeRendererRuntime } from "./RendererRuntime";
import type { RendererClient } from "./client/RendererClient";
import { makeRendererClient } from "./client/RendererClientLive";
import { RendererModelSynchronizer } from "./RendererModelSynchronizer";
import { RendererPrivilegedEvents } from "./RendererPrivilegedEvents";
import { RendererInfrastructureProvider } from "./RendererInfrastructureContext";
import { installStaleAssetRecovery } from "./stale-asset-recovery";
import { mountRootStore } from "./mount-root-store";
import { storeSnapshotSchema } from "./store-snapshot";
import { WindowStatePersistence } from "./WindowStatePersistence";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const disposeStaleAssetRecovery = installStaleAssetRecovery();
interface PersistenceRef {
  current?: WindowStatePersistence;
}

const customizationRevision =
  typeof __CAKE_CUSTOMIZATION_REVISION__ === "undefined"
    ? undefined
    : __CAKE_CUSTOMIZATION_REVISION__;

function CustomizationHealth({ report }: { report(revision: string): Promise<void> }) {
  useEffect(() => {
    if (customizationRevision) void report(customizationRevision);
  }, [report]);
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
  void bootstrap(window.cake);
}

const requestTypes = {
  terminals: new Set([
    "open-terminal",
    "write-terminal",
    "resize-terminal",
    "get-terminal-status",
    "close-terminal",
  ]),
  vscode: new Set([
    "set-vscode-server-path",
    "get-embedded-editor-state",
    "install-embedded-editor",
    "open-embedded-editor",
    "update-embedded-editor-bounds",
    "reveal-in-embedded-editor",
    "open-embedded-editor-source-control",
    "update-embedded-editor-annotations",
  ]),
  filesystem: new Set(["choose-attachments", "suggest-files", "read-workspace-file"]),
  managedWorktrees: new Set([
    "create-worktree",
    "get-worktree-status",
    "land-worktree",
    "discard-worktree",
  ]),
  artifacts: new Set(["respond-artifact", "export-artifacts", "respond-ui"]),
  workspaces: new Set([
    "set-utility-model",
    "register-project",
    "rename-project",
    "remove-project",
    "delete-session",
    "set-session-unread",
    "restart-pi",
    "inspect-workspace",
    "respond-workspace-trust",
  ]),
} as const;

function invokeDesktopRequest(client: RendererClient, request: DesktopRequest) {
  const type = request.type;
  if (requestTypes.terminals.has(type)) return client.terminals.invoke(request);
  if (requestTypes.vscode.has(type)) return client.vscode.invoke(request);
  if (requestTypes.filesystem.has(type)) return client.filesystem.invoke(request);
  if (requestTypes.managedWorktrees.has(type)) return client.managedWorktrees.invoke(request);
  if (requestTypes.artifacts.has(type)) return client.artifacts.invoke(request);
  if (requestTypes.workspaces.has(type)) return client.workspaces.invoke(request);
  if (type.includes("plugin") || type.includes("customization") || type.includes("inline-widget"))
    return client.plugins.invoke(request);
  return client.electron.invoke(request);
}

async function bootstrap(bridge: NonNullable<typeof window.cake>) {
  const rendererRuntime = makeRendererRuntime(bridge.rpc);
  const rendererClient = makeRendererClient(rendererRuntime);
  const synchronizer = new RendererModelSynchronizer(rendererRuntime);
  const privilegedEvents = new RendererPrivilegedEvents(rendererRuntime);
  await privilegedEvents.ready;
  const desktopClient = createDesktopClient(privilegedEvents, (request) =>
    invokeDesktopRequest(rendererClient, request).then((response): DesktopResponse =>
      desktopResponseSchema.parse(response),
    ),
  );
  let hydrationError: unknown;
  const snapshot = await rendererClient.windowState
    .load()
    .then(storeSnapshotSchema.parse)
    .catch((error) => {
      hydrationError = error;
      return { state: {}, children: {} };
    });
  const persistenceRef: PersistenceRef = {};
  const rootStore = mountRootStore(
    desktopClient,
    rendererClient,
    snapshot,
    () => persistenceRef.current?.flush() ?? Promise.resolve(),
  );
  const persistence = new WindowStatePersistence(rendererClient, (error) =>
    rootStore.toastStore.show({
      tone: "error",
      title: "Window state could not be saved",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  persistenceRef.current = persistence;
  persistence.observe(rootStore);
  synchronizer.observe(rootStore);
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
  const markdownLinkActions = {
    openExternalUrl: (url: string) => {
      void rootStore.openExternalUrl(url).catch(reportLinkError);
    },
    openSession: (sessionId: string) => {
      void rootStore.openSessionLink(sessionId).catch(reportLinkError);
    },
  };
  root.render(
    <RendererErrorBoundary
      onCustomizationFailure={(revision, message) =>
        rendererClient.plugins
          .invoke({
            type: "customization-runtime-failed",
            revision,
            message,
          })
          .then(() => undefined)
      }
    >
      <StrictMode>
        <RendererInfrastructureProvider
          value={{
            client: rendererClient,
            subscribe: (listener) => privilegedEvents.subscribe(listener),
          }}
        >
          <StoreProvider store={rootStore}>
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
                <CustomizationHealth
                  report={(revision) =>
                    rendererClient.plugins
                      .invoke({ type: "customization-rendered", revision })
                      .then(() => undefined)
                  }
                />
              </Suspense>
              <CustomizationRecovery />
            </MarkdownLinkProvider>
          </StoreProvider>
        </RendererInfrastructureProvider>
      </StrictMode>
    </RendererErrorBoundary>,
  );
  window.addEventListener(
    "pagehide",
    () => {
      disposeStaleAssetRecovery();
      persistence?.[Symbol.dispose]();
      rootStore[Symbol.dispose]();
      synchronizer[Symbol.dispose]();
      privilegedEvents[Symbol.dispose]();
      void rendererRuntime.dispose();
    },
    { once: true },
  );
}
