/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { observer } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import { fixtureTimestamp, projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}

const projectPath = "/project";
const record: WorktreeRecord = {
  projectPath,
  worktreePath: "/worktrees/planned-work",
  branch: "agent/planned-work",
  baseBranch: "main",
  state: "active",
  createdAt: fixtureTimestamp,
};
type LandingSnapshot = Awaited<ReturnType<Client["managedWorktrees"]["landing"]>>;

async function renderRelocatedAuthorityWorkflow(landing: Client["managedWorktrees"]["landing"]) {
  const drafts = fakeSavedDrafts();
  await drafts.client.create({
    sessionId: "draft",
    projectPath,
    title: "Planned Work",
    text: "Implement planned work",
    attachments: [],
  });
  const activate = vi.fn(drafts.client.activate);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    client: {
      savedDrafts: { ...drafts.client, activate },
      managedWorktrees: { create: async () => record, landing },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  const { root } = fixture;
  await root.sessionRegistry.pendingSessions.refreshSavedDrafts();
  root.appShellStore.selectProjectSession("draft");
  root.projectWorkbenchStore.showLoadedSession("draft");
  const session = root.sessionRegistry.findSession("draft");
  if (!session) throw new Error("Expected saved Draft identity");
  const Surface = observer(function Surface() {
    const chat = session.conversationSessionStore.chatStore;
    return (
      <Chat
        store={chat}
        embedded
        composerFocusEnabled={false}
        composerHeader={
          <WorktreePill
            creation={root.projectWorkbenchStore.sessionCreationStore.worktrees}
            actions={session.worktreeStore}
            sessionId="draft"
            projectPath={projectPath}
            record={root.sessionCatalogStore.managedWorktree(session.workspacePath)}
            configurationMode={chat.isDraftSession ? "activate-draft" : undefined}
            onConfigured={() =>
              session.conversationSessionStore.composerStore.draftStore.requestFocus()
            }
          />
        }
      />
    );
  });
  const view = render(<Surface />);
  return {
    user: userEvent.setup(),
    activate,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

// Activation is the real directory-switch action missing from the old standalone
// WorktreeStore test. Existing creation/operation workflows cover its ordinary
// success path; this journey adds only the late status response across relocation.
// It proves renderer service coordination, not native focus or Git integration.
describe("Authority refresh workflow", () => {
  it("keeps the activated checkout's controls ready when the old project status arrives late", async () => {
    const oldStatus = deferred<LandingSnapshot>();
    const oldRequested = deferred<void>();
    const landing: Client["managedWorktrees"]["landing"] = async ({ workspacePath }) => {
      if (workspacePath === projectPath) {
        oldRequested.resolve();
        return oldStatus.promise;
      }
      expect(workspacePath).toBe(record.worktreePath);
      return {
        status: {
          record,
          targetBranch: "main",
          aheadCount: 1,
          behindCount: 0,
          dirtyCount: 0,
          merged: false,
          targetDirty: false,
          targetOnBranch: true,
          merging: false,
          rebasing: false,
          squashMessageReady: false,
        },
      };
    };
    using fixture = await renderRelocatedAuthorityWorkflow(landing);
    await oldRequested.promise;

    await fixture.user.click(screen.getByRole("button", { name: "New worktree" }));
    await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
    const merge = () => screen.getByRole("button", { name: "Merge" });
    await waitFor(() => expect(merge()).toHaveProperty("disabled", false));
    expect(screen.getByText("planned-work")).toBeDefined();
    expect(fixture.activate).toHaveBeenCalledWith(
      {
        sessionId: "draft",
        expectedRevision: 1,
        workingDirectory: record.worktreePath,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    // The Project root is not a Managed Worktree. Its late empty snapshot must
    // not clear the new checkout's ready status and disable its merge controls.
    await act(async () => oldStatus.resolve({}));
    expect(merge()).toHaveProperty("disabled", false);
    expect(screen.getByText("planned-work")).toBeDefined();
  });
});
