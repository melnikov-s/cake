/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect, Stream, SubscriptionRef } from "effect";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CakeChatSummary } from "../../../../src/contracts/cake-chats/cake-chat-data";
import {
  TurnId,
  type ConversationUpdate,
} from "../../../../src/contracts/conversations/conversation-data";
import {
  SubagentHandleId,
  SubagentError,
  type SubagentActivity,
  type SubagentUpdate,
} from "../../../../src/contracts/subagents/subagent-data";
import { App } from "../../../../src/renderer/components/app";
import { observeModels } from "../../../../src/renderer/observers/models";
import { projectRecord } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { workerActivity } from "../subagent-activity-workflow-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

const sessionId = `project-chat:${"a".repeat(64)}`;
const otherSessionId = `project-chat:${"b".repeat(64)}`;
const secondHandleId = SubagentHandleId.make("10000000-0000-4000-8000-000000000002");
const turnId = TurnId.make("00000000-0000-4000-8000-000000000001");
const summaries: CakeChatSummary[] = (
  [
    [sessionId, "/project", "Project"],
    [otherSessionId, "/other", "Other"],
  ] as const
).map(([sessionId, projectPath, title]) => ({
  sessionId,
  projectPath,
  title,
  createdAt: "2026-01-01T00:00:00Z",
  modifiedAt: "2026-01-01T00:00:00Z",
  messageCount: 2,
  resolved: false,
  unread: false,
}));

afterEach(cleanup);

