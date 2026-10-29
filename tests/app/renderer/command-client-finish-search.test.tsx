/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { SessionSearchDialog } from "../../../src/renderer/components/session-search-dialog";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function searchSession(sessionId: string, title: string, day = 1) {
  return sessionSummary({
    sessionId,
    title,
    projectPath: "/project",
    modifiedAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  });
}

afterEach(cleanup);

// Complements session-search-workflow's navigation/filter/paging coverage:
// title ranking must be the order the reader actually sees, not a parallel
// searchSessions invocation over hand-built index rows.
it("ranks real session choices, normalizes queries, treats punctuation literally and rejects fuzzy noise", async () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [
      searchSession("fuzzy", "SearXch dialXog", 6),
      searchSession("tokens", "Dialog for session search", 5),
      searchSession("phrase", "Build search dialog", 4),
      searchSession("prefix", "Search dialog keyboard", 3),
      searchSession("exact", "Search dialog", 1),
      searchSession("accent", "Café Search"),
      searchSession("cpp", "C++ settings"),
      searchSession("c", "C settings"),
      searchSession("bracket", "Fix [parser]"),
      searchSession("b", "Tie title", 2),
      searchSession("a", "Tie title", 2),
      searchSession("old", "Tie title", 1),
      searchSession("noise", `a${"x".repeat(30)}bc`),
    ],
    snapshot: {
      state: {},
      children: {
        settingsStore: {
          state: {},
          children: {
            appearance: {
              state: { sessionAvatarsEnabled: false, projectAvatarsEnabled: false },
              children: {},
            },
          },
        },
      },
    },
  });
  const { root } = fixture;
  root.sidebarStore.sessionSearchStore.show();
  const view = render(
    <SessionSearchDialog
      sidebar={root.sidebarStore}
      sessionMetadata={root.sessionMetadataStore}
      projects={root.projectCatalogStore}
      appearance={root.settingsStore.appearance}
      onOpenSession={(id) => void root.navigationStore.openSession(id)}
    />,
  );
  try {
    const user = userEvent.setup();
    const query = screen.getByRole("combobox", { name: "Search session titles" });
    const ids = () =>
      screen
        .queryAllByRole("option")
        .map((option) => option.closest("[data-session-id]")?.getAttribute("data-session-id"));
    await user.type(query, "srch dlg");
    await waitFor(() => expect(ids()).toContain("exact"));
    expect(ids()).not.toContain("cpp");
    for (const [text, expected] of [
      ["search dialog", ["exact", "prefix", "phrase", "tokens", "fuzzy"]],
      ["  CAFE   SEARCH ", ["accent"]],
      ["c++", ["cpp"]],
      ["[", ["bracket"]],
      ["tie title", ["a", "b", "old"]],
      ["search missing", []],
      ["abc", []],
      ["z", []],
    ] as const) {
      await user.clear(query);
      await user.type(query, text.replaceAll("[", "[["));
      await waitFor(() => expect(ids()).toEqual(expected));
    }
    expect(screen.getByRole("status").textContent).toBe("No matching sessions.");
  } finally {
    view.unmount();
  }
});
