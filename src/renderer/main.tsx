import { Schema } from "effect";
import { StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import Scene from "virtual:cake-scene";
import "virtual:cake-plugins";
import { RendererErrorBoundary } from "./components/renderer-error-boundary";
import { CustomizationRecovery } from "./components/customization-recovery";
import { LoadingState } from "./components/ui/loading-state";
import { MarkdownLinkProvider } from "./components/ai-elements/markdown";
import { makeRendererRuntime } from "./RendererRuntime";
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

interface ProjectSessionObservationTarget {
  sessionId: string;
  workingDirectory: string;
  newSession?: boolean;
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

async function bootstrap(bridge: NonNullable<typeof window.cake>) {
  const rendererRuntime = makeRendererRuntime(bridge.rpc);
  const rendererClient = makeRendererClient(rendererRuntime);
  const synchronizer = new RendererModelSynchronizer(rendererRuntime);
  const privilegedEvents = new RendererPrivilegedEvents(rendererRuntime);
  await privilegedEvents.ready;
  let hydrationError: unknown;
  const snapshot = await rendererClient.windowState
    .load()
    .then(Schema.decodeUnknownSync(storeSnapshotSchema))
    .catch((error) => {
      hydrationError = error;
      return { state: {}, children: {} };
    });
  const persistenceRef: PersistenceRef = {};
  const rootStore = mountRootStore(
    rendererClient,
    snapshot,
    () => persistenceRef.current?.flush() ?? Promise.resolve(),
  );
  await rootStore.settingsStore.modelPresets.hydrate();
  privilegedEvents.observe(rootStore, synchronizer);
  void rootStore.projectWorkbenchStore.initialize();
  const persistence = new WindowStatePersistence(rendererClient, (error) =>
    rootStore.toastStore.show({
      tone: "error",
      title: "Window state could not be saved",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  persistenceRef.current = persistence;
  persistence.observe(rootStore);
  synchronizer.observe({
    projects: rootStore.projectCatalogModel,
    sessionCatalog: rootStore.sessionCatalogModel,
    cakeChatCatalog: rootStore.cakeChatCatalogModel,
    projectSessions: () => {
      const blockedPath = rootStore.projectWorkbenchStore.pendingAuthorizationPath;
      const sessions = [...rootStore.sessionRegistry.materializedSessions].filter(
        (session) => session.workspacePath !== blockedPath,
      );
      const active = rootStore.projectWorkbenchStore.activeSession;
      if (active && active.workspacePath !== blockedPath && !sessions.includes(active))
        sessions.push(active);
      return sessions.map((session) => {
        const target: ProjectSessionObservationTarget = {
          sessionId: session.sessionId,
          workingDirectory: session.model.workingDirectory,
        };
        if (rootStore.sessionRegistry.isTemporarySession(session.sessionId))
          target.newSession = true;
        return { target, model: session.model };
      });
    },
    cakeChats: () =>
      rootStore.globalChatStore.loadedSessions
        .filter((session) => !rootStore.globalChatStore.isPendingSession(session.sessionId))
        .map((session) => ({
          target: rootStore.globalChatStore.target(session.sessionId),
          model: session.model,
        })),
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
        rendererClient.plugins.reportRuntimeFailure(revision, message)
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
                  report={(revision) => rendererClient.plugins.reportRendered(revision)}
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