async function renderWorkerStatus(status: "queued" | "running" = "running") {
  const workers = await Effect.runPromise(
    SubscriptionRef.make<SubagentUpdate>({
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: sessionId,
      activities: [
        workerActivity({
          parentSessionId: sessionId,
          status,
          streaming: status === "running",
          parts: [],
        }),
      ],
      backgroundActive: true,
    }),
  );
  const initialConversation = {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId,
      sessionFile: "/project-chat.sqlite",
      parts: [],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: [],
      streaming: true,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  } satisfies ConversationUpdate;
  const foreground = await Effect.runPromise(
    SubscriptionRef.make<ConversationUpdate>(initialConversation),
  );
  const disconnected = await Effect.runPromise(Deferred.make<never, SubagentError>());
  const reconnected = await Effect.runPromise(Deferred.make<void>());
  let workerSubscriptions = 0;
  const unsubscribed = vi.fn();
  const runtime = observerRuntime(
    observerClient({
      projects: { observeCatalog: () => Stream.never },
      automations: { observe: () => Stream.never },
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      projectSessions: { observeCatalog: () => Stream.never },
      cakeChats: {
        observeCatalog: (query) =>
          Stream.make({
            _tag: "Snapshot" as const,
            revision: 1,
            sessions: query.resolved ? [] : summaries,
          }).pipe(Stream.concat(Stream.never)),
        observeControls: () => Stream.never,
        observeSideChats: () => Stream.never,
      },
      conversations: {
        observe: (target) =>
          target.sessionId === sessionId
            ? SubscriptionRef.changes(foreground)
            : Stream.make({
                _tag: "Snapshot" as const,
                revision: 1,
                snapshot: {
                  ...initialConversation.snapshot,
                  sessionId: target.sessionId,
                  sessionFile: "/other-chat.sqlite",
                  streaming: false,
                },
              }).pipe(Stream.concat(Stream.never)),
      },
      subagents: {
        observe: (id) =>
          id === sessionId
            ? Stream.suspend(() => {
                workerSubscriptions += 1;
                return workerSubscriptions === 1
                  ? Stream.merge(
                      SubscriptionRef.changes(workers),
                      Stream.fromEffect(Deferred.await(disconnected)),
                    )
                  : Stream.fromEffect(Deferred.await(reconnected)).pipe(
                      Stream.flatMap(() => SubscriptionRef.changes(workers)),
                    );
              }).pipe(Stream.ensuring(Effect.sync(() => unsubscribed())))
            : Stream.never,
      },
      workflows: { observe: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    }),
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" }), projectRecord({ path: "/other" })],
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  const stop = observeModels(runtime, fixture.models, fixture.root);
  const user = userEvent.setup();
  const projectRow = () =>
    screen
      .getByRole("button", { name: "Open Project Chat for project" })
      .closest<HTMLElement>('[data-slot="project-header"]')!;
  try {
    await user.click(await screen.findByRole("button", { name: "Open Project Chat for project" }));
    await waitFor(() => expect(fixture.root.appShellStore.selection).toMatchObject({ sessionId }));
    await waitFor(() => expect(fixture.models.subagentCatalog(sessionId).loaded).toBe(true));
  } catch (error) {
    view.unmount();
    stop();
    await runtime.dispose();
    fixture[Symbol.dispose]();
    throw error;
  }
  let revision = 1;
  return {
    projectRow,
    unsubscribed,
    async disconnectWorkers() {
      await act(async () => {
        await Effect.runPromise(
          Deferred.fail(
            disconnected,
            new SubagentError({ operation: "observe", message: "Connection lost" }),
          ),
        );
      });
      await waitFor(() => expect(unsubscribed).toHaveBeenCalledOnce());
    },
    async reconnectWorkers() {
      await act(async () => {
        await Effect.runPromise(Deferred.succeed(reconnected, undefined));
      });
    },
    async leaveAndSettleForeground() {
      await user.click(screen.getByRole("button", { name: "Open Project Chat for other" }));
      await waitFor(() =>
        expect(fixture.root.appShellStore.selection).toMatchObject({ sessionId: otherSessionId }),
      );
      await act(async () => {
        await Effect.runPromise(
          SubscriptionRef.set(foreground, {
            _tag: "Event",
            revision: 2,
            event: { _tag: "StreamingChanged", sessionId, streaming: false },
          }),
        );
      });
      await waitFor(() =>
        expect(fixture.models.cakeChatConversation(sessionId).streaming).toBe(false),
      );
      await act(async () => {
        await Effect.runPromise(
          SubscriptionRef.set(foreground, {
            _tag: "Event",
            revision: 3,
            event: { _tag: "TurnSettled", sessionId, turnId, outcome: "complete" },
          }),
        );
      });
    },
    async publishWorkers(activities: SubagentActivity[]) {
      await act(async () => {
        await Effect.runPromise(
          SubscriptionRef.set(workers, {
            _tag: "Snapshot",
            revision: ++revision,
            parentSessionId: sessionId,
            activities,
            backgroundActive: activities.some(
              (activity) =>
                !activity.released &&
                (activity.status === "queued" || activity.status === "running"),
            ),
          }),
        );
      });
    },
    async [Symbol.asyncDispose]() {
      view.unmount();
      stop();
      await runtime.dispose();
      fixture[Symbol.dispose]();
    },
  };
}

it.each(
  (["queued", "running"] as const).flatMap((initial) =>
    (["complete", "error", "aborted", "released"] as const).map((outcome) => ({
      initial,
      outcome,
    })),
  ),
)(
  "updates a hidden Project Chat when its $initial worker becomes $outcome",
  async ({ initial, outcome }) => {
    await using f = await renderWorkerStatus(initial);
    await f.leaveAndSettleForeground();
    expect(within(f.projectRow()).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(f.unsubscribed).not.toHaveBeenCalled();
    await f.publishWorkers([
      workerActivity({
        parentSessionId: sessionId,
        status: outcome === "released" ? initial : outcome,
        released: outcome === "released",
        streaming: false,
        parts: [],
      }),
    ]);
    await waitFor(() =>
      expect(within(f.projectRow()).queryByRole("img", { name: "Running" })).toBeNull(),
    );
    await waitFor(() => expect(f.unsubscribed).toHaveBeenCalledOnce());
  },
);

it("reconnects a hidden Project Chat worker stream and replaces its cached running status", async () => {
  await using f = await renderWorkerStatus();
  await f.leaveAndSettleForeground();
  await f.disconnectWorkers();
  await f.publishWorkers([
    workerActivity({ parentSessionId: sessionId, status: "complete", streaming: false, parts: [] }),
  ]);
  expect(within(f.projectRow()).getByRole("img", { name: "Running" })).toBeTruthy();
  await f.reconnectWorkers();
  await waitFor(() =>
    expect(within(f.projectRow()).queryByRole("img", { name: "Running" })).toBeNull(),
  );
});

it("keeps a hidden Project Chat running until every owned worker settles", async () => {
  await using f = await renderWorkerStatus();
  await f.publishWorkers([
    workerActivity({ parentSessionId: sessionId }),
    workerActivity({
      parentSessionId: sessionId,
      handleId: secondHandleId,
      status: "queued",
      streaming: false,
      parts: [],
    }),
  ]);
  await f.leaveAndSettleForeground();
  await f.publishWorkers([
    workerActivity({ parentSessionId: sessionId, status: "complete", streaming: false, parts: [] }),
    workerActivity({
      parentSessionId: sessionId,
      handleId: secondHandleId,
      status: "queued",
      streaming: false,
      parts: [],
    }),
  ]);
  expect(within(f.projectRow()).getByRole("img", { name: "Running" })).toBeTruthy();
  expect(f.unsubscribed).not.toHaveBeenCalled();
  await f.publishWorkers([
    workerActivity({ parentSessionId: sessionId, status: "complete", streaming: false, parts: [] }),
    workerActivity({
      parentSessionId: sessionId,
      handleId: secondHandleId,
      status: "aborted",
      streaming: false,
      parts: [],
    }),
  ]);
  await waitFor(() =>
    expect(within(f.projectRow()).queryByRole("img", { name: "Running" })).toBeNull(),
  );
});
