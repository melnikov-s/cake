/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TurnId,
  type ConversationEvent,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
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
function renderOrdering() {
  let completeResolve!: () => void;
  const resolving = new Promise<void>((complete) => {
    completeResolve = complete;
  });
  const resolve = vi.fn(async () => resolving);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    sessions: initialSessions,
    client: {
      projectSessions: { open: async () => undefined, resolve },
    },
  });
  const { root, models } = fixture;
  for (const session of initialSessions) {
    root.sessionRegistry.load(session.sessionId, projectPath);
    applyConversationSnapshot(
      models.projectConversation(session.sessionId, projectPath),
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
    <SidebarProjectGroup
      {...common}
      sessionMetadata={root.sessionMetadataStore}
      projects={root.projectCatalogStore}
      chat={root.projectWorkbenchStore}
      appearance={root.settingsStore.appearance}
      path={projectPath}
      flattenSessions
      onCreateSession={(path) => void root.navigationStore.createSession(path)}
      onOpenSession={(id) => void root.navigationStore.openSession(id)}
      onRemoveProject={(path, deleteSessions) =>
        root.projectRemovalStore.remove(path, deleteSessions)
      }
      onOpenSettings={(path) => root.projectSettingsStore.open(path)}
    />,
  );
  let eventRevision = 0;
  return {
    user: userEvent.setup(),
    publishEvent(event: Exclude<ConversationEvent, { _tag: "SnapshotUpdated" }>) {
      act(() =>
        applyConversationUpdate(models.projectConversation(event.sessionId, projectPath), {
          _tag: "Event",
          revision: ++eventRevision,
          event,
        }),
      );
    },
    resolve,
    finishResolve() {
      act(() => completeResolve());
    },
    publish(sessions: SessionSummaryFixture[]) {
      act(() => {
        applySnapshot(models.sessionCatalog, { sessions, resolvedHasMoreByProject: {} });
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

for (const kind of ["project-session"] as const) {
  describe(`${kind} sidebar order`, () => {
    it.each(["complete", "failed", "aborted"] as const)(
      "shows accepted work before streaming and clears running when Pi stops before %s bookkeeping",
      async (outcome) => {
        using fixture = renderOrdering();
        const sessionId = "previous";
        const turnId = TurnId.make("20000000-0000-4000-8000-000000000001");
        const running = () => screen.queryByRole("img", { name: "Running" });
        await fixture.user.click(screen.getByRole("button", { name: /^previous / }));
        expect(running()).toBeNull();
        // A queued follow-up is not work that Pi has begun processing.
        fixture.publishEvent({
          _tag: "TurnAccepted",
          sessionId,
          turnId: TurnId.make("20000000-0000-4000-8000-000000000002"),
          delivery: "follow-up",
        });
        expect(running()).toBeNull();
        fixture.publishEvent({ _tag: "TurnAccepted", sessionId, turnId, delivery: "prompt" });
        expect(running()).not.toBeNull();
        await fixture.user.click(screen.getByRole("button", { name: /^older / }));
        expect(running()).not.toBeNull();
        fixture.publishEvent({ _tag: "StreamingChanged", sessionId, streaming: true });
        expect(running()).not.toBeNull();
        fixture.publishEvent({ _tag: "StreamingChanged", sessionId, streaming: false });
        // Pi has stopped; delayed correlation bookkeeping is not agent work.
        expect(running()).toBeNull();
        fixture.publishEvent({ _tag: "TurnSettled", sessionId, turnId, outcome });
        expect(running()).toBeNull();
      },
    );

    const timings = ["before", "after"] as const;
    it.each(timings)(
      "keeps the previous session in date order when resolution projects %s fallback navigation",
      async (timing) => {
        using fixture = renderOrdering();
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
      using fixture = renderOrdering();
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
      using fixture = renderOrdering();
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
