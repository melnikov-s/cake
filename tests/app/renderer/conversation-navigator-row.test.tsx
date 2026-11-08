/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { ConversationNavigatorRow } from "../../../src/renderer/components/conversation-navigator-row";
import type { ConversationNavigationNode } from "../../../src/renderer/lib/conversation-navigation-tree";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it.each([
  { scope: "project", activity: "own", hideSubtitle: true },
  { scope: "project", activity: "descendant", hideSubtitle: true },
  { scope: "project", activity: "idle", hideSubtitle: false },
  { scope: "global", activity: "own", hideSubtitle: false },
  { scope: "session", activity: "own", hideSubtitle: false },
] as const)(
  "only hides the running project subtitle: $scope / $activity",
  ({ scope, activity, hideSubtitle }) => {
    using fixture = createRendererStoreFixture();
    const child: ConversationNavigationNode = {
      key: "session:child",
      title: "Child",
      label: "Session",
      relationship: "grouped",
      target: { kind: "project-session", sessionId: "child" },
      parentKey: "session:home",
      modifiedAt: "",
      activity: "running",
      running: true,
      children: [],
    };
    const node: ConversationNavigationNode = {
      key: "session:home",
      title: scope === "project" ? "cake" : "Conversation",
      label: scope === "session" ? "Session" : "Project Chat",
      relationship: scope === "session" ? "grouped" : "home",
      target: { kind: scope === "session" ? "project-session" : "cake-chat", sessionId: "home" },
      parentKey: undefined,
      modifiedAt: "",
      activity: activity === "own" ? "running" : undefined,
      running: activity === "own",
      children: activity === "descendant" ? [child] : [],
    };
    const view = render(
      <StoreProvider store={fixture.root}>
        <ConversationNavigatorRow
          node={node}
          depth={0}
          projectPath={scope === "global" ? undefined : "/project"}
        />
      </StoreProvider>,
    );
    try {
      const button = screen.getByRole("button", { name: node.title });
      const working = activity !== "idle";
      expect(button.textContent).toBe(
        node.title + (hideSubtitle ? "" : working ? "Running" : "Idle"),
      );
      expect(
        view.container
          .querySelector('[data-slot="conversation-navigator-row"]')
          ?.getAttribute("data-working"),
      ).toBe(String(working));
      expect(view.container.firstElementChild?.classList.contains("min-h-9")).toBe(hideSubtitle);
      // No empty description wrapper remains underneath the project name.
      expect(button.querySelector(".flex-col")?.children.length).toBe(hideSubtitle ? 1 : 2);
      if (working) expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
      else expect(screen.getByLabelText("Idle")).toBeTruthy();
      expect(fixture.root.conversationNavigatorStore.effectiveWorking(node)).toBe(working);
    } finally {
      view.unmount();
    }
  },
);

it.each([
  ["Cake Chat", "home", "cake-chat", CAKE_CHAT_SESSION_ID],
  ["Project Chat", "home", "cake-chat", "project-chat"],
  ["Session", "grouped", "project-session", "missing-session"],
  ["Child session", "family-child", "project-session", "missing-child"],
] as const)("omits the %s prefix in a non-catalog row", (label, relationship, kind, sessionId) => {
  using fixture = createRendererStoreFixture();
  const node: ConversationNavigationNode = {
    key: `session:${sessionId}`,
    title: "Conversation title",
    label,
    relationship,
    target: { kind, sessionId },
    parentKey: undefined,
    modifiedAt: "",
    activity: undefined,
    running: false,
    children: [],
  };
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationNavigatorRow
        node={node}
        depth={relationship === "family-child" ? 2 : 0}
        projectPath={undefined}
      />
    </StoreProvider>,
  );
  try {
    expect(screen.getByRole("button", { name: node.title })).toBeTruthy();
    expect(screen.queryByText(label, { exact: true })).toBeNull();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByLabelText("Idle")).toBeTruthy();
    expect(view.container.textContent).toBe("Conversation titleIdle");
    expect(
      view.container.querySelector("[data-relationship]")?.getAttribute("data-relationship"),
    ).toBe(relationship);
  } finally {
    view.unmount();
  }
});
