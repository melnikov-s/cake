/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  type ProjectWorkflow,
  type SessionLabel,
} from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import type { ProjectSessionStore } from "../../../src/renderer/stores/ProjectSessionStore";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectPath = "/cake";
const globalLabel: SessionLabel = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Global",
  color: "blue",
};
const projectLabel: SessionLabel = {
  id: "10000000-0000-4000-8000-000000000002",
  name: "Project",
  color: "violet",
};
const deletedLabelId = "10000000-0000-4000-8000-000000000003";
const session = sessionSummary({ sessionId: "session-1", title: "Metadata session", projectPath });

async function renderMetadata(options: { pendingWorktree?: boolean; avatars?: boolean } = {}) {
  let workflow: ProjectWorkflow = {
    labels: [{ ...projectLabel }],
    assignments: [{ sessionId: session.sessionId, labelIds: [projectLabel.id, deletedLabelId] }],
    sessionDetails: [],
  };
  const project = () => projectRecord({ path: projectPath, name: "Cake", workflow });
  const setSessionLabels = vi.fn<Client["projectWorkflow"]["setSessionLabels"]>(async (input) => {
    workflow = {
      ...workflow,
      assignments: [{ sessionId: input.sessionId, labelIds: [...input.labelIds] }],
    };
    // The real command is followed by an authoritative Project snapshot, not a local optimistic label edit.
    applySnapshot(fixture.models.projects, { projects: [project()] });
    return workflow;
  });
  const start = vi.fn<Client["projectSessions"]["start"]>(() => new Promise(() => {}));
  const fixture = createRendererStoreFixture({
    projects: [project()],
    sessions: options.pendingWorktree ? [] : [session],
    client: {
      projectWorkflow: { setSessionLabels },
      projectSessions: { start },
      workspaces: { generateSessionTitle: async () => undefined },
    },
  });
  fixture.root.settingsStore.applyApplicationState(1, {
    ...defaultApplicationState(),
    globalSessionLabels: [globalLabel],
  });
  fixture.root.settingsStore.appearance.sessionAvatarsEnabled = options.avatars ?? true;
  let pending: ProjectSessionStore | undefined;
  if (options.pendingWorktree) {
    applySnapshot(fixture.models.worktrees, {
      worktrees: [
        {
          projectPath,
          worktreePath: "/worktree",
          branch: "agent/metadata",
          baseBranch: "main",
          state: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    await fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts();
    pending = fixture.root.sessionRegistry.pendingSessions.prepare("/worktree", "draft-1");
    fixture.root.navigationStore.selectProjectSession(pending.sessionId);
    const conversation = fixture.root.sessionRegistry.pendingSessions.conversation("draft-1");
    if (!conversation) throw new Error("Pending conversation was not created");
    conversation.labelIds = [globalLabel.id, deletedLabelId];
  }
  const { root } = fixture;
  const view = render(
    <>
      {[false, true].map((resolved) => (
        <section
          key={String(resolved)}
          aria-label={resolved ? "Resolved sessions" : "Active sessions"}
        >
          <SidebarProjectGroup
            cakeChat={root.cakeChatCollectionStore}
            onOpenCakeChat={(sessionId) => void root.navigationStore.openCakeChat(sessionId)}
            store={root.sidebarStore}
            sessionList={root.sidebarStore.sessionListStore}
            sessionMetadata={root.sessionMetadataStore}
            projects={root.projectCatalogStore}
            chat={root.projectWorkbenchStore}
            shell={root.appShellStore}
            appearance={root.settingsStore.appearance}
            path={projectPath}
            resolved={resolved}
            flattenSessions
            onCreateSession={(path) => void root.navigationStore.createSession(path)}
            onOpenSession={(id) => void root.navigationStore.openSession(id)}
            onRemoveProject={(path, deleteSessions) =>
              root.projectRemovalStore.remove(path, deleteSessions)
            }
            onOpenSettings={(path) => root.projectSettingsStore.open(path)}
          />
        </section>
      ))}
      {pending && <Chat store={pending.conversationSessionStore.chatStore} />}
    </>,
  );
  return {
    user: userEvent.setup(),
    setSessionLabels,
    start,
    async publishGlobalLabels(labels: SessionLabel[]) {
      await act(async () =>
        root.settingsStore.applyApplicationState(2, {
          ...defaultApplicationState(),
          globalSessionLabels: labels,
        }),
      );
    },
    async publishProjectLabels(labels: SessionLabel[]) {
      workflow = { ...workflow, labels };
      await act(async () => applySnapshot(fixture.models.projects, { projects: [project()] }));
    },
    async publishResolved(resolved: boolean) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [{ ...session, resolved }],
          resolvedHasMoreByProject: {},
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Session metadata projection workflows", () => {
  it("combines global and Project labels, excludes deleted assignments, and reacts to authoritative label removal", async () => {
    using fixture = await renderMetadata();
    await fixture.user.click(
      screen.getByRole("button", { name: "Change session labels. Current labels: Project" }),
    );
    const labels = screen.getByRole("group", { name: "Session labels" });
    expect(within(labels).getAllByRole("checkbox")).toHaveLength(2);
    expect(
      within(labels).getByRole("checkbox", { name: "Project" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(labels).getByRole("checkbox", { name: "Global" }).getAttribute("aria-checked"),
    ).toBe("false");
    await fixture.user.click(within(labels).getByRole("checkbox", { name: "Global" }));
    expect(
      await screen.findByRole("button", {
        name: "Change session labels. Current labels: Project, Global",
      }),
    ).toBeDefined();
    expect(fixture.setSessionLabels).toHaveBeenCalledWith(
      {
        projectPath,
        sessionId: "session-1",
        workingDirectory: projectPath,
        labelIds: [projectLabel.id, globalLabel.id],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await fixture.publishGlobalLabels([]);
    expect(
      screen.getByRole("button", { name: "Change session labels. Current labels: Project" }),
    ).toBeDefined();
    expect(within(labels).queryByRole("checkbox", { name: "Global" })).toBeNull();
    expect(
      within(labels).getByRole("checkbox", { name: "Project" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("updates row labels and picker choices when the authoritative Project catalog changes", async () => {
    using fixture = await renderMetadata();
    await fixture.user.click(
      screen.getByRole("button", { name: "Change session labels. Current labels: Project" }),
    );
    const labels = screen.getByRole("group", { name: "Session labels" });
    const renamed = { ...projectLabel, name: "Renamed", color: "green" as const };
    const added: SessionLabel = { id: deletedLabelId, name: "Added", color: "blue" };
    await fixture.publishProjectLabels([renamed, added]);
    expect(
      screen.getByRole("button", { name: "Change session labels. Current labels: Renamed, Added" }),
    ).toBeDefined();
    expect(
      within(labels).getByRole("checkbox", { name: "Renamed" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(labels).getByRole("checkbox", { name: "Added" }).getAttribute("aria-checked"),
    ).toBe("true");
    await fixture.publishProjectLabels([]);
    expect(
      screen.getByRole("button", { name: "Change session labels. Current labels: Unlabelled" }),
    ).toBeDefined();
    expect(within(labels).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(labels).getByRole("checkbox", { name: "Global" })).toBeDefined();
  });

  it("suppresses stale workflow labels for resolved sessions and projects them again when restored", async () => {
    using fixture = await renderMetadata({ avatars: false });
    const active = within(screen.getByRole("region", { name: "Active sessions" }));
    const resolved = within(screen.getByRole("region", { name: "Resolved sessions" }));
    expect(active.getByRole("img", { name: "Labels: Project" })).toBeDefined();
    // Session-catalog authority can resolve before the independent workflow assignment snapshot changes.
    await fixture.publishResolved(true);
    expect(resolved.getByRole("button", { name: /^Metadata session/ })).toBeDefined();
    expect(resolved.queryByRole("img", { name: /^Labels:/ })).toBeNull();
    await fixture.publishResolved(false);
    expect(active.getByRole("img", { name: "Labels: Project" })).toBeDefined();
  });

  it("routes a pending Managed Worktree session to its Project label catalog without persisting a materialized-session assignment", async () => {
    using fixture = await renderMetadata({ pendingWorktree: true });
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Message" }),
      "Continue this worktree",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.start).toHaveBeenCalledOnce());
    await fixture.user.click(
      screen.getByRole("button", { name: "Change session labels. Current labels: Global" }),
    );
    const labels = screen.getByRole("group", { name: "Session labels" });
    expect(within(labels).getAllByRole("checkbox")).toHaveLength(2);
    expect(
      within(labels).getByRole("checkbox", { name: "Global" }).getAttribute("aria-checked"),
    ).toBe("true");
    await fixture.user.click(within(labels).getByRole("checkbox", { name: "Project" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Change session labels. Current labels: Global, Project",
        }),
      ).toBeDefined(),
    );
    expect(
      within(labels).getByRole("checkbox", { name: "Project" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(fixture.setSessionLabels).not.toHaveBeenCalled();
  });
});
