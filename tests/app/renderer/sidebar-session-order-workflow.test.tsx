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
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
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
      cakeChat={root.cakeChatCollectionStore}
      onOpenCakeChat={(sessionId) => void root.navigationStore.openCakeChat(sessionId)}
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
    publishActivity(running: boolean, workingStartedAt: number | null) {
      act(() =>
        applySessionCatalogGroupUpdate(
          models.sessionCatalog,
          { projectPath, resolved: false },
          {
            _tag: "Event",
            revision: ++eventRevision,
            event: { _tag: "ActivityChanged", sessionId: "previous", running, workingStartedAt },
          },
        ),
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

for (const kind of ["project-session"] as const) {
  describe(`${kind} sidebar order`, () => {
    it.each(["complete", "failed", "aborted"] as const)(
      "shows accepted work before streaming and clears running when Pi stops before %s bookkeeping",
      async (outcome) => {
        using fixture = renderOrdering();
        const sessionId = "previous";
        const turnId = TurnId.make("20000000-0000-4000-8000-000000000001");
        const running = () => screen.queryByRole("img", { name: "Running" });
        const timestamp = () => document.querySelector(`[data-session-id="${sessionId}"] time`);
        await fixture.user.click(screen.getByRole("button", { name: /^previous / }));
        expect(running()).toBeNull();
        expect(timestamp()).not.toBeNull();
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
        expect(timestamp()?.textContent).toBe("Working");
        await fixture.user.click(screen.getByRole("button", { name: /^older / }));
        expect(running()).not.toBeNull();
        fixture.publishEvent({ _tag: "StreamingChanged", sessionId, streaming: true });
        expect(running()).not.toBeNull();
        fixture.publishEvent({ _tag: "StreamingChanged", sessionId, streaming: false });
        // Pi has stopped; delayed correlation bookkeeping is not agent work.
        expect(running()).toBeNull();
        expect(timestamp()).not.toBeNull();
        fixture.publishEvent({ _tag: "TurnSettled", sessionId, turnId, outcome });
        expect(running()).toBeNull();
      },
    );

    it("counts the authoritative working stretch across rerenders, restarts, completion and teardown", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
      const fixture = renderOrdering();
      const baselineTimers = vi.getTimerCount();
      const timestamp = () => document.querySelector('[data-session-id="previous"] time')!;
      const startedAt = Date.now() - 65_400;
      fixture.publishActivity(true, startedAt);
      expect(timestamp().textContent).toBe("Working 1m 5s");
      expect(timestamp().getAttribute("datetime")).toBe(new Date(startedAt).toISOString());
      expect(fixture.order()[0]).toBe("previous");
      expect(vi.getTimerCount()).toBe(baselineTimers + 1);
      act(() => vi.advanceTimersByTime(2_000));
      expect(timestamp().textContent).toBe("Working 1m 7s");
      // Catalog refresh rerenders the row without changing the current stretch.
      fixture.publish(
        initialSessions.map((session) =>
          session.sessionId === "previous"
            ? { ...session, title: "Renamed", running: true, workingStartedAt: startedAt }
            : session,
        ),
      );
      expect(timestamp().textContent).toBe("Working 1m 7s");
      fixture.publishActivity(false, null);
      expect(timestamp().getAttribute("datetime")).toBe(initialSessions[1]!.modifiedAt);
      expect(timestamp().textContent).not.toContain("Working");
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      expect(vi.getTimerCount()).toBe(baselineTimers);
      fixture.publishActivity(true, null);
      expect(timestamp().textContent).toBe("Working");
      expect(vi.getTimerCount()).toBe(baselineTimers);
      fixture.publishActivity(true, Date.now());
      expect(timestamp().textContent).toBe("Working 0s");
      act(() => vi.advanceTimersByTime(1_000));
      expect(timestamp().textContent).toBe("Working 1s");
      fixture[Symbol.dispose]();
      expect(vi.getTimerCount()).toBe(0);
    });

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

    it("moves selected inactive rows with recency without changing selection identity", async () => {
      using fixture = renderOrdering();
      await fixture.user.click(screen.getByRole("button", { name: /^previous / }));
      fixture.publish(
        initialSessions.map((session) =>
          session.sessionId === "previous"
            ? { ...session, modifiedAt: "2026-02-01T00:00:00.000Z" }
            : session,
        ),
      );
      expect(fixture.order()).toEqual(["previous", "newer", "older", "oldest"]);
      expect(fixture.selected()).toBe("previous");
      await fixture.user.click(screen.getByRole("button", { name: /^older / }));
      expect(fixture.order()).toEqual(["previous", "newer", "older", "oldest"]);
      expect(fixture.selected()).toBe("older");
    });
  });
}
