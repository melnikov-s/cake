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
import { subagentLink } from "../../../../src/contracts/subagents/subagent-reference";
import { App } from "../../../../src/renderer/components/app";
import { MarkdownLinkProvider } from "../../../../src/renderer/components/ai-elements/markdown";
import { NestedChat } from "../../../../src/renderer/components/nested-chat";
import { researchOrigin } from "../../../fixtures/subagent-report";
import { observeModels } from "../../../../src/renderer/observers/models";
import { projectRecord } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { handleId, workerActivity } from "../subagent-activity-workflow-fixture";
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

async function renderWorkerStatus(
  status: "queued" | "running" = "running",
  parentParts: Extract<ConversationUpdate, { _tag: "Snapshot" }>["snapshot"]["parts"] = [],
) {
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
      parts: parentParts,
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
      projectSessions: { observeCatalog: () => Stream.never, observeSignals: () => Stream.never },
      cakeChats: {
        observeCatalog: (query) =>
          Stream.make({
            _tag: "Snapshot" as const,
            revision: 1,
            sessions: query.resolved ? [] : summaries,
          }).pipe(Stream.concat(Stream.never)),
        observeControls: () => Stream.never,
        observeSideChats: () => Stream.never,
        observeSideChatMetadata: () => Stream.never,
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
                  parts: [],
                  streaming: false,
                },
              }).pipe(Stream.concat(Stream.never)),
      },
      subagents: {
        observeMetadata: ({ parentSessionId }) =>
          parentSessionId === sessionId
            ? SubscriptionRef.changes(workers).pipe(
                Stream.filter((update) => update._tag === "Snapshot"),
                Stream.map((update) =>
                  update.activities.map((activity) => ({
                    parentSessionId: activity.parentSessionId,
                    handleId: activity.handleId,
                    anchorPartId: activity.anchorPartId,
                    task: activity.task,
                    status: activity.status,
                    streaming: activity.streaming,
                    released: activity.released ?? false,
                    resolved: activity.released ?? false,
                  })),
                ),
              )
            : Stream.succeed([]).pipe(Stream.concat(Stream.never)),
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
      scheduledMessages: { observe: () => Stream.never },
    }),
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" }), projectRecord({ path: "/other" })],
    client: { cakeChats: { open: async () => undefined } },
  });
  fixture.root.workspaceNavigatorStore.show("sessions");
  const view = render(
    <StoreProvider store={fixture.root}>
      <MarkdownLinkProvider
        actions={{
          openExternalUrl: () => {
            throw new Error("Unexpected external navigation");
          },
          openSession: (id) => void fixture.root.navigationStore.openSessionLink(id),
          openSubagent: (parent, handle, messageId) =>
            void fixture.root.navigationStore.openSubagentLink(parent, handle, messageId),
        }}
      >
        <App />
      </MarkdownLinkProvider>
    </StoreProvider>,
  );
  const stop = observeModels(runtime, fixture.models, fixture.root);
  const user = userEvent.setup();
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
  const leaveProject = async () => {
    if (!fixture.root.workspaceNavigatorStore.visible)
      act(() => fixture.root.workspaceNavigatorStore.show("sessions"));
    await user.click(screen.getByRole("button", { name: "Open Project Chat for other" }));
    await waitFor(() =>
      expect(fixture.root.appShellStore.selection).toMatchObject({ sessionId: otherSessionId }),
    );
  };
  return {
    fixture,
    user,
    leaveProject,
    backgroundRunning: () =>
      fixture.root.cakeChatCollectionStore.activityFor(sessionId) === "running",
    async returnToProjectAndExpectIdle() {
      await user.click(screen.getByRole("button", { name: "Open Project Chat for project" }));
      await waitFor(() => {
        const row = document.querySelector<HTMLElement>(
          '[data-slot="conversation-navigator-row"][data-relationship="home"]',
        );
        expect(row).not.toBeNull();
        expect(within(row!).queryByRole("img", { name: "Running" })).toBeNull();
        expect(within(row!).queryByLabelText(/running descendants/)).toBeNull();
      });
    },
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
      await leaveProject();
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
    expect(f.backgroundRunning()).toBe(true);
    expect(f.unsubscribed).not.toHaveBeenCalled();
    await f.publishWorkers([
      workerActivity({
        parentSessionId: sessionId,
        status: outcome === "released" ? initial : outcome,
        released: outcome === "released",
        resolved: outcome === "released",
        streaming: false,
        parts: [],
      }),
    ]);
    await waitFor(() => expect(f.backgroundRunning()).toBe(false));
    await waitFor(() => expect(f.unsubscribed).toHaveBeenCalledOnce());
    await f.returnToProjectAndExpectIdle();
  },
);

