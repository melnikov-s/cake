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
