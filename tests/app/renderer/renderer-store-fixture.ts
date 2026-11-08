import { applySnapshot, updateStore, type StoreSnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { Microphone } from "../../../src/renderer/dictation/microphone";
import type { SpeechPlayback } from "../../../src/renderer/speech/playback";
import type { ProjectRecord } from "../../../src/contracts/application/application-data";
import { mountRootStore } from "../../../src/renderer/bootstrap/mount-root-store";
import { RootProjection } from "../../../src/renderer/models/RootProjection";
import type { SessionSummaryFixture } from "./fixtures/catalog-fixtures";
import { createTestClient, type TestClientOverrides } from "./test-client";
import type { DesktopConnectionStore } from "../../../src/renderer/stores/DesktopConnectionStore";

export interface RendererStoreFixtureOptions {
  readonly client?: TestClientOverrides;
  readonly projects?: readonly ProjectRecord[];
  readonly sessions?: readonly SessionSummaryFixture[];
  readonly flushWindowState?: () => Promise<void>;
  readonly snapshot?: StoreSnapshot;
  readonly desktopConnection?: DesktopConnectionStore;
  readonly microphone?: Microphone;
  readonly speechPlayback?: SpeechPlayback;
}

/** Mounts the real renderer Store tree over real projection Models and controlled services. */
export function createRendererStoreFixture(options: RendererStoreFixtureOptions = {}) {
  const models = RootProjection.create();
  applySnapshot(models.projects, { projects: [...(options.projects ?? [])] });
  applySnapshot(models.sessionCatalog, {
    sessions: [...(options.sessions ?? [])],
    resolvedHasMoreByProject: {},
  });
  const client = createTestClient({
    ...options.client,
    projectSessions: {
      lookup: async ({ sessionId }) => {
        const session = models.sessionCatalog.find(sessionId);
        if (!session) throw new Error(`Cake could not find Project Session ${sessionId}`);
        return session;
      },
      ...options.client?.projectSessions,
    },
    // The real Root Store starts its selected chat independently of passive catalog tests.
    cakeChats: {
      open: async () => {},
      lookup: async ({ sessionId }) => {
        const existing = models.cakeChatCatalog.sessions.find(
          (item) => item.sessionId === sessionId,
        );
        if (existing) return existing;
        if (sessionId !== CAKE_CHAT_SESSION_ID) throw new Error("Chat is not registered");
        return {
          sessionId,
          title: "Cake Chat",
          createdAt: "2026-01-01T00:00:00Z",
          modifiedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          unstarted: true,
          resolved: false,
          unread: false,
          running: false,
        };
      },
      ...options.client?.cakeChats,
    },
    // Most UI workflows use a static to-do authority; reconciliation is exercised separately.
    projectTodos: { reconcile: async () => {}, ...options.client?.projectTodos },
    // Resource disposal is incidental in workflows that do not inspect publication lifetimes.
    inlineWidgets: { release: async () => {}, ...options.client?.inlineWidgets },
    nonChatModels: { list: async () => [], ...options.client?.nonChatModels },
    piSettings: { extensions: async () => [], ...options.client?.piSettings },
    // The real Session Registry refreshes its main-owned Saved Draft snapshot when mounted.
    savedDrafts: {
      list: async () => [],
      ...options.client?.savedDrafts,
    },
  });
  const root = mountRootStore(
    client,
    options.snapshot ?? { state: {}, children: {} },
    options.flushWindowState ?? (async () => undefined),
    models,
    options.desktopConnection,
  );

  updateStore(root, { microphone: options.microphone, speechPlayback: options.speechPlayback });
  return {
    client,
    models,
    root,
    [Symbol.dispose]() {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    },
  };
}
