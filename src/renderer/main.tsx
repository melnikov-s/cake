import { Schema } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import { App } from "./app";
import { RendererErrorBoundary } from "./components/renderer-error-boundary";
import { MarkdownLinkProvider } from "./components/ai-elements/markdown";
import { makeRendererRuntime } from "./RendererRuntime";
import { makeRendererClient } from "./client/RendererClientLive";
import { RendererModelSynchronizer } from "./RendererModelSynchronizer";
import { RendererModels } from "./RendererModels";
import { RendererNativeEvents } from "./RendererNativeEvents";
import { RendererMainStateSynchronizer } from "./RendererMainStateSynchronizer";
import { RendererSynchronizationSupervisor } from "./RendererSynchronizationSupervisor";
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
  const synchronizationSupervisor = new RendererSynchronizationSupervisor();
  const synchronizer = new RendererModelSynchronizer(rendererRuntime, synchronizationSupervisor);
  const models = new RendererModels();
  const nativeEvents = new RendererNativeEvents(rendererRuntime, synchronizationSupervisor);
  const nativeState = new RendererMainStateSynchronizer(rendererRuntime, synchronizationSupervisor);
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
    models,
  );
  nativeState.observe(rootStore);
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
    projectSessionCatalogQueries: () => rootStore.sidebarStore.projectSessionCatalogQueries,
    cakeChatCatalog: rootStore.cakeChatCatalogModel,
    cakeChatCatalogQueries: () => rootStore.sidebarStore.cakeChatCatalogQueries,
    projectSessions: () => {
      const blockedPath = rootStore.projectWorkbenchStore.pendingAuthorizationPath;
      return rootStore.sessionRegistry.observationSessions
        .filter(
          (session) =>
            session.workspacePath !== blockedPath &&
            !rootStore.sessionCatalogStore.find(session.sessionId)?.resolved,
        )
        .map((session) => ({
          target: {
            sessionId: session.sessionId,
            workingDirectory: session.workspacePath,
          } satisfies ProjectSessionObservationTarget,
          model: session.model,
        }));
    },
    cakeChats: () =>
      rootStore.globalChatStore.loadedSessions
        .filter((session) => !rootStore.globalChatStore.isPendingSession(session.sessionId))
        .map((session) => ({
          target: rootStore.globalChatStore.target(session.sessionId),
          model: session.model,
        })),
  });
  void nativeEvents.observe(rootStore, synchronizer);
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
  const markdownLinkActions = {
    openExternalUrl: (url: string) => {
      void rootStore.openExternalUrl(url).catch(reportLinkError);
    },
    openSession: (sessionId: string) => {
      void rootStore.openSessionLink(sessionId).catch(reportLinkError);
    },
  };
  root.render(
    <RendererErrorBoundary>
      <StrictMode>
        <RendererInfrastructureProvider
          value={{
            client: rendererClient,
            subscribe: (listener) => nativeEvents.subscribe(listener),
          }}
        >
          <StoreProvider store={rootStore}>
            <MarkdownLinkProvider actions={markdownLinkActions}>
              <App />
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
      nativeEvents[Symbol.dispose]();
      nativeState[Symbol.dispose]();
      synchronizer[Symbol.dispose]();
      synchronizationSupervisor[Symbol.dispose]();
      rootStore[Symbol.dispose]();
      models[Symbol.dispose]();
      void rendererRuntime.dispose();
    },
    { once: true },
  );
}
