/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
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
