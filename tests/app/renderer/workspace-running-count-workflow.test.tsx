/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import {
  navigatorHomeId,
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";

afterEach(cleanup);

function renderWorkspace({ global = false, large = false } = {}) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: navigatorProjectPath }), projectRecord({ path: "/other" })],
    sessions: [
      ...navigatorSessions,
      sessionSummary({ sessionId: "resolved", projectPath: navigatorProjectPath, resolved: true }),
      ...(large
        ? Array.from({ length: 100 }, (_, index) =>
            sessionSummary({
              sessionId: `running-${index}`,
              projectPath: navigatorProjectPath,
              running: true,
            }),
          )
        : []),
    ],
    client: { workspaces: { loadStagedSlashCommands: async () => [] } },
  });
  populateConversationNavigationFixture(fixture.models);
  fixture.root.navigationStore.selectCakeChat(global ? CAKE_CHAT_SESSION_ID : navigatorHomeId);
  // Keep To-dos selected initially: running work must be visible without opening Sessions.
  const view = render(
    <StoreProvider store={fixture.root}>
      <WorkspaceNavigator />
    </StoreProvider>,
  );
  return {
    ...fixture,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

const sessionsTab = () =>
  within(screen.getByRole("group", { name: "Workspace content" })).getByRole("button", {
    name: /^Sessions /,
  });

function expectCount(count: number, visible = String(count)) {
  const tab = sessionsTab();
  expect(tab.getAttribute("aria-label")).toBe(`Sessions · ${count} running`);
  expect(tab.textContent).toBe(`Sessions ${visible}`);
  expect(tab.getAttribute("title")).toContain(`${count} running ·`);
  expect(within(tab).getByRole("img", { name: `${count} running` })).toBeTruthy();
}

describe("Workspace Sessions running count", () => {
  it.each([false, true])(
    "places the list directly after search without a summary/action row (global: %s)",
    async (global) => {
      using fixture = renderWorkspace({ global });
      const runningLabel = sessionsTab().getAttribute("aria-label");
      const runningTitle = sessionsTab().getAttribute("title");
      await fixture.user.click(sessionsTab());
      const panel = screen.getByRole("region", { name: "Sessions", exact: true });
      const search = within(panel).getByRole("searchbox", { name: "Search sessions" });
      const list = within(panel).getByLabelText("Session conversations");
      expect(within(panel).queryByText(/^\d+ (total|running)$/)).toBeNull();
      expect(within(panel).queryByRole("button", { name: "Collapse all" })).toBeNull();
      expect(panel.children).toHaveLength(2);
      expect(panel.firstElementChild?.contains(search)).toBe(true);
      expect(panel.firstElementChild?.nextElementSibling).toBe(list);
      await fixture.user.type(search, "no match");
      expect(within(list).getByText("No matching conversations")).toBeTruthy();
      await fixture.user.click(
        within(panel).getByRole("button", { name: "Clear search sessions" }),
      );
      expect(search).toHaveProperty("value", "");
      expect(within(list).queryByText("No matching conversations")).toBeNull();
      expect(sessionsTab().getAttribute("aria-label")).toBe(runningLabel);
      expect(sessionsTab().getAttribute("title")).toBe(runningTitle);
    },
  );

  it("counts scoped work once, independently of search and disclosure, and keeps totals separate", async () => {
    using fixture = renderWorkspace();
    expectCount(5);
    expect(sessionsTab().getAttribute("aria-pressed")).toBe("false");
    expect(sessionsTab().getAttribute("title")).toContain("15 total in this project");
    await fixture.user.click(sessionsTab());
    expect(screen.queryByText("15 total")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse cake" }));
    expectCount(5);
    await fixture.user.type(screen.getByRole("searchbox", { name: "Search sessions" }), "no match");
    expect(screen.getByText("No matching conversations")).toBeTruthy();
    expectCount(5);
  });

  it("reacts to own activity, inherited worker activity, release and idle without counting parents twice", () => {
    using fixture = renderWorkspace();
    const parent = fixture.models.projectConversation("layout", navigatorProjectPath);
    const catalog = fixture.models.subagentCatalog("layout");
    act(() => {
      applySubagentUpdate(catalog, "layout", {
        _tag: "Background",
        revision: 2,
        parentSessionId: "layout",
        active: true,
      });
    });
    expectCount(5); // An idle parent with active descendants is not another running session.
    act(() => {
      applyConversationUpdate(parent, {
        _tag: "Event",
        revision: 2,
        event: { _tag: "StreamingChanged", sessionId: "layout", streaming: true },
      });
    });
    expectCount(6); // A parent actually doing its own work does count.
    act(() => {
      applySubagentUpdate(catalog, "layout", {
        _tag: "Removed",
        revision: 3,
        parentSessionId: "layout",
        handleId: catalog.activities[0]!.handleId,
      });
    });
    expectCount(5);
    act(() => {
      applyConversationUpdate(parent, {
        _tag: "Event",
        revision: 3,
        event: { _tag: "StreamingChanged", sessionId: "layout", streaming: false },
      });
      for (const owner of ["layout", "keyboard", "focus-chat"])
        applySubagentUpdate(fixture.models.subagentCatalog(owner), owner, {
          _tag: "Snapshot",
          revision: 4,
          parentSessionId: owner,
          activities: [],
          backgroundActive: false,
        });
    });
    expectCount(0);
    expect(within(sessionsTab()).getByRole("img").className).toContain("text-muted-foreground");
    act(() => {
      applyConversationUpdate(parent, {
        _tag: "Event",
        revision: 4,
        event: { _tag: "StreamingChanged", sessionId: "layout", streaming: true },
      });
    });
    expectCount(1);
  });

  it("uses Cake Chat scope rather than aggregating unrelated projects", () => {
    using fixture = renderWorkspace({ global: true });
    expectCount(1);
    expect(sessionsTab().getAttribute("title")).toContain("3 total in Cake Chat");
  });

  it("caps large visible counts without losing the exact tooltip or accessible count", () => {
    using fixture = renderWorkspace({ large: true });
    expectCount(105, "99+");
    expect(sessionsTab().getAttribute("title")).toContain("115 total in this project");
  });
});
