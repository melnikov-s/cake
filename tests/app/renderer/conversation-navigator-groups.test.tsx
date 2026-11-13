/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import {
  fixtureTimestamp,
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectPath = "/project";
const mine = (sessionId: string, extra: Partial<SessionSummaryFixture> = {}) =>
  sessionSummary({ sessionId, projectPath, purpose: "user", ...extra });
const delegated = (sessionId: string, extra: Partial<SessionSummaryFixture> = {}) =>
  sessionSummary({ sessionId, projectPath, purpose: "delegated", ...extra });
/** A delegated parent with one child: the group count includes both. */
const delegatedFamily = [
  delegated("lead", { familyId: "lead", familyChildSessionIds: ["helper"] }),
  delegated("helper", { familyId: "lead", familyParentSessionId: "lead" }),
];

const myFamily = [
  mine("mine", { familyId: "mine", familyChildSessionIds: ["child"] }),
  delegated("child", {
    familyId: "mine",
    familyParentSessionId: "mine",
    familyChildSessionIds: ["grandchild"],
  }),
  delegated("grandchild", {
    familyId: "mine",
    familyParentSessionId: "child",
    unread: true,
    latestTurnOutcome: "complete",
  }),
];

function renderGroups(sessions: SessionSummaryFixture[], resolvedTotal?: number, global = false) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath }), projectRecord({ path: "/other" })],
    sessions,
    client: { projectSessions: { open: async () => undefined } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: "project-chat",
        projectPath,
        title: "Project Chat",
        createdAt: fixtureTimestamp,
        modifiedAt: fixtureTimestamp,
        messageCount: 1,
        resolved: false,
        unread: false,
      },
    ],
  });
  // Openable rows: selection follows the opened conversation.
  for (const session of sessions) {
    fixture.root.sessionRegistry.load(session.sessionId, session.workingDirectory);
    applyConversationSnapshot(
      fixture.models.projectConversation(session.sessionId, session.workingDirectory),
      {
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
    );
  }
  if (resolvedTotal !== undefined)
    applySessionCatalogGroupUpdate(
      fixture.models.sessionCatalog,
      { projectPath, resolved: true },
      { _tag: "Snapshot", revision: 1, sessions: [], hasMore: true, total: resolvedTotal },
    );
  const mount = () =>
    render(
      <StoreProvider store={fixture.root}>
        <ConversationNavigator projectPath={global ? undefined : projectPath} />
      </StoreProvider>,
    );
  let view = mount();
  const active = () => within(screen.getByRole("region", { name: "Active sessions" }));
  return {
    fixture,
    user: userEvent.setup(),
    active,
    header: (name: string) => screen.getByRole("button", { name }),
    count: (name: string) =>
      screen.getByRole("button", { name }).querySelector('[data-slot="group-count"]')?.textContent,
    sessionIds: () =>
      [
        ...view.container.querySelectorAll(
          '[data-relationship="grouped"], [data-relationship="family-child"]',
        ),
      ].map((row) => row.getAttribute("data-session-id")),
    selected: () =>
      view.container
        .querySelector('[data-navigation-active="true"]')
        ?.getAttribute("data-session-id"),
    publish(session: SessionSummaryFixture) {
      act(() =>
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath, resolved: false },
          { _tag: "Event", revision: 1, event: { _tag: "Upserted", session } },
        ),
      );
    },
    remount() {
      view.unmount();
      view = mount();
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Conversation navigator session groups", () => {
  it.each([false, true])(
    "keeps a My session's delegated descendants in My sessions (global=%s)",
    async (global) => {
      using view = renderGroups(
        [
          ...myFamily,
          ...delegatedFamily.map((session) => ({
            ...session,
            cakeChatLaunch: { requesterSessionId: "project-chat" },
          })),
          delegated("global-assignment", {
            cakeChatLaunch: { requesterSessionId: CAKE_CHAT_SESSION_ID },
          }),
        ],
        undefined,
        global,
      );
      const ids = (name: string) =>
        [
          ...screen
            .getByRole("region", { name })
            .querySelectorAll('[data-slot="conversation-navigator-row"][data-session-id]'),
        ].map((row) => row.getAttribute("data-session-id"));
      expect(ids("My sessions")).toEqual(["mine", "child", "grandchild"]);
      expect(ids("Delegated")).toEqual(["global-assignment", "lead", "helper"]);
      expect(view.count("My sessions")).toBe("3");
      expect(view.count("Delegated")).toBe("3");
      // Grouping is presentation only: children retain their delegated purpose/relationship cues.
      expect(view.fixture.root.sessionCatalogStore.find("child")?.purpose).toBe("delegated");
      expect(
        within(screen.getByRole("region", { name: "My sessions" })).getAllByRole("img", {
          name: "Delegated Session",
        }),
      ).toHaveLength(2);

      await view.user.click(view.header("Delegated"));
      expect(view.sessionIds()).toEqual(["mine", "child", "grandchild"]);
      await view.user.click(view.header("My sessions"));
      expect(view.sessionIds()).toEqual([]);
      expect(
        within(view.header("My sessions")).getByRole("img", {
          name: "Ready, unread",
          hidden: true,
        }),
      ).toBeDefined();
      expect(within(view.header("Delegated")).queryByRole("img", { hidden: true })).toBeNull();

      // An external selection must reveal the inherited kind, not the child's own purpose.
      act(() => view.fixture.root.navigationStore.selectProjectSession("grandchild"));
      await waitFor(() => expect(view.selected()).toBe("grandchild"));
      expect(view.header("My sessions").getAttribute("aria-expanded")).toBe("true");
      expect(view.header("Delegated").getAttribute("aria-expanded")).toBe("false");
      expect(view.sessionIds()).toEqual(["mine", "child", "grandchild"]);

      await view.user.click(view.header("Delegated"));
      act(() =>
        view.fixture.root.conversationNavigatorStore.setQuery(
          global ? undefined : projectPath,
          "grandchild",
        ),
      );
      expect(ids("My sessions")).toEqual(["mine", "child", "grandchild"]);
      expect(view.active().queryByRole("region", { name: "Delegated" })).toBeNull();
    },
  );

  it("does not invent a Delegated group for the delegated children of the only My family", () => {
    using view = renderGroups(myFamily);
    expect(view.active().queryByRole("heading", { name: "Delegated" })).toBeNull();
    expect(view.active().queryByRole("heading", { name: "My sessions" })).toBeNull();
    expect(view.sessionIds()).toEqual(["mine", "child", "grandchild"]);
  });

  it.each([
    ["missing", []],
    ["resolved", [mine("mine", { resolved: true, familyChildSessionIds: ["child"] })]],
    [
      "another project",
      [mine("mine", { projectPath: "/other", familyChildSessionIds: ["child"] })],
    ],
  ])("uses a child's own purpose when its parent is %s in this list", (_, parents) => {
    using view = renderGroups([
      mine("independent"),
      ...parents,
      delegated("child", { familyParentSessionId: "mine" }),
    ]);
    expect(
      within(screen.getByRole("region", { name: "Delegated" })).getByText("child"),
    ).toBeDefined();
    expect(view.count("My sessions")).toBe("1");
    expect(view.count("Delegated")).toBe("1");
  });

  it("moves descendant counts and rows with their root's purpose changes", () => {
    using view = renderGroups([...myFamily, ...delegatedFamily]);
    view.publish(delegated("mine", { familyId: "mine", familyChildSessionIds: ["child"] }));
    expect(view.active().queryByRole("heading", { name: "My sessions" })).toBeNull();
    expect(
      view.fixture.root.sidebarStore.sessionListStore.activeSessionKindCounts(projectPath),
    ).toEqual({
      user: 0,
      delegated: 5,
    });
    view.publish(myFamily[0]!);
    expect(view.count("My sessions")).toBe("3");
    expect(view.count("Delegated")).toBe("2");
  });
  it("shows collapsible kind headers with quiet counts, including children, when both kinds are active", () => {
    using view = renderGroups([mine("mine-a"), mine("mine-b"), ...delegatedFamily], 7);
    expect(view.active().getByRole("heading", { name: "My sessions" })).toBeDefined();
    expect(view.active().getByRole("heading", { name: "Delegated" })).toBeDefined();
    expect(view.count("My sessions")).toBe("2");
    expect(view.count("Delegated")).toBe("2");
    expect(view.count("Resolved sessions")).toBe("7");
    expect(view.header("Delegated").getAttribute("aria-expanded")).toBe("true");
    expect(view.header("My sessions").getAttribute("aria-expanded")).toBe("true");
    expect(view.header("Delegated").getAttribute("aria-describedby")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Delegated" })).getAllByRole("img", {
        name: "Delegated Session",
      }).length,
    ).toBe(2);
  });

  it.each([
    ["delegated", [delegated("only-a"), delegated("only-b")]],
    ["user", [mine("only-a"), mine("only-b")]],
  ])("lists a single active %s kind directly under the Project without a header", (_, sessions) => {
    using view = renderGroups(sessions, 3);
    expect(view.active().queryByRole("heading", { name: "Delegated" })).toBeNull();
    expect(view.active().queryByRole("heading", { name: "My sessions" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Delegated" })).toBeNull();
    expect(view.sessionIds()).toEqual(["only-a", "only-b"]);
    // Resolved keeps its own header and count even as the only labelled group.
    expect(view.header("Resolved sessions").getAttribute("aria-expanded")).toBe("false");
    expect(view.count("Resolved sessions")).toBe("3");
  });

  it("collapses Delegated and My sessions per Project, remembers it, and surfaces hidden unread state", async () => {
    using view = renderGroups([
      mine("mine-a"),
      delegated("unread-work", { unread: true, latestTurnOutcome: "complete" }),
      delegated("quiet-work"),
    ]);
    const list = view.fixture.root.sidebarStore.sessionListStore;
    await view.user.click(view.header("Delegated"));
    expect(view.header("Delegated").getAttribute("aria-expanded")).toBe("false");
    expect(view.sessionIds()).toEqual(["mine-a"]);
    expect(view.count("Delegated")).toBe("2");
    expect(
      within(view.header("Delegated")).getByRole("img", { name: "Ready, unread", hidden: true }),
    ).toBeDefined();
    expect(list.isSessionKindGroupExpanded("/other", "delegated")).toBe(true);

    await view.user.click(view.header("My sessions"));
    expect(view.sessionIds()).toEqual([]);
    expect(view.header("My sessions").getAttribute("aria-expanded")).toBe("false");
    expect(within(view.header("My sessions")).queryByRole("img", { hidden: true })).toBeNull();

    view.remount();
    expect(view.header("Delegated").getAttribute("aria-expanded")).toBe("false");
    expect(view.header("My sessions").getAttribute("aria-expanded")).toBe("false");

    await view.user.click(view.header("My sessions"));
    expect(view.sessionIds()).toEqual(["mine-a"]);
    await view.user.click(view.header("Delegated"));
    expect(view.sessionIds()).toEqual(["mine-a", "unread-work", "quiet-work"]);
    expect(within(view.header("Delegated")).queryByRole("img", { hidden: true })).toBeNull();
  });

  it("keeps a paged-out kind header visible and lets a collapsed group stop spending the page", async () => {
    using view = renderGroups([
      ...Array.from({ length: 11 }, (_, index) => mine(`mine-${index}`)),
      delegated("work-a"),
    ]);
    expect(view.sessionIds()).toHaveLength(10);
    expect(view.count("Delegated")).toBe("1");
    expect(view.active().getByRole("button", { name: "Show more" })).toBeDefined();
    await view.user.click(view.header("My sessions"));
    expect(view.sessionIds()).toEqual(["work-a"]);
    expect(view.active().queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("brings labels back when the second kind appears, keeping the selection visible", async () => {
    using view = renderGroups([delegated("work-a"), delegated("work-b")]);
    await view.user.click(screen.getByRole("button", { name: /^work-b / }));
    await waitFor(() => expect(view.selected()).toBe("work-b"));
    const row = document.querySelector('[data-session-id="work-b"]');
    // A Delegated collapse remembered from earlier must not hide the selected row.
    act(() =>
      view.fixture.root.sidebarStore.sessionListStore.toggleSessionKindGroupExpanded(
        projectPath,
        "delegated",
      ),
    );
    view.publish(mine("mine-new"));
    expect(view.active().getByRole("heading", { name: "My sessions" })).toBeDefined();
    expect(view.header("Delegated").getAttribute("aria-expanded")).toBe("true");
    expect(view.selected()).toBe("work-b");
    // Stable group keys keep the existing row mounted rather than rebuilding it.
    expect(document.querySelector('[data-session-id="work-b"]')).toBe(row);
  });

  it("leaves the Resolved sessions disclosure collapsed by default and toggles it", async () => {
    using view = renderGroups([mine("mine-a"), delegated("work-a")], 4);
    const resolved = view.header("Resolved sessions");
    expect(resolved.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Resolved sessions" })).toBeNull();
    await view.user.click(resolved);
    expect(view.header("Resolved sessions").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "Resolved sessions" })).toBeDefined();
    expect(view.count("Resolved sessions")).toBe("4");
  });
});
