/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { observer } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function record(name: string): WorktreeRecord {
  return {
    projectPath: "/project",
    worktreePath: `/.project-worktrees/${name}`,
    branch: `agent/${name}`,
    baseBranch: "main",
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}

async function renderCreation(
  create: Client["managedWorktrees"]["create"],
  names = ["Planned Work"],
) {
  const drafts = fakeSavedDrafts();
  for (const [index, title] of names.entries())
    await drafts.client.create({
      sessionId: `draft-${index}`,
      projectPath: "/project",
      title,
      text: `Implement ${title}`,
      attachments: [],
    });
  const activate = vi.fn(drafts.client.activate);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      savedDrafts: { ...drafts.client, activate },
      managedWorktrees: {
        create,
        landing: async ({ workspacePath }) =>
          workspacePath === "/project"
            ? {}
            : {
                status: {
                  record: record(workspacePath.split("/").at(-1)!),
                  targetBranch: "main",
                  aheadCount: 0,
                  behindCount: 0,
                  dirtyCount: 0,
                  merged: false,
                  targetDirty: false,
                  targetOnBranch: true,
                  merging: false,
                  rebasing: false,
                  squashMessageReady: false,
                },
              },
      },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  await fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts();
  fixture.root.appShellStore.selectProjectSession("draft-0");
  fixture.root.projectWorkbenchStore.showLoadedSession("draft-0");
  const Surface = observer(function Surface() {
    return (
      <>
        {names.map((name, index) => {
          const id = `draft-${index}`;
          const session = fixture.root.sessionRegistry.findSession(id);
          if (!session) throw new Error("Missing saved Draft");
          const chat = session.conversationSessionStore.chatStore;
          const error = fixture.root.projectWorkbenchStore.contextError(id);
          return (
            <section key={id} aria-label={name}>
              <Chat
                store={chat}
                embedded
                composerFocusEnabled={false}
                error={error}
                composerHeader={
                  <WorktreePill
                    creation={fixture.root.projectSessionCreationStore.worktrees}
                    actions={session.worktreeStore}
                    sessionId={id}
                    projectPath="/project"
                    record={fixture.root.sessionCatalogStore.managedWorktree(session.workspacePath)}
                    configurationMode={chat.isDraftSession ? "activate-draft" : undefined}
                    onConfigured={() =>
                      session.conversationSessionStore.composerStore.draftStore.requestFocus()
                    }
                  />
                }
              />
            </section>
          );
        })}
      </>
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

function draft(name = "Planned Work") {
  return within(screen.getByRole("region", { name }));
}
afterEach(cleanup);

describe("Worktree creation workflow", () => {
  it("names a new checkout from the saved Draft and activates the Draft in that directory", async () => {
    const create = vi.fn<Client["managedWorktrees"]["create"]>(async () => record("planned-work"));
    using fixture = await renderCreation(create);
    await fixture.user.click(draft().getByRole("button", { name: "New worktree" }));
    await fixture.user.click(draft().getByRole("button", { name: "Activate draft" }));
    await waitFor(() => expect(fixture.activate).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      operationId: expect.any(String),
      path: "/project",
      baseWorktreePath: undefined,
      worktreeName: "planned-work",
      firstUserMessage: "Implement Planned Work",
      backgroundSetup: true,
    });
    expect(fixture.activate).toHaveBeenCalledWith(
      {
        sessionId: "draft-0",
        expectedRevision: 1,
        workingDirectory: "/.project-worktrees/planned-work",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await waitFor(() =>
      expect(draft().queryByRole("button", { name: "Activate draft" })).toBeNull(),
    );
    expect(draft().getByText("planned-work")).toBeDefined();
  });

  it("retains the Draft and new-checkout choice after failure so the user can retry", async () => {
    const create = vi
      .fn<Client["managedWorktrees"]["create"]>()
      .mockRejectedValueOnce(new Error("Checkout setup failed"))
      .mockResolvedValueOnce(record("planned-work"));
    using fixture = await renderCreation(create);
    await fixture.user.click(draft().getByRole("button", { name: "New worktree" }));
    await fixture.user.click(draft().getByRole("button", { name: "Activate draft" }));
    expect(await screen.findByText("Checkout setup failed")).toBeDefined();
    expect(fixture.activate).not.toHaveBeenCalled();
    expect(draft().getByRole("button", { name: "New worktree" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await fixture.user.click(draft().getByRole("button", { name: "Activate draft" }));
    await waitFor(() => expect(fixture.activate).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(draft().queryByRole("button", { name: "Activate draft" })).toBeNull(),
    );
  });

  it("prepares separate Draft checkouts concurrently without activating either before its checkout is ready", async () => {
    const first = deferred<WorktreeRecord>();
    const second = deferred<WorktreeRecord>();
    const create = vi
      .fn<Client["managedWorktrees"]["create"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    using fixture = await renderCreation(create, ["First", "Second"]);
    for (const name of ["First", "Second"]) {
      await fixture.user.click(draft(name).getByRole("button", { name: "New worktree" }));
      await fixture.user.click(draft(name).getByRole("button", { name: "Activate draft" }));
      expect(draft(name).getByText("Creating worktree and running setup commands")).toBeDefined();
    }
    await fixture.user.click(draft("First").getByRole("button", { name: "Activate draft" }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(fixture.activate).not.toHaveBeenCalled();
    await act(async () => second.resolve(record("second")));
    await waitFor(() =>
      expect(draft("Second").queryByRole("button", { name: "Activate draft" })).toBeNull(),
    );
    expect(draft("First").getByText("Creating worktree and running setup commands")).toBeDefined();
    expect(fixture.activate).toHaveBeenCalledTimes(1);
    expect(fixture.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "draft-1",
        workingDirectory: "/.project-worktrees/second",
      }),
      expect.any(Object),
    );
    await act(async () => first.resolve(record("first")));
    await waitFor(() =>
      expect(draft("First").queryByRole("button", { name: "Activate draft" })).toBeNull(),
    );
    expect(fixture.activate).toHaveBeenCalledTimes(2);
  });
});
