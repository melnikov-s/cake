/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Queue, Stream, type Schema } from "effect";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogUpdate } from "../../../src/contracts/application/catalog-data";
import type { surfaceEventSchema } from "../../../src/contracts/application/cake-rpc-contract";
import type { Client } from "../../../src/renderer/client/Client";
import {
  TurnId,
  type ConversationEvent,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { observeSurfaceEvents } from "../../../src/renderer/observers/surface-events";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import {
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { observerClient, observerRuntime } from "./observers/observer-test-runtime";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectPath = "/project";
const initialSessions = ["newer", "previous", "older", "oldest"].map((sessionId, index) =>
  sessionSummary({
    sessionId,
    projectPath,
    createdAt: new Date(Date.UTC(2026, 0, 4 - index)).toISOString(),
    modifiedAt: new Date(Date.UTC(2026, 0, 4 - index)).toISOString(),
  }),
);
const withUnreadOlder = initialSessions.map((session) =>
  session.sessionId === "older"
    ? { ...session, unread: true, latestTurnOutcome: "complete" as const }
    : session,
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
function renderOrdering(sessions: SessionSummaryFixture[] = initialSessions) {
  let completeResolve!: () => void;
  const resolving = new Promise<void>((complete) => {
    completeResolve = complete;
  });
  const resolve = vi.fn(async () => resolving);
  let eventRevision = 0;
  const publishCatalogEvent = (event: Extract<SessionCatalogUpdate, { _tag: "Event" }>["event"]) =>
    act(() =>
      applySessionCatalogGroupUpdate(
        models.sessionCatalog,
        { projectPath, resolved: false },
        { _tag: "Event", revision: ++eventRevision, event },
      ),
    );
  const respondFlush = vi.fn<Client["windowState"]["respondFlush"]>(async () => undefined);
  // The backend persists the flag and projects it back through the catalog.
  const setSessionUnread = vi.fn<Client["workspaces"]["setSessionUnread"]>(
    async (sessionId, unread) => {
      publishCatalogEvent({ _tag: "StatusChanged", sessionId, resolved: false, unread });
      return {} as never;
    },
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    sessions,
    client: {
      projectSessions: { open: async () => undefined, resolve },
      workspaces: { setSessionUnread },
      windowState: { respondFlush },
    },
  });
  const { root, models } = fixture;
  for (const session of sessions) {
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
    <StoreProvider store={root}>
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
      />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  const selected = () =>
    view.container
      .querySelector('[data-navigation-active="true"]')
      ?.getAttribute("data-session-id");
  return {
    user,
    async openSession(sessionId: string) {
      await user.click(screen.getByRole("button", { name: new RegExp(`^${sessionId} `) }));
      await waitFor(() => expect(selected()).toBe(sessionId));
    },
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
      publishCatalogEvent({
        _tag: "ActivityChanged",
        sessionId: "previous",
        running,
        workingStartedAt,
      });
    },
    publishCatalogEvent,
    setSessionUnread,
    respondFlush,
    root,
    status: (sessionId: string) =>
      within(view.container.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`)!)
        .queryByRole("img")
        ?.getAttribute("aria-label"),
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
    selected,
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
        await fixture.openSession("previous");
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
        await fixture.openSession("older");
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
      expect(fixture.order()).toEqual(["previous", "newer", "older", "oldest"]);
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
        await fixture.openSession("previous");
        await fixture.openSession("newer");
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
        await fixture.openSession("older");
        expect(fixture.selected()).toBe("older");
        expect(fixture.order()).toEqual(["previous", "older", "oldest"]);
      },
    );

    it("keeps a selected unread row in place and unread until the user leaves it", async () => {
      using fixture = renderOrdering(withUnreadOlder);
      expect(fixture.order()).toEqual(["older", "newer", "previous", "oldest"]);
      await fixture.openSession("older");
      expect(fixture.order()).toEqual(["older", "newer", "previous", "oldest"]);
      expect(fixture.status("older")).toBe("Ready, unread");
      expect(fixture.setSessionUnread).not.toHaveBeenCalled();
      // Leaving is what reads it; only then does it take its normal place.
      await fixture.openSession("newer");
      expect(fixture.setSessionUnread).toHaveBeenCalledExactlyOnceWith(
        "older",
        false,
        expect.anything(),
      );
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      expect(fixture.status("older")).toBeUndefined();
    });

    it("reads a turn the user watches finish without moving the selected row", async () => {
      using fixture = renderOrdering();
      await fixture.openSession("previous");
      fixture.publishCatalogEvent({
        _tag: "ActivityChanged",
        sessionId: "previous",
        running: true,
      });
      expect(fixture.status("previous")).toBe("Running");
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      fixture.publishCatalogEvent({
        _tag: "ActivityChanged",
        sessionId: "previous",
        running: false,
        latestTurnOutcome: "complete",
        unread: true,
      });
      expect(fixture.setSessionUnread).toHaveBeenCalledExactlyOnceWith(
        "previous",
        false,
        expect.anything(),
      );
      expect(fixture.status("previous")).toBeUndefined();
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      await fixture.openSession("older");
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
    });

    it("moves a selected row that started working only after the user leaves it", async () => {
      using fixture = renderOrdering();
      await fixture.openSession("older");
      fixture.publishCatalogEvent({ _tag: "ActivityChanged", sessionId: "older", running: true });
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      await fixture.openSession("newer");
      expect(fixture.order()).toEqual(["older", "newer", "previous", "oldest"]);
      // Finishing unseen in the background makes it unread, at the top.
      fixture.publishCatalogEvent({
        _tag: "ActivityChanged",
        sessionId: "older",
        running: false,
        latestTurnOutcome: "complete",
        unread: true,
      });
      expect(fixture.status("older")).toBe("Ready, unread");
      expect(fixture.order()).toEqual(["older", "newer", "previous", "oldest"]);
      expect(fixture.setSessionUnread).not.toHaveBeenCalled();
    });

    it("keeps an unread reminder set during the visit, and a later visit settles it", async () => {
      using fixture = renderOrdering();
      await fixture.openSession("previous");
      await act(() => fixture.root.sidebarStore.setSessionUnread("previous", true));
      expect(fixture.status("previous")).toBe("Ready, unread");
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      await fixture.openSession("older");
      expect(fixture.setSessionUnread.mock.calls.map(([id, unread]) => [id, unread])).toEqual([
        ["previous", true],
      ]);
      expect(fixture.order()).toEqual(["previous", "newer", "older", "oldest"]);
      await fixture.openSession("previous");
      expect(fixture.order()).toEqual(["previous", "newer", "older", "oldest"]);
      await fixture.openSession("older");
      expect(fixture.setSessionUnread.mock.calls.map(([id, unread]) => [id, unread])).toEqual([
        ["previous", true],
        ["previous", false],
      ]);
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
    });

    it("reads the selected session before the window saves for close or quit", async () => {
      using fixture = renderOrdering(withUnreadOlder);
      const events = Effect.runSync(
        Queue.unbounded<Schema.Schema.Type<typeof surfaceEventSchema>>(),
      );
      const runtime = observerRuntime(
        observerClient({ events: { surfaces: () => Stream.fromQueue(events) } }),
      );
      const cancel = observeSurfaceEvents(runtime, fixture.root);
      try {
        await fixture.openSession("older");
        expect(fixture.setSessionUnread).not.toHaveBeenCalled();
        Queue.offerUnsafe(events, { type: "window-state-flush-requested", requestId: "close" });
        await waitFor(() =>
          expect(fixture.respondFlush).toHaveBeenCalledExactlyOnceWith({ requestId: "close" }),
        );
        expect(fixture.setSessionUnread).toHaveBeenCalledExactlyOnceWith(
          "older",
          false,
          expect.anything(),
        );
        expect(fixture.setSessionUnread.mock.invocationCallOrder[0]).toBeLessThan(
          fixture.respondFlush.mock.invocationCallOrder[0]!,
        );
      } finally {
        cancel();
      }
    });

    it("holds a selected row's place when its timestamp changes, then sorts it by last update once left", async () => {
      using fixture = renderOrdering();
      await fixture.openSession("previous");
      fixture.publish(
        initialSessions.map((session) =>
          session.sessionId === "previous"
            ? { ...session, modifiedAt: "2026-02-01T00:00:00.000Z" }
            : session,
        ),
      );
      expect(fixture.order()).toEqual(["newer", "previous", "older", "oldest"]);
      expect(fixture.selected()).toBe("previous");
      await fixture.openSession("older");
      expect(fixture.order()).toEqual(["previous", "newer", "older", "oldest"]);
      expect(fixture.selected()).toBe("older");
    });

    it("holds a selected unread row's place when its timestamp changes", async () => {
      const unread = initialSessions.map((session) =>
        ["older", "oldest"].includes(session.sessionId)
          ? { ...session, unread: true, latestTurnOutcome: "complete" as const }
          : session,
      );
      using fixture = renderOrdering(unread);
      expect(fixture.order()).toEqual(["older", "oldest", "newer", "previous"]);
      await fixture.openSession("oldest");
      fixture.publish(
        unread.map((session) =>
          session.sessionId === "oldest"
            ? { ...session, modifiedAt: "2026-02-01T00:00:00.000Z" }
            : session,
        ),
      );
      expect(fixture.order()).toEqual(["older", "oldest", "newer", "previous"]);
      // Leaving reads it; it then leads the read rows by its latest update.
      await fixture.openSession("newer");
      expect(fixture.order()).toEqual(["older", "oldest", "newer", "previous"]);
      expect(fixture.status("oldest")).toBeUndefined();
      fixture.publishCatalogEvent({
        _tag: "StatusChanged",
        sessionId: "older",
        resolved: false,
        unread: false,
      });
      expect(fixture.order()).toEqual(["oldest", "newer", "previous", "older"]);
    });
  });
}
