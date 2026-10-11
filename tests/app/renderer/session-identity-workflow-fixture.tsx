import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { App } from "../../../src/renderer/components/app";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { applyManagedWorktreeCatalogUpdate } from "../../../src/renderer/reducers/WorktreeCatalogReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const identityProjectPath = "/project";

export function renderSessionIdentity(
  options: {
    client?: TestClientOverrides;
    snapshot?: StoreSnapshot;
  } = {},
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: identityProjectPath, name: "Project" })],
    snapshot: options.snapshot,
    client: {
      ...options.client,
      workspaces: {
        loadStagedSlashCommands: async () => [],
        generateSessionTitle: async () => undefined,
        ...options.client?.workspaces,
      },
      managedWorktrees: { landing: async () => ({}), ...options.client?.managedWorktrees },
    },
  });
  const { root } = fixture;
  if (!options.snapshot) {
    root.sessionRegistry.pendingSessions.prepareStaged(identityProjectPath, "staged-original");
    root.appShellStore.selectProjectSession("staged-original");
    root.sessionLayoutStore.ensureSession("staged-original");
    root.projectWorkbenchStore.showLoadedSession("staged-original");
  }
  const view = render(
    <StoreProvider store={root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    snapshot: () => toSnapshot(root),
    publishWorktrees(records: WorktreeRecord[]) {
      act(() =>
        applyManagedWorktreeCatalogUpdate(fixture.models.worktrees, {
          _tag: "Snapshot",
          worktrees: records,
        }),
      );
    },
    publishCreatedSession(workingDirectory: string) {
      act(() =>
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath: identityProjectPath, resolved: false },
          {
            _tag: "Snapshot",
            revision: 1,
            sessions: [
              sessionSummary({
                sessionId: "staged-original",
                projectPath: identityProjectPath,
                workingDirectory,
                title: "Prepare checkout",
                messageCount: 1,
              }),
            ],
          },
        ),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
