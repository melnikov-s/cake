/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectPath = "/project";

function renderNavigator() {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath })],
    sessions: Array.from({ length: 21 }, (_, index) =>
      sessionSummary({ sessionId: `session-${index}`, projectPath }),
    ),
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
  fixture.models.sessionCatalog.resolvedHasMoreByProject[projectPath] = true;
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationNavigator projectPath={projectPath} />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    rows: () => view.container.querySelectorAll('[data-relationship="grouped"]'),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Conversation navigator pagination", () => {
  it.each(["Collapse Project Chat", "Collapse all"])(
    "hides active Show more after %s and restores pagination when expanded",
    async (collapseAction) => {
      using fixture = renderNavigator();
      const active = within(screen.getByRole("region", { name: "Active sessions" }));
      expect(fixture.rows()).toHaveLength(10);
      await fixture.user.click(active.getByRole("button", { name: "Show more" }));
      expect(fixture.rows()).toHaveLength(20);

      await fixture.user.click(screen.getByRole("button", { name: collapseAction }));
      expect(fixture.rows()).toHaveLength(0);
      expect(active.getByRole("button", { name: "Project Chat" })).toBeTruthy();
      expect(active.queryByRole("button", { name: "Show more" })).toBeNull();

      // Resolved pagination has its own disclosure, independent of Project Chat.
      await fixture.user.click(screen.getByRole("button", { name: "Resolved sessions" }));
      const resolved = within(screen.getByRole("region", { name: "Resolved sessions" }));
      expect(resolved.getByRole("button", { name: "Show more" })).toBeTruthy();

      await fixture.user.click(screen.getByRole("button", { name: "Expand Project Chat" }));
      expect(fixture.rows()).toHaveLength(20);
      await fixture.user.click(active.getByRole("button", { name: "Show more" }));
      expect(fixture.rows()).toHaveLength(21);
      expect(active.queryByRole("button", { name: "Show more" })).toBeNull();
    },
  );
});
