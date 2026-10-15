/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { CakeChatLaunchedSessions } from "../../../src/renderer/components/cake-chat-launched-sessions";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

const launched = (
  sessionId: string,
  title: string,
  launchedAt: string,
  lastReport?: {
    status: "completed" | "failed" | "blocked" | "stopped";
    summary: string;
  },
) =>
  sessionSummary({
    sessionId,
    title,
    projectPath: "/project",
    cakeChatLaunch: {
      launchedAt,
      ...(lastReport ? { lastReport: { ...lastReport, reportedAt: launchedAt } } : null),
    },
  });

// Fresh fixtures per test: projection Models adopt their snapshot objects.
const sessions = () => [
  launched("done", "quake-global-cake-chat-hotkey", "2026-01-01T10:00:00.000Z", {
    status: "completed",
    summary: "Landed abc123; needs restart",
  }),
  launched("failed", "fix-x", "2026-01-01T11:00:00.000Z", {
    status: "failed",
    summary: "Typecheck failed",
  }),
  { ...launched("running", "docs-pass", "2026-01-01T12:00:00.000Z"), running: true },
  sessionSummary({ sessionId: "manual", title: "User's own session", projectPath: "/project" }),
  { ...launched("old", "Resolved work", "2026-01-01T09:00:00.000Z"), resolved: true },
];

it("shows a quiet status strip for sessions Cake Chat launched and opens one on click", async () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: sessions(),
  });
  const open = vi
    .spyOn(fixture.root.navigationStore, "openSessionLink")
    .mockResolvedValue(undefined);
  render(
    <StoreProvider store={fixture.root}>
      <CakeChatLaunchedSessions />
    </StoreProvider>,
  );
  const trigger = screen.getByRole("button", {
    name: "Launched sessions: 3 sessions · 1 failed · 1 running",
  });
  await userEvent.click(trigger);
  const list = await screen.findByRole("dialog", { name: "Sessions launched from Cake Chat" });
  const rows = Array.from(list.querySelectorAll("button")).map((row) => row.textContent);
  // Newest launch first; user-started and resolved sessions are not listed.
  expect(rows).toEqual([
    "docs-passRunning · project",
    "fix-xFailed · project · Typecheck failed",
    "quake-global-cake-chat-hotkeyDone · project · Landed abc123; needs restart",
  ]);
  await userEvent.click(screen.getByRole("button", { name: /fix-x/ }));
  expect(open).toHaveBeenCalledWith("failed");

  // A blocked report needs the user even though the session is idle.
  act(() => {
    applySnapshot(fixture.models.sessionCatalog, {
      sessions: [
        launched("failed", "fix-x", "2026-01-01T11:00:00.000Z", {
          status: "blocked",
          summary: "Needs a schema decision",
        }),
      ],
      resolvedHasMoreByProject: {},
    });
  });
  expect(
    screen.getByRole("button", { name: "Launched sessions: 1 session · 1 needs you" }),
  ).toBeTruthy();
});

it("renders nothing when Cake Chat launched no open sessions", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "manual", projectPath: "/project" })],
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <CakeChatLaunchedSessions />
    </StoreProvider>,
  );
  expect(view.container.textContent).toBe("");
});

it("answers “what's going on?” with sessions.list { launchedByCakeChat: true }", async () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: sessions(),
  });
  const result = await fixture.root.applicationControlStore.invoke(
    { name: "sessions.list", arguments: { launchedByCakeChat: true } },
    { sessionId: "cake-chat", title: "Cake Chat", kind: "cake-chat" },
  );
  expect(result).toMatchObject({ ok: true, command: "sessions.list" });
  const listed = (result as { sessions: { sessionId: string; launch?: unknown }[] }).sessions;
  expect(listed.map((session) => [session.sessionId, session.launch])).toEqual(
    expect.arrayContaining([
      ["running", { status: "running", launchedAt: "2026-01-01T12:00:00.000Z" }],
      [
        "failed",
        {
          status: "failed",
          launchedAt: "2026-01-01T11:00:00.000Z",
          summary: "Typecheck failed",
          reportedAt: "2026-01-01T11:00:00.000Z",
        },
      ],
      [
        "done",
        {
          status: "done",
          launchedAt: "2026-01-01T10:00:00.000Z",
          summary: "Landed abc123; needs restart",
          reportedAt: "2026-01-01T10:00:00.000Z",
        },
      ],
    ]),
  );
  expect(listed).toHaveLength(3);
  expect(
    (result as { attentionSessions: { sessionId: string }[] }).attentionSessions.map(
      (session) => session.sessionId,
    ),
  ).toEqual(["failed"]);
});