it("reconnects a hidden Project Chat worker stream and replaces its cached running status", async () => {
  await using f = await renderWorkerStatus();
  await f.leaveAndSettleForeground();
  await f.disconnectWorkers();
  await f.publishWorkers([
    workerActivity({ parentSessionId: sessionId, status: "complete", streaming: false, parts: [] }),
  ]);
  expect(f.backgroundRunning()).toBe(true);
  await f.reconnectWorkers();
  await waitFor(() => expect(f.backgroundRunning()).toBe(false));
  await f.returnToProjectAndExpectIdle();
});

it("evicts a cold Project Chat's worker parts and reopens exact worker links across three cycles", async () => {
  const report = { ...researchOrigin, handleId, task: "Inspect the boundary" };
  const savedWorker = (answer: string) =>
    workerActivity({
      parentSessionId: sessionId,
      status: "complete",
      streaming: false,
      released: true,
      parts: [
        { id: "request", kind: "text", role: "user", status: "complete", text: report.task },
        {
          id: "answer",
          entryId: "answer-entry",
          kind: "text",
          role: "assistant",
          status: "complete",
          text: answer,
        },
      ],
    });
  await using f = await renderWorkerStatus("running", [
    {
      id: "report",
      kind: "text",
      role: "user",
      text: "Worker report summary, not the full transcript",
      status: "complete",
      subagentReport: report,
    },
  ]);
  const { root, models } = f.fixture;
  const catalog = models.subagentCatalog(sessionId);
  const workerStore = root.cakeChatCollectionStore.registry.find(sessionId)!.subagentActivityStore;
  const partCount = () =>
    catalog.activities.reduce((count, activity) => count + activity.parts.length, 0);

  await f.publishWorkers([savedWorker("Answer before unload")]);
  // At this viewport the navigator overlays the transcript rather than sharing its row.
  act(() => root.workspaceNavigatorStore.close());
  const source = await screen.findByRole("link", { name: "Open source" });
  expect(source.getAttribute("href")).toBe(subagentLink(sessionId, handleId));
  act(() => source.focus());
  await f.user.keyboard("{Enter}");
  expect(await screen.findByText("Answer before unload")).toBeDefined();
  expect(partCount()).toBe(2);
  expect(f.unsubscribed).not.toHaveBeenCalled();
  // Long-lived panel actions can hold a run descriptor even after the panel stops rendering.
  const retainedRun = workerStore.run(handleId)!;
  expect(retainedRun.parts).toHaveLength(2);

  // A second mounted reader can outlive the owning pane, as in an artifact drawer.
  const reader = render(
    <StoreProvider store={root}>
      <NestedChat
        store={workerStore.chatStore(handleId)!}
        parentBehavior={{ subagents: workerStore }}
        composerFocusEnabled={false}
      />
    </StoreProvider>,
  );
  try {
    await f.leaveAndSettleForeground();
    await waitFor(() =>
      expect(root.cakeChatCollectionStore.registry.observationTargets).not.toContainEqual(
        expect.objectContaining({ sessionId }),
      ),
    );
    expect(partCount()).toBe(2);
    expect(f.unsubscribed).not.toHaveBeenCalled();
    await f.publishWorkers([savedWorker("Answer while the independent reader is open")]);
    expect(
      await within(reader.container).findByText("Answer while the independent reader is open"),
    ).toBeDefined();
  } finally {
    reader.unmount();
  }

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await waitFor(() => expect(f.unsubscribed).toHaveBeenCalledTimes(cycle));
    expect(catalog.loaded).toBe(false);
    expect(partCount()).toBe(0);
    expect(retainedRun.parts).toHaveLength(0);
    expect(root.cakeChatCollectionStore.registry.targets).toContain(sessionId);
    expect(catalog.releasedHandleIds).toContain(handleId);
    await waitFor(() =>
      expect(root.conversationNavigatorStore.ownedConversations(sessionId)).toContainEqual(
        expect.objectContaining({
          title: report.task,
          target: { kind: "subagent", sessionId, handleId },
          readOnly: true,
          running: false,
        }),
      ),
    );

    const answer = `Answer after reopen ${cycle}`;
    await f.publishWorkers([savedWorker(answer)]);
    expect(partCount()).toBe(0);
    const open = () => root.navigationStore.openSubagentLink(sessionId, handleId, "answer-entry");
    if (cycle === 1) {
      // The public handle is known, but opening a message must wait for fresh parts.
      let opening: Promise<void> | undefined;
      await act(async () => {
        opening = open();
      });
      expect(catalog.loaded).toBe(false);
      expect(partCount()).toBe(0);
      await f.reconnectWorkers();
      await act(async () => opening);
    } else {
      await act(open);
    }
    expect(await screen.findByText(answer)).toBeDefined();
    await waitFor(() =>
      expect(
        document.querySelector('[aria-current="true"] [data-part-id="answer"]'),
      ).not.toBeNull(),
    );
    expect(partCount()).toBe(2);
    if (cycle < 3) await f.leaveProject();
  }
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
  expect(f.backgroundRunning()).toBe(true);
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
  await waitFor(() => expect(f.backgroundRunning()).toBe(false));
});
