import { applySnapshot, updateStore, type StoreSnapshot } from "r-state-tree";
import type { Microphone } from "../../../src/renderer/dictation/microphone";
import type { SpeechPlayback } from "../../../src/renderer/speech/playback";
import type { ProjectRecord } from "../../../src/domain/application/application-data";
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
    nonChatModels: { list: async () => [], ...options.client?.nonChatModels },
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
