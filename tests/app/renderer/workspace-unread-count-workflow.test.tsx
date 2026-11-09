/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { CakeChatSummary } from "../../../src/renderer/models/CakeChatSummary";
import { applySessionSignalsUpdate } from "../../../src/renderer/reducers/SessionSignalsReducer";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { ActivityCount } from "../../../src/renderer/components/ui/activity-count";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import {
  navigatorHomeId,
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";

afterEach(cleanup);

function renderWorkspace(large = false) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: navigatorProjectPath }), projectRecord({ path: "/other" })],
    sessions: [
      ...navigatorSessions,
      sessionSummary({
        sessionId: "resolved",
        projectPath: navigatorProjectPath,
        resolved: true,
        unread: true,
      }),
      ...(large
        ? Array.from({ length: 100 }, (_, index) =>
            sessionSummary({
              sessionId: `extra-${index}`,
              projectPath: navigatorProjectPath,
              running: true,
              unread: true,
            }),
          )
        : []),
    ],
    client: { workspaces: { loadStagedSlashCommands: async () => [] } },
  });
  populateConversationNavigationFixture(fixture.models);
  fixture.root.navigationStore.selectCakeChat(navigatorHomeId);
  const view = render(
    <StrictMode>
      <StoreProvider store={fixture.root}>
        <WorkspaceNavigator />
      </StoreProvider>
    </StrictMode>,
  );
  return {
    ...fixture,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

const tab = () => screen.getByRole("button", { name: /^Sessions ·/ });

function expectCounts(running: number, unread: number) {
  expect(tab().getAttribute("aria-label")).toBe(`Sessions · ${running} running · ${unread} unread`);
  expect(tab().getAttribute("title")).toContain(`${running} running · ${unread} unread ·`);
  expect(within(tab()).getByRole("img", { name: `${running} running` })).toBeTruthy();
  const unreadBadge = within(tab()).queryByRole("img", { name: `${unread} unread` });
  if (unread) {
    expect(unreadBadge?.getAttribute("title")).toBe(`${unread} unread`);
    expect(unreadBadge?.textContent).toBe(unread > 99 ? "99+" : String(unread));
    expect(unreadBadge?.className).toContain("text-success");
  } else expect(unreadBadge).toBeNull();
}

describe("Workspace Sessions running count", () => {
  it.each([
    { signalsLoaded: false, liveHome: false },
    { signalsLoaded: true, liveHome: false },
    { signalsLoaded: false, liveHome: true },
    { signalsLoaded: true, liveHome: true },
  ])(
    "excludes permanent chats but preserves own and grouped activity ($signalsLoaded / $liveHome)",
    async ({ signalsLoaded, liveHome }) => {
      using fixture = renderWorkspace();
      const { models, root } = fixture;
      const home = models.cakeChatCatalog.find(navigatorHomeId)!;
      const global = models.cakeChatCatalog.find(CAKE_CHAT_SESSION_ID)!;
      const otherHomeId = `project-chat:${"b".repeat(64)}`;
      const publishSignals = () => {
        if (signalsLoaded)
          applySessionSignalsUpdate(models.sessionCatalog, {
            _tag: "Snapshot",
            sessions: models.sessionCatalog.sessions
              .filter((session) => !session.resolved)
              .map((session) => ({
                sessionId: session.sessionId,
                projectPath: session.projectPath,
                workingDirectory: session.workingDirectory,
                running: session.running,
                unread: session.unread,
                familyParentSessionId: session.familyParentSessionId,
              })),
          });
      };
      const setHomeRunning = (running: boolean) => {
        home.running = !liveHome && running;
        models.cakeChatConversation(navigatorHomeId).streaming = liveHome && running;
      };
      act(() => {
        models.cakeChatCatalog.sessions.push(
          CakeChatSummary.create({
            sessionId: otherHomeId,
            projectPath: "/other",
            title: "other / Project Chat",
            running: true,
            unread: true,
          }),
        );
        setHomeRunning(true);
        global.running = true;
        global.unread = true;
        models.sessionCatalog.find("elsewhere")!.running = false;
        publishSignals();
      });
      expectCounts(0, 0);
      expect(within(tab()).getByRole("img", { name: "0 running" }).textContent).toBe("0");
      expect(tab().getAttribute("title")).toBe("0 running · 0 unread · 5 total in this project");
      await userEvent.setup().click(tab());
      const homeRow = () =>
        document.querySelector<HTMLElement>(
          `[data-slot="conversation-navigator-row"][data-session-id="${navigatorHomeId}"]`,
        )!;
      expect(homeRow().dataset.working).toBe("true");
      expect(within(homeRow()).getByRole("img", { name: "Running" })).toBeTruthy();

      act(() => {
        models.sessionCatalog.find("layout")!.running = true;
        models.sessionCatalog.find("layout")!.unread = true;
        // Catalog and live activity for one identity must not double-count.
        root.sessionRegistry.load("layout", navigatorProjectPath);
        models.projectConversation("layout", navigatorProjectPath).streaming = true;
        publishSignals();
      });
      expectCounts(1, 1);
      act(() => {
        setHomeRunning(false);
        home.unread = true;
      });
      expectCounts(1, 2);
      expect(homeRow().dataset.working).toBe("true");
      expect(within(homeRow()).getByRole("img", { name: "Ready, unread" })).toBeTruthy();
      act(() => {
        for (const id of ["keyboard", "deep-child"]) models.sessionCatalog.find(id)!.running = true;
        publishSignals();
      });
      expectCounts(3, 2);

      act(() => {
        setHomeRunning(true);
        root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
      });
      expectCounts(3, 4);
      expect(tab().getAttribute("title")).toBe("3 running · 4 unread · 8 total in all projects");
      act(() => {
        models.sessionCatalog.find("elsewhere")!.running = true;
        publishSignals();
      });
      expectCounts(4, 4);
      // Ordinary work-session badges still show their own status.
      const workRow = document.querySelector<HTMLElement>(
        '[data-slot="conversation-navigator-row"][data-session-id="layout"]',
      )!;
      expect(within(workRow).getByRole("img", { name: "Running" })).toBeTruthy();
    },
  );
});

describe("Workspace Sessions unread count", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("presents running=%s and unread=%s while To-dos is selected", (running, unread) => {
    using fixture = renderWorkspace();
    act(() => {
      const session = fixture.models.sessionCatalog.find("layout")!;
      session.running = running;
      session.unread = unread;
    });
    expectCounts(Number(running), Number(unread));
    expect(tab().getAttribute("aria-pressed")).toBe("false");
    expect(tab().getAttribute("title")).toContain("5 total in this project");
  });

  it("reacts to catalog read/new-message events without transcript reads or new session materialization", () => {
    using fixture = renderWorkspace();
    const load = vi.spyOn(fixture.root.sessionRegistry, "load");
    const session = fixture.models.sessionCatalog.find("layout")!;
    const update = (unread: boolean, revision: number) =>
      act(() => {
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath: navigatorProjectPath, resolved: false },
          {
            _tag: "Event",
            revision,
            event: {
              _tag: "ActivityChanged",
              sessionId: session.sessionId,
              running: false,
              unread,
            },
          },
        );
      });
    expectCounts(0, 0);
    update(true, 1);
    expectCounts(0, 1);
    update(false, 2);
    expectCounts(0, 0);
    update(true, 3);
    expectCounts(0, 1);
    expect(load).not.toHaveBeenCalled();
    expect(fixture.models.projectConversations).toHaveLength(0);
  });

  it("preserves own-unread semantics and scopes counts independently of filtering, collapse and pagination", () => {
    using fixture = renderWorkspace(true);
    const navigator = fixture.root.conversationNavigatorStore;
    act(() => {
      fixture.models.sessionCatalog.find("deep-child")!.unread = true;
      fixture.models.sessionCatalog.find("elsewhere")!.unread = true;
      fixture.models.cakeChatCatalog.find(CAKE_CHAT_SESSION_ID)!.unread = true;
      navigator.setQuery(navigatorProjectPath, "no match");
      navigator.collapseAll(navigatorProjectPath);
    });
    expect(navigator.rows(navigatorProjectPath)).toHaveLength(0);
    expectCounts(100, 100);
    expect(fixture.models.cakeChatCatalog.find(navigatorHomeId)!.unread).toBe(false);
    expect(fixture.models.sessionCatalog.find("layout")!.unread).toBe(false);
    act(() => {
      fixture.models.cakeChatCatalog.find(navigatorHomeId)!.unread = true;
    });
    expectCounts(100, 101);
    act(() => {
      fixture.models.cakeChatCatalog.find(navigatorHomeId)!.unread = false;
      fixture.root.sidebarStore.sessionListStore.showMoreSessions(navigatorProjectPath);
    });
    expectCounts(100, 100);
    act(() => fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID));
    expectCounts(101, 102);
    expect(tab().getAttribute("title")).toContain("107 total in all projects");
  });

  it("ignores child-only unread, including collapsed descendants, without losing inherited running status", () => {
    using fixture = renderWorkspace();
    const navigator = fixture.root.conversationNavigatorStore;
    act(() => {
      for (const id of ["keyboard", "deep-child"])
        fixture.models.sessionCatalog.find(id)!.unread = true;
      fixture.models.sessionCatalog.find("deep-child")!.running = true;
      fixture.root.workspaceNavigatorStore.show("sessions");
      navigator.toggleExpanded(navigatorProjectPath, "session:layout");
    });
    expectCounts(1, 0);
    const row = document.querySelector<HTMLElement>(
      '[data-slot="conversation-navigator-row"][data-session-id="layout"]',
    )!;
    expect(within(row).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(fixture.models.sessionCatalog.find("layout")!.unread).toBe(false);
    expect(fixture.models.cakeChatCatalog.find(navigatorHomeId)!.unread).toBe(false);
  });

  it("counts exactly the parents' own unread and excludes resolved and other-project rows", () => {
    using fixture = renderWorkspace();
    act(() => {
      for (const id of ["layout", "icons", "keyboard", "deep-child", "resolved", "elsewhere"])
        fixture.models.sessionCatalog.find(id)!.unread = true;
    });
    expectCounts(0, 2);
    act(() => {
      fixture.models.sessionCatalog.find("layout")!.unread = false;
      fixture.models.sessionCatalog.find("icons")!.resolved = true;
      fixture.root.sidebarStore.sessionListStore.toggleResolvedGroupExpanded(navigatorProjectPath);
    });
    expectCounts(0, 0);
  });

  it("caps both large indicators but keeps exact accessible values", () => {
    using fixture = renderWorkspace(true);
    expectCounts(100, 100);
    expect(within(tab()).getAllByText("99+")).toHaveLength(2);
  });

  it("server-renders exact unread labels and hides zero", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(<ActivityCount kind="unread" count={0} />)).toBe("");
    expect(renderToStaticMarkup(<ActivityCount kind="unread" count={1234} />)).toContain(
      'aria-label="1234 unread"',
    );
  });
});
