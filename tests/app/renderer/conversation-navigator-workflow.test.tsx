/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { conversationNavigationKey } from "../../../src/renderer/lib/conversation-navigation-tree";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";
import {
  navigatorHomeId,
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

function renderNavigator(
  projectPath: string | undefined = navigatorProjectPath,
  coldSideChat = false,
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: navigatorProjectPath }), projectRecord({ path: "/other" })],
    sessions: navigatorSessions,
    client: {
      projectSessions: { open: async () => undefined },
      cakeChats: { open: async () => undefined },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  const facts = populateConversationNavigationFixture(fixture.models);
  const catalog = fixture.models.discussionCatalog("layout");
  const thread = catalog.threads[0]!;
  const savedThread = {
    id: thread.id,
    parentSessionId: thread.parentSessionId,
    sidecarSessionId: thread.sidecarSessionId,
    workingDirectory: thread.workingDirectory,
    anchor: thread.anchor,
    parts: [],
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  if (coldSideChat) {
    catalog.metadata.push({
      id: savedThread.id,
      parentSessionId: savedThread.parentSessionId,
      sidecarSessionId: savedThread.sidecarSessionId,
      workingDirectory: savedThread.workingDirectory,
      title: "Pane widths",
      running: false,
      status: "open",
      createdAt: savedThread.createdAt,
      updatedAt: savedThread.updatedAt,
    });
    catalog.metadataLoaded = true;
    catalog.threads.splice(0, catalog.threads.length);
  }
  // These are the actual projected facts, not hand-assembled Store/component state.
  for (const session of navigatorSessions) {
    fixture.root.sessionRegistry.load(session.sessionId, session.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(session.sessionId, session.workingDirectory),
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: session.sessionId,
          sessionFile: `/sessions/${session.sessionId}.jsonl`,
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
        },
      },
    );
  }
  fixture.root.navigationStore.selectCakeChat(navigatorHomeId);
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationNavigator projectPath={projectPath} />
      <SideChatsMenu store={{ sessionId: "layout" }} />
    </StoreProvider>,
  );
  return {
    ...fixture,
    ...facts,
    savedThread,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-slot="conversation-navigator-row"]') as HTMLElement;

