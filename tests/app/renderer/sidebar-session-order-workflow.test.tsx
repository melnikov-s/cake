/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/ipc/conversation-data";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import {
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectPath = "/project";
const initialSessions = ["newer", "previous", "older", "oldest"].map((sessionId, index) =>
  sessionSummary({
    sessionId,
    projectPath,
    modifiedAt: new Date(Date.UTC(2026, 0, 4 - index)).toISOString(),
  }),
);
function conversation(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}
function renderOrdering(kind: "project-session" | "cake-chat") {
  let completeResolve!: () => void;
  const resolving = new Promise<void>((complete) => {
    completeResolve = complete;
  });
  const resolve = vi.fn(async () => resolving);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    sessions: kind === "project-session" ? initialSessions : [],
    client: {
      projectSessions: { open: async () => undefined, resolve },
      cakeChats: { open: async () => undefined, resolve },
    },
  });
  const { root, models } = fixture;
  if (kind === "cake-chat")
    applySnapshot(models.cakeChatCatalog, { loaded: true, sessions: initialSessions });
  for (const session of initialSessions) {
    if (kind === "project-session") root.sessionRegistry.load(session.sessionId, projectPath);
    applyConversationSnapshot(
      kind === "project-session"
        ? models.projectConversation(session.sessionId, projectPath)
        : models.cakeChatConversation(session.sessionId),
      conversation(session.sessionId),
    );
  }
  const common = {
    store: root.sidebarStore,
    sessionList: root.sidebarStore.sessionListStore,
    shell: root.appShellStore,
    resolved: false,
  };
  const view = render(
    kind === "project-session" ? (
      <SidebarProjectGroup
        {...common}
        sessionMetadata={root.sessionMetadataStore}
        projects={root.projectCatalogStore}
        chat={root.projectWorkbenchStore}
        appearance={root.settingsStore.appearance}
        path={projectPath}
        flattenSessions
        onCreateSession={(path) => void root.createSession(path)}
        onOpenSession={(id) => void root.openSession(id)}
        onRemoveProject={(path, deleteSessions) =>
          root.projectRemovalStore.remove(path, deleteSessions)
        }
        onOpenSettings={(path) => root.projectSettingsStore.open(path)}
      />
    ) : (
      <SidebarCakeChatGroup
        {...common}
        cakeChat={root.cakeChatCollectionStore}
        onOpenCakeChat={(id) => void root.openCakeChat(id)}
        onCreateCakeChat={() => void root.startCakeChat()}
      />
    ),
  );
  return {
    user: userEvent.setup(),
    resolve,
    finishResolve() {
      act(() => completeResolve());
    },
    publish(sessions: SessionSummaryFixture[]) {
      act(() => {
        if (kind === "project-session")
          applySnapshot(models.sessionCatalog, { sessions, resolvedHasMoreByProject: {} });
        else applySnapshot(models.cakeChatCatalog, { loaded: true, sessions });
      });
    },
    order: () =>
      [...view.container.querySelectorAll(".session-item")].map((row) =>
        row.getAttribute("data-session-id"),
      ),
    selected: () =>
      view.container
        .querySelector('[data-navigation-active="true"]')
        ?.getAttribute("data-session-id"),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

for (const kind of ["project-session", "cake-chat"] as const) {
  describe(`${kind} sidebar order`, () => {
    // Cake Chat retirement requires its resolved projection before it navigates away.
    const timings =
      kind === "project-session" ? (["before", "after"] as const) : (["before"] as const);
    it.each(timings)(
      "keeps the previous session in date order when resolution projects %s fallback navigation",
      async (timing) => {
        using fixture = renderOrdering(kind);
        await fixture.user.click(screen.getByRole("button", { name: /^previous / }));
        await fixture.user.click(screen.getByRole("button", { name: /^newer / }));
        expect(fixture.selected()).toBe("newer");
        await fixture.user.click(screen.getByRole("button", { name: "Resolve newer" }));
        expect(fixture.resolve).toHaveBeenCalledOnce();
        const resolved = initialSessions.map((session) => ({
          ...session,
          resolved: session.sessionId === "newer",
        }));
        if (timing === "before") fixture.publish(resolved);
        fixture.finishResolve();
        await waitFor(() => expect(fixture.selected()).toBe("previous"));
        if (timing === "after") fixture.publish(resolved);
        expect(fixture.order()).toEqual(["previous", "older", "oldest"]);
        await fixture.user.click(screen.getByRole("button", { name: /^older / }));
        expect(fixture.selected()).toBe("older");
        expect(fixture.order()).toEqual(["previous", "older", "oldest"]);
      },
    );

    it("pins transcript updates but only reserves slots for preceding rows still in the lane", async () => {
      using fixture = renderOrdering(kind);
      await fixture.user.click(screen.getByRole("button", { name: /^previous / }));
      const updated = initialSessions.map((session) =>
        session.sessionId === "previous"
          ? { ...session, modifiedAt: "2026-02-01T00:00:00.000Z" }
          : session,
      );
      fixture.publish(updated);
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      // Removing a row below the selection must not move its pin upward.
      fixture.publish(updated.filter((session) => session.sessionId !== "oldest"));
      expect(fixture.order()).toEqual(["newer", "previous", "older"]);
      // A resolved row above the selection must stop reserving a slot.
      fixture.publish(
        updated
          .filter((session) => session.sessionId !== "oldest")
          .map((session) => ({ ...session, resolved: session.sessionId === "newer" })),
      );
      expect(fixture.order()).toEqual(["previous", "older"]);
      await fixture.user.click(screen.getByRole("button", { name: /^older / }));
      expect(fixture.order()).toEqual(["previous", "older"]);
    });

    it("releases the transcript-update pin on deselection", async () => {
      using fixture = renderOrdering(kind);
      await fixture.user.click(screen.getByRole("button", { name: /^previous / }));
      fixture.publish(
        initialSessions.map((session) =>
          session.sessionId === "previous"
            ? { ...session, modifiedAt: "2026-02-01T00:00:00.000Z" }
            : session,
        ),
      );
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      await fixture.user.click(screen.getByRole("button", { name: /^oldest / }));
      expect(fixture.order()).toEqual(["previous", "newer", "older", "oldest"]);
    });
  });
}
