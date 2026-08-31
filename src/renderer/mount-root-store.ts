import { createStore, mount } from "r-state-tree";
import type { DesktopClient } from "./desktop-client";
import { RootStore } from "./stores/RootStore";
import type { ModelPresetSettingsStoreInstance } from "./stores/ModelPresetSettingsStore";
import type { ProjectCatalogStoreInstance } from "./stores/ProjectCatalogStore";
import type { SessionCatalogStoreInstance } from "./stores/SessionCatalogStore";
import type { CatalogOperationRunner } from "./catalog-operation-runner";

export function mountRootStore(
  client: DesktopClient,
  modelPresets: ModelPresetSettingsStoreInstance,
  projectCatalog: ProjectCatalogStoreInstance,
  sessionCatalog: SessionCatalogStoreInstance,
  runCatalog: CatalogOperationRunner,
) {
  const root = mount(
    createStore(RootStore, {
      client,
      modelPresets,
      projectCatalog,
      sessionCatalog,
      runCatalog,
    }),
  );
  void root.windowPersistence.hydrate();
  return root;
}