describe("Sessions navigator workflow", () => {
  it("renders a dense recursive source-list with true family edges and an idle parent's collapsed running descendants", async () => {
    using fixture = renderNavigator();
    expect(screen.getByText("5 total")).toBeTruthy();
    expect(rowFor("UI Layout Refactor").dataset.relationship).toBe("grouped");
    expect(rowFor("Keyboard Editing & Navigation").dataset.relationship).toBe("family-child");
    expect(rowFor("Nested child implementation").dataset.depth).toBe("3");
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).queryByText("Pane widths"),
    ).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Side chats and subagents, 4" }));
    const menu = within(screen.getByRole("dialog", { name: "Open side chats" }));
    expect(menu.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Side chats",
      "Subagents",
    ]);
    expect(menu.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Pane widths",
      "Breadcrumb audit",
      "Icon and tooltip audit",
      "Dense tree review",
    ]);
    expect(menu.queryByText("Shortcut review")).toBeNull();
    await fixture.user.keyboard("{Escape}");
    await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
    expect(screen.queryByRole("button", { name: /^Nested child implementation/ })).toBeNull();
    act(() => {
      fixture.models.sessionCatalog.find("deep-child")!.running = true;
    });
    expect(
      within(rowFor("UI Layout Refactor")).getByLabelText("1 running descendants"),
    ).toBeTruthy();
    expect(within(rowFor("UI Layout Refactor")).getByLabelText("Idle")).toBeTruthy();
    expect(within(rowFor("UI Layout Refactor")).queryByRole("img", { name: "Running" })).toBeNull();
    // Authority updates change counts even while the branch is closed.
    act(() => {
      fixture.models.sessionCatalog.find("keyboard")!.running = true;
    });
    expect(
      within(rowFor("UI Layout Refactor")).getByLabelText("2 running descendants"),
    ).toBeTruthy();
  });

  it.each(["button", "Escape"] as const)(
    "preserves matching ancestors during search and restores prior disclosure on %s",
    async (clear) => {
      using fixture = renderNavigator();
      await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
      await fixture.user.type(
        screen.getByRole("searchbox", { name: "Search sessions" }),
        "Nested child implementation",
      );
      expect(screen.getByRole("button", { name: /^Nested child implementation/ })).toBeTruthy();
      expect(rowFor("cake")).toBeTruthy();
      expect(rowFor("UI Layout Refactor")).toBeTruthy();
      expect(rowFor("Keyboard Editing & Navigation")).toBeTruthy();
      expect(rowFor("Nested child implementation")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Icon Placement Exploration" })).toBeNull();
      if (clear === "button")
        await fixture.user.click(screen.getByRole("button", { name: "Clear search sessions" }));
      else await fixture.user.keyboard("{Escape}");
      expect(screen.getByRole("searchbox", { name: "Search sessions" })).toHaveProperty(
        "value",
        "",
      );
      expect(
        screen
          .getByRole("button", { name: "Expand UI Layout Refactor" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      expect(screen.queryByRole("button", { name: /^Nested child implementation/ })).toBeNull();
      expect(rowFor("Icon Placement Exploration")).toBeTruthy();
    },
  );

  it("retains a cold Side chat selection until its full catalog arrives, without a second click", async () => {
    using fixture = renderNavigator(navigatorProjectPath, true);
    const catalog = fixture.models.discussionCatalog("layout");
    expect(catalog.threads).toHaveLength(0);
    await fixture.user.click(screen.getByRole("button", { name: "Side chats and subagents, 4" }));
    await fixture.user.click(screen.getByRole("button", { name: "Pane widths" }));
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("layout"),
    );
    expect(
      fixture.root.workspaceSession?.conversationSessionStore.sideChatStore.target,
    ).toBeUndefined();
    act(() =>
      applyDiscussionCatalogUpdate(catalog, "layout", {
        _tag: "Snapshot",
        revision: 2,
        parentSessionId: "layout",
        threads: [fixture.savedThread],
      }),
    );
    await waitFor(() =>
      expect(
        fixture.root.workspaceSession?.conversationSessionStore.sideChatStore.target?.key,
      ).toBe("discussion:widths"),
    );
    expect(rowFor("UI Layout Refactor").dataset.navigationActive).toBe("true");
    expect(
      fixture.root.conversationNavigatorStore.lineageFor("layout").map((node) => node.title),
    ).toEqual(["cake", "UI Layout Refactor"]);
  });

  it("opens a real child Session and reveals its selected ancestry after an external deep link", async () => {
    using fixture = renderNavigator();
    await fixture.user.click(screen.getByRole("button", { name: /^Nested child implementation/ }));
    await waitFor(() =>
      expect(rowFor("Nested child implementation").dataset.navigationActive).toBe("true"),
    );
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("deep-child");
    expect(
      fixture.root.conversationNavigatorStore
        .lineageFor("deep-child")
        .map((node) => node.target.sessionId),
    ).toEqual([navigatorHomeId, "layout", "keyboard", "deep-child"]);
    await fixture.user.click(screen.getByRole("button", { name: "Collapse UI Layout Refactor" }));
    await fixture.user.click(screen.getByRole("button", { name: /^Icon Placement Exploration/ }));
    await waitFor(() =>
      expect(rowFor("Icon Placement Exploration").dataset.navigationActive).toBe("true"),
    );
    // Same authoritative app-deep-link entry point used by session links/notifications.
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("deep-child");
    });
    expect(rowFor("Nested child implementation").dataset.navigationActive).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Collapse UI Layout Refactor" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(rowFor("Nested child implementation").dataset.conversationKey).toBe(
      conversationNavigationKey("deep-child"),
    );
  });
});
