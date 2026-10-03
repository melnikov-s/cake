import { applySnapshot, type StoreSnapshot } from "r-state-tree";
import type { ProjectRecord } from "../../../src/domain/application/application-data";
import { mountRootStore } from "../../../src/renderer/bootstrap/mount-root-store";
import { RootProjection } from "../../../src/renderer/models/RootProjection";
import type { SessionSummaryFixture } from "./fixtures/catalog-fixtures";
import { createTestClient, type TestClientOverrides } from "./test-client";

export interface RendererStoreFixtureOptions {
  readonly client?: TestClientOverrides;
  readonly projects?: readonly ProjectRecord[];
  readonly sessions?: readonly SessionSummaryFixture[];
  readonly flushWindowState?: () => Promise<void>;
  readonly snapshot?: StoreSnapshot;
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
  );

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
