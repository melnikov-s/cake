/** @vitest-environment jsdom */
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

const launched = (
  sessionId: string,
  title: string,
  launchedAt: string,
  lastReport?: { status: "completed" | "failed" | "blocked" | "stopped"; summary: string },
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
