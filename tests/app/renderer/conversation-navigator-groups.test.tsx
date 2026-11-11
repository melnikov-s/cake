/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
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

function renderGroups(sessions: SessionSummaryFixture[], resolvedTotal?: number) {
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
    fixture.root.sessionRegistry.load(session.sessionId, projectPath);
    applyConversationSnapshot(fixture.models.projectConversation(session.sessionId, projectPath), {
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
    });
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
        <ConversationNavigator projectPath={projectPath} />
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
