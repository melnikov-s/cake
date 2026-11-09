/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import {
  TurnId,
  type ConversationEvent,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const projectPath = "/cake";
const chatId = `project-chat:${"a".repeat(64)}`;
const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
const failure = {
  id: "failure",
  kind: "notice" as const,
  tone: "error" as const,
  title: "Model request failed",
  detail: "Request was aborted",
};

function renderStatus(kind: "session" | "project-chat", outcome: "failed" | "aborted") {
  const sessionId = kind === "session" ? "task" : chatId;
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Cake" })],
    sessions:
      kind === "session"
        ? [sessionSummary({ sessionId, projectPath, unread: true, latestTurnOutcome: outcome })]
        : [],
  });
  if (kind === "project-chat")
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId, projectPath, title: "Cake", unread: true, messageCount: 2 }],
    });
  const session =
    kind === "session"
      ? fixture.root.sessionRegistry.load(sessionId, projectPath)
      : fixture.root.cakeChatCollectionStore.registry.load(sessionId);
  const model = session.model;
  const snapshot: ConversationSnapshot = {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [failure],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  applyConversationSnapshot(model, snapshot);
  let revision = 0;
  const publish = (event: ConversationEvent) =>
    applyConversationUpdate(model, { _tag: "Event", revision: ++revision, event });
  publish({ _tag: "TurnSettled", sessionId, turnId, outcome });
  const view = render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
      <ConversationNavigator projectPath={projectPath} />
    </StoreProvider>,
  );
  const summary = () =>
    kind === "session"
      ? fixture.models.sessionCatalog.find(sessionId)!
      : fixture.models.cakeChatCatalog.sessions.find((item) => item.sessionId === sessionId)!;
  return {
    fixture,
    row: () =>
      within(
        view.container.querySelector<HTMLElement>(
          `[data-slot="conversation-navigator-row"][data-session-id="${sessionId}"]`,
        )!,
      ),
    publish,
    sessionId,
    acknowledge() {
      act(() => {
        summary().unread = false;
      });
    },
    running() {
      act(() => {
        publish({ _tag: "TurnAccepted", sessionId, turnId, delivery: "prompt" });
        fixture.models.projects.runningProjectPaths.push(projectPath);
        if (kind === "session") {
          const task = fixture.models.sessionCatalog.find(sessionId)!;
          task.running = true;
          task.latestTurnOutcome = undefined;
        }
      });
    },
    settle(outcome: "complete" | "aborted", parts: ConversationSnapshot["parts"]) {
      act(() => {
        applyConversationSnapshot(model, { ...snapshot, parts });
        publish({ _tag: "TurnSettled", sessionId, turnId, outcome });
        fixture.models.projects.runningProjectPaths.splice(0);
        summary().unread = true;
        if (kind === "session") {
          const task = fixture.models.sessionCatalog.find(sessionId)!;
          task.running = false;
          task.latestTurnOutcome = outcome;
        }
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

it.each([
  ["session", "failed"],
  ["session", "aborted"],
  ["project-chat", "failed"],
  ["project-chat", "aborted"],
] as const)(
  "%s %s failure stays red despite unread/read, then running and success replace it",
  (kind, outcome) => {
    using status = renderStatus(kind, outcome);
    const assertError = () => {
      expect(status.row().getByRole("img", { name: "Error" }).className).toContain(
        "bg-destructive",
      );
      expect(screen.getByRole("img", { name: "Error in Cake" }).className).toContain(
        "bg-destructive",
      );
      expect(screen.queryByRole("img", { name: "Unread sessions in Cake" })).toBeNull();
      expect(status.row().queryByRole("img", { name: "Ready, unread" })).toBeNull();
    };
    assertError();
    // Read acknowledgement must not turn an unresolved failure green or idle.
    status.acknowledge();
    assertError();
    status.running();
    expect(status.row().getByRole("img", { name: "Running" }).className).toContain("bg-accent");
    expect(screen.getByRole("img", { name: "Work running in Cake" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Error in Cake" })).toBeNull();
    // A successful hidden continuation supersedes the retained error card.
    status.settle("complete", [failure]);
    expect(status.row().getByRole("img", { name: "Ready, unread" }).className).toContain(
      "bg-success",
    );
    expect(screen.getByRole("img", { name: "Unread sessions in Cake" }).className).toContain(
      "bg-success",
    );
    expect(screen.queryByRole("img", { name: "Error in Cake" })).toBeNull();
    status.acknowledge();
    expect(status.row().queryByRole("img", { name: "Error" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Unread sessions in Cake" })).toBeNull();
  },
);

it.each(["session", "project-chat"] as const)(
  "%s distinguishes a deliberate stop from a displayed aborted-request failure",
  (kind) => {
    using status = renderStatus(kind, "aborted");
    status.settle("aborted", [
      { id: "stopped", kind: "notice", tone: "info", title: "Stopped", detail: "Stopped by you" },
    ]);
    expect(status.row().queryByRole("img", { name: "Error" })).toBeNull();
    expect(status.row().queryByRole("img", { name: "Ready, unread" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Error in Cake" })).toBeNull();
    status.settle("aborted", [failure]);
    expect(status.row().getByRole("img", { name: "Error" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Error in Cake" })).toBeTruthy();
  },
);
