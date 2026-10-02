/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { observer } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

type Commands = Awaited<ReturnType<Client["workspaces"]["loadStagedSlashCommands"]>>;
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}
function skill(name: string): Commands[number] {
  return {
    name: `skill:${name}`,
    description: `${name} skill`,
    source: "skill",
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      source: name,
      scope: "project",
      origin: "top-level",
    },
  };
}

async function renderStaged(load: Client["workspaces"]["loadStagedSlashCommands"]) {
  const started = deferred<TurnId>();
  const start = vi.fn<Client["projectSessions"]["start"]>(() => started.promise);
  const loadCommands = vi.fn(load);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      workspaces: { loadStagedSlashCommands: loadCommands },
      projectSessions: { start },
      managedWorktrees: {
        create: async () => ({
          projectPath: "/project",
          worktreePath: "/worktree",
          branch: "agent/task",
          baseBranch: "main",
          state: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        landing: async () => ({}),
      },
    },
  });
  fixture.root.projectWorkbenchStore.projectOpenStore.activate("/project");
  await fixture.root.projectWorkbenchStore.startNewSession("/project");
  const session = fixture.root.projectWorkbenchStore.activeSession;
  if (!session) throw new Error("Expected an unsent Project Session");
  const Surface = observer(function Surface() {
    return (
      <Chat
        store={session!.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
        composerHeader={
          <WorktreePill
            creation={fixture.root.projectWorkbenchStore.sessionCreationStore.worktrees}
            actions={session!.worktreeStore}
            sessionId={session!.sessionId}
            projectPath="/project"
            configurationMode={
              fixture.root.sessionRegistry.pendingSessions.isTemporary(session!.sessionId)
                ? "new-session"
                : undefined
            }
            record={fixture.root.sessionCatalogStore.managedWorktree(session!.workspacePath)}
            onConfigured={() =>
              session!.conversationSessionStore.composerStore.draftStore.requestFocus()
            }
          />
        }
      />
    );
  });
  const view = render(<Surface />);
  return {
    user: userEvent.setup(),
    start,
    loadCommands,
    async materialize() {
      await act(async () => {
        started.resolve(TurnId.make("10000000-0000-4000-8000-000000000001"));
        await started.promise;
      });
      act(() =>
        applyConversationUpdate(
          fixture.models.projectConversation(session.sessionId, "/worktree"),
          {
            _tag: "Snapshot",
            revision: 1,
            snapshot: {
              sessionId: session.sessionId,
              sessionFile: "/worktree/session.jsonl",
              parts: [],
              models: [],
              thinkingLevel: "off",
              availableThinkingLevels: ["off"],
              streaming: false,
              diagnostics: [],
              commands: [skill("runtime")],
              compatibility: { resources: [], diagnostics: [] },
              extensionUi: { statuses: [] },
              tree: [],
            },
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

async function showCommands(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByRole("combobox", { name: "Message" }));
  await user.type(screen.getByRole("combobox", { name: "Message" }), "/");
}
async function startInWorktree(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByRole("combobox", { name: "Message" }));
  await user.click(screen.getByRole("button", { name: "New worktree" }));
  await user.type(screen.getByRole("combobox", { name: "Message" }), "Implement the task");
  await user.click(screen.getByRole("button", { name: "Send" }));
}
function command(name: string) {
  return screen.queryByRole("option", { name: new RegExp(name) });
}
afterEach(cleanup);

describe("Staged session command workflow", () => {
  it("offers staged commands and clears the previous directory's skills while checkout discovery is pending", async () => {
    const replacement = deferred<Commands>();
    using fixture = await renderStaged(async (path) =>
      path === "/project" ? [skill("previous")] : replacement.promise,
    );
    await showCommands(fixture.user);
    expect(command("model")).not.toBeNull();
    expect(command("name")).not.toBeNull();
    expect(command("previous")).not.toBeNull();
    expect(command("compact")).toBeNull();
    await startInWorktree(fixture.user);
    await waitFor(() => expect(fixture.start).toHaveBeenCalled());
    await showCommands(fixture.user);
    expect(command("previous")).toBeNull();
    expect(command("model")).not.toBeNull();
    await act(async () => replacement.resolve([skill("replacement")]));
    expect(await screen.findByRole("option", { name: /replacement/ })).toBeDefined();
    expect(fixture.loadCommands.mock.calls.map(([path]) => path)).toEqual([
      "/project",
      "/worktree",
    ]);
  });

  it("ignores a superseded project discovery when its response arrives after the worktree's skills", async () => {
    const project = deferred<Commands>();
    const worktree = deferred<Commands>();
    using fixture = await renderStaged((path) =>
      path === "/project" ? project.promise : worktree.promise,
    );
    await startInWorktree(fixture.user);
    await waitFor(() => expect(fixture.start).toHaveBeenCalled());
    await showCommands(fixture.user);
    await act(async () => worktree.resolve([skill("latest")]));
    expect(await screen.findByRole("option", { name: /latest/ })).toBeDefined();
    await act(async () => project.resolve([skill("stale")]));
    expect(command("latest")).not.toBeNull();
    expect(command("stale")).toBeNull();
    expect(fixture.loadCommands.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("switches to authoritative runtime commands after first send and ignores late staged discovery", async () => {
    const worktree = deferred<Commands>();
    using fixture = await renderStaged(async (path) =>
      path === "/project" ? [] : worktree.promise,
    );
    await startInWorktree(fixture.user);
    await waitFor(() => expect(fixture.start).toHaveBeenCalled());
    await fixture.materialize();
    await showCommands(fixture.user);
    expect(await screen.findByRole("option", { name: /runtime/ })).toBeDefined();
    await act(async () => worktree.resolve([skill("too-late")]));
    expect(command("runtime")).not.toBeNull();
    expect(command("too-late")).toBeNull();
    expect(fixture.loadCommands.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });
});
