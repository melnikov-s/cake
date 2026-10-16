/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { Deferred, Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CakeIpcClient, type CakeIpcClientService } from "../../../src/ipc/client/CakeIpcClient";
import type { Runtime } from "../../../src/renderer/runtime";
import { createModelObserver } from "../../../src/renderer/observers/models";
import { observeStream } from "../../../src/renderer/observers/observe-stream";
import { Chat } from "../../../src/renderer/components/chat";
import { WorkflowProgress } from "../../../src/renderer/components/workflow-progress";
import { WorkflowConversationLayout } from "../../../src/renderer/components/workflow-conversation-layout";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { workflowSummary } from "../../../src/contracts/workflows/workflow-projection";
import type {
  WorkflowCatalogUpdate,
  WorkflowRun,
  WorkflowRunUpdate,
  WorkflowWorkerActivity,
} from "../../../src/contracts/workflows/workflow-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  workflowActivityFixture,
  workflowRunFixture,
  workflowSource,
} from "../../fixtures/dynamic-workflow";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import type { TestClientOverrides } from "./test-client";

/** Same typed fail-on-unconfigured boundary policy as createTestClient, for observation Streams. */
function testIpcClient(overrides: {
  [Group in keyof CakeIpcClientService]?: Partial<CakeIpcClientService[Group]>;
}): CakeIpcClientService {
  const target = Object.create(null) as CakeIpcClientService;
  return new Proxy(target, {
    get(_target, group: keyof CakeIpcClientService) {
      return new Proxy(overrides[group] ?? {}, {
        get(service, operation) {
          if (Reflect.has(service, operation)) return Reflect.get(service, operation);
          return () => {
            throw new Error(`Unexpected observation: ${String(group)}.${String(operation)}`);
          };
        },
      });
    },
  });
}

function renderWorkflow(
  options: {
    status?: WorkflowRun["status"];
    cakeChat?: boolean;
    client?: TestClientOverrides;
    inspection?: Effect.Effect<WorkflowWorkerActivity>;
  } = {},
) {
  let run = workflowRunFixture({ status: options.status });
  let revision = 1;
  const catalogUpdates = Effect.runSync(Queue.unbounded<WorkflowCatalogUpdate>());
  const detailUpdates = Effect.runSync(Queue.unbounded<WorkflowRunUpdate>());
  const detailClosed = vi.fn();
  const observe = vi.fn<CakeIpcClientService["workflows"]["observe"]>((owner) => {
    expect(owner.sessionId).toBe(run.ownerSessionId);
    return Stream.fromIterable<WorkflowCatalogUpdate>([
      {
        _tag: "Snapshot",
        revision,
        ownerSessionId: run.ownerSessionId,
        runs: [workflowSummary(run)],
      },
    ]).pipe(Stream.concat(Stream.fromQueue(catalogUpdates)));
  });
  const observeRun = vi.fn<CakeIpcClientService["workflows"]["observeRun"]>(() =>
    Stream.fromIterable<WorkflowRunUpdate>([{ _tag: "Snapshot", revision, run }]).pipe(
      Stream.concat(Stream.fromQueue(detailUpdates)),
      Stream.ensuring(Effect.sync(detailClosed)),
    ),
  );
  const inspectWorker = vi.fn<CakeIpcClientService["workflows"]["inspectWorker"]>(
    () => options.inspection ?? Effect.succeed(workflowActivityFixture()),
  );
  const publish = async (next: WorkflowRun) => {
    run = { ...next, revision: ++revision };
    await Effect.runPromise(
      Queue.offer(catalogUpdates, { _tag: "RunChanged", revision, run: workflowSummary(run) }),
    );
    await Effect.runPromise(Queue.offer(detailUpdates, { _tag: "RunChanged", revision, run }));
  };
  const pause = vi.fn<Client["workflows"]["pause"]>(async () =>
    publish({ ...run, status: "paused" }),
  );
  const resume = vi.fn<Client["workflows"]["resume"]>(async () =>
    publish({ ...run, status: "running" }),
  );
  const stop = vi.fn<Client["workflows"]["stop"]>(async () =>
    publish({ ...run, status: "stopping" }),
  );
  const relaunch = vi.fn<Client["workflows"]["relaunch"]>(async () => {
    await publish({
      ...workflowRunFixture(),
      execution: run.execution + 1,
      steps: run.steps.map((step) => ({
        ...step,
        execution: run.execution + 1,
        status: "queued",
        result: undefined,
        error: undefined,
        attempt: 1,
      })),
    });
    return {
      sessionId: run.ownerSessionId,
      runId: run.id,
      name: run.program.meta.name,
      status: run.status,
    };
  });
  const save = vi.fn<Client["workflows"]["save"]>(async (input) => ({
    meta: { ...run.program.meta, name: input.name },
    location: input.location,
    path:
      input.location === "personal"
        ? `/personal/workflows/${input.name}.js`
        : `/project/.cake/workflows/${input.name}.js`,
  }));
  const fixture = createRendererStoreFixture({
    client: {
      ...options.client,
      workflows: { pause, resume, stop, relaunch, save, ...options.client?.workflows },
    },
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: run.ownerSessionId, projectPath: "/project" })],
  });
  const session = options.cakeChat
    ? fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID)
    : fixture.root.sessionRegistry.load(run.ownerSessionId, "/project");
  const conversation = session.model;
  applyConversationUpdate(conversation, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId: session.sessionId,
      sessionFile: `/sessions/${session.sessionId}.jsonl`,
      parts: options.cakeChat
        ? [
            {
              id: "workflow-launch",
              kind: "tool",
              name: "cake",
              command: "workflows.start",
              input: JSON.stringify({
                command: "workflows.start",
                input: { sessionId: run.ownerSessionId, scriptPath: run.program.sourcePath },
              }),
              output: JSON.stringify({
                sessionId: run.ownerSessionId,
                runId: run.id,
                name: run.program.meta.name,
                status: run.status,
              }),
              state: "success",
            },
          ]
        : [],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  });
  const ipc = testIpcClient({
    projects: { observeCatalog: () => Stream.never },
    managedWorktrees: { observeCatalog: () => Stream.never, observeOperations: () => Stream.never },
    workflows: { observe, observeRun, inspectWorker },
  });
  const execute: Runtime["execute"] = (effect, signal) =>
    Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, ipc),
      signal ? { signal } : undefined,
    );
  const runtime: Runtime = {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: async () => undefined,
  };
  const observer = createModelObserver(runtime);
  observer.observe({
    projection: fixture.models,
    workflowStores: () => session.workflowRunStores,
    projectSessionCatalogQueries: () => [],
    cakeChatCatalogQueries: () => [],
    projectSessionTargets: () => [],
    cakeChatTargets: () => [],
  });
  const stores = session.workflowRunStores;
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <WorkflowConversationLayout stores={stores}>
        <Chat
          store={session.conversationSessionStore.chatStore}
          embedded
          composerFocusEnabled={false}
          footer={
            <>
              {stores.map((store) => (
                <WorkflowProgress key={store.sessionId} store={store} />
              ))}
            </>
          }
        />
      </WorkflowConversationLayout>
    </VirtuosoMockContext.Provider>,
  );
  return {
    user: userEvent.setup(),
    pause,
    resume,
    stop,
    relaunch,
    save,
    observe,
    observeRun,
    inspectWorker,
    detailClosed,
    publish: (next: WorkflowRun) => act(async () => publish(next)),
    activity: (activity: WorkflowWorkerActivity) =>
      act(async () => {
        await Effect.runPromise(
          Queue.offer(detailUpdates, { _tag: "WorkerActivity", revision: ++revision, activity }),
        );
      }),
    get run() {
      return run;
    },
    [Symbol.dispose]() {
      view.unmount();
      observer.stop();
      fixture[Symbol.dispose]();
      Effect.runSync(Queue.shutdown(catalogUpdates));
      Effect.runSync(Queue.shutdown(detailUpdates));
    },
  };
}

afterEach(cleanup);

describe("Dynamic workflow conversation UI", () => {
  it("renders live progress cards without requiring a chat mode switch", async () => {
    using fixture = renderWorkflow();
    expect(
      await screen.findByText("0/1 complete · 1 active · 0 queued", { exact: false }),
    ).toBeDefined();
    expect(screen.getByRole("combobox")).toBeDefined();
    await fixture.publish(workflowRunFixture({ status: "complete" }));
    expect(
      await screen.findByText("1/1 complete · 0 active · 0 queued", { exact: false }),
    ).toBeDefined();
  });
  it("opens run phases and exact frozen source only when Details is selected", async () => {
    using fixture = renderWorkflow();
    await screen.findByText("audit-auth");
    expect(fixture.observeRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Frozen workflow source" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Details" }));
    const source = await screen.findByRole("region", { name: "Frozen workflow source" });
    expect([...source.querySelectorAll("code > span")].map((line) => line.textContent)).toEqual(
      workflowSource.trim().split("\n"),
    );
    expect(screen.getByRole("region", { name: "Run phases" }).textContent).toContain(
      "DiscoverReview",
    );
    expect(fixture.observeRun).toHaveBeenCalledWith({
      sessionId: fixture.run.ownerSessionId,
      runId: fixture.run.id,
    });
  });
  it("inspects a worker assignment, tool activity, result and failures in the existing detail surface", async () => {
    using fixture = renderWorkflow({ status: "complete" });
    await fixture.user.click(await screen.findByRole("button", { name: "Details" }));
    await fixture.user.click(await screen.findByRole("button", { name: /Auth routes · complete/ }));
    const worker = screen.getByRole("region", { name: "Worker details" });
    expect(
      within(worker).getByText("Audit routes/auth and cite supported findings."),
    ).toBeDefined();
    expect(
      await within(worker).findByText("Verified the route guard against the source."),
    ).toBeDefined();
    expect(within(worker).getByRole("region", { name: "Worker result" }).textContent).toContain(
      "Verified route guard",
    );
    await fixture.user.click(within(worker).getByText(/1 tool call/));
    expect(await within(worker).findByText("routes/auth.ts", { exact: false })).toBeDefined();
    await fixture.publish(workflowRunFixture({ status: "interrupted" }));
    expect(
      await within(worker).findByText("Worker interrupted before finishing coverage"),
    ).toBeDefined();
    expect(fixture.inspectWorker).toHaveBeenCalledWith(
      expect.objectContaining({ execution: 1, stepId: fixture.run.steps[0]!.id }),
    );
  });
  it("does not let delayed initial inspection overwrite newer live worker activity", async () => {
    const gate = Effect.runSync(Deferred.make<WorkflowWorkerActivity>());
    using fixture = renderWorkflow({ inspection: Deferred.await(gate) });
    await fixture.user.click(await screen.findByRole("button", { name: "Details" }));
    await fixture.user.click(await screen.findByRole("button", { name: /Auth routes · running/ }));
    await waitFor(() => expect(fixture.inspectWorker).toHaveBeenCalledTimes(1));
    const live = {
      ...workflowActivityFixture(),
      streaming: true,
      parts: [
        {
          kind: "text" as const,
          id: "live-answer",
          role: "assistant" as const,
          status: "streaming" as const,
          text: "New live findings",
        },
      ],
    };
    await fixture.activity(live);
    expect(await screen.findByText("New live findings")).toBeDefined();
    await act(async () => {
      Effect.runSync(Deferred.succeed(gate, workflowActivityFixture()));
    });
    expect(screen.getByText("New live findings")).toBeDefined();
    expect(screen.queryByText("Verified the route guard against the source.")).toBeNull();
    // Authoritative status updates preserve the live activity for this attempt.
    await fixture.publish({ ...fixture.run, status: "paused" });
    expect(screen.getByText("New live findings")).toBeDefined();
  });
  it("pauses and resumes through authoritative updates while leaving the composer available", async () => {
    using fixture = renderWorkflow();
    await fixture.user.click(await screen.findByRole("button", { name: "Pause" }));
    await fixture.user.click(await screen.findByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeDefined();
    expect(fixture.pause).toHaveBeenCalledTimes(1);
    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox")).toBeDefined();
  });
  it("shows stopping until cancellation settles rather than prematurely showing stopped", async () => {
    using fixture = renderWorkflow();
    await fixture.user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("stopping", { exact: true })).toBeDefined();
    expect(screen.queryByText("stopped", { exact: true })).toBeNull();
    await fixture.publish({
      ...fixture.run,
      status: "stopped",
      steps: fixture.run.steps.map((step) => ({ ...step, status: "aborted" })),
    });
    expect(await screen.findByText("stopped", { exact: true })).toBeDefined();
  });
  it("surfaces control failures and permits an explicit retry without duplicating commands", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const pause = vi.fn<Client["workflows"]["pause"]>(async () => {
      await Effect.runPromise(Deferred.await(gate));
      if (pause.mock.calls.length === 1) throw new Error("Control service unavailable");
    });
    using fixture = renderWorkflow({ client: { workflows: { pause } } });
    const button = await screen.findByRole("button", { name: "Pause" });
    await fixture.user.click(button);
    await fixture.user.click(button);
    expect(pause).toHaveBeenCalledTimes(1);
    await act(async () => {
      Effect.runSync(Deferred.succeed(gate, undefined));
    });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Control service unavailable",
    );
    await fixture.user.click(button);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(pause).toHaveBeenCalledTimes(2);
    // Even successful command acknowledgements do not fabricate a paused status.
    expect(screen.getByText("running", { exact: true })).toBeDefined();
  });
  it("retains completed and interrupted runs for inspection and deliberate relaunch", async () => {
    using fixture = renderWorkflow({ status: "complete" });
    await fixture.user.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByRole("region", { name: "Workflow result" })).toHaveProperty(
      "textContent",
      expect.stringContaining("Authentication audit complete"),
    );
    await fixture.publish(workflowRunFixture({ status: "interrupted" }));
    expect(
      await screen.findAllByText("Execution interrupted; relaunch explicitly to continue"),
    ).toHaveLength(2);
    expect(fixture.relaunch).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(fixture.relaunch).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("running", { exact: true })).toBeDefined();
  });
  it("saves a parameterized run for reuse in the selected project or personal location", async () => {
    using fixture = renderWorkflow({ status: "complete" });
    await fixture.user.click(await screen.findByRole("button", { name: "Details" }));
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    expect(screen.getByRole("region", { name: "Workflow parameters" }).textContent).toContain(
      "routes/auth",
    );
    await fixture.user.clear(name);
    await fixture.user.type(name, "audit-reusable");
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Save location" }),
      "personal",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(
      await screen.findByText("Saved to personal: /personal/workflows/audit-reusable.js"),
    ).toBeDefined();
    expect(fixture.save).toHaveBeenCalledWith(
      {
        sessionId: fixture.run.ownerSessionId,
        runId: fixture.run.id,
        name: "audit-reusable",
        location: "personal",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Save location" }),
      "project",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(
      await screen.findByText("Saved to project: /project/.cake/workflows/audit-reusable.js"),
    ).toBeDefined();
  });
  it("shows Project-owned run progress in Cake Chat without giving it a sandbox execution owner", async () => {
    using fixture = renderWorkflow({ cakeChat: true });
    const cards = await screen.findByRole("region", { name: "Workflow runs" });
    expect(within(cards).getByText("audit-auth")).toBeDefined();
    expect(fixture.observe).toHaveBeenCalledWith({ sessionId: "workflow-session" });
    await fixture.user.click(within(cards).getByRole("button", { name: "Pause" }));
    expect(await within(cards).findByText("paused", { exact: true })).toBeDefined();
    expect(fixture.pause).toHaveBeenCalledWith(
      { sessionId: "workflow-session", runId: fixture.run.id },
      expect.anything(),
    );
    expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
  });
  it("releases detail observations on close without cancelling the backend run", async () => {
    using fixture = renderWorkflow();
    await fixture.user.click(await screen.findByRole("button", { name: "Details" }));
    await screen.findByRole("region", { name: "Frozen workflow source" });
    await fixture.user.click(screen.getByRole("button", { name: "Close Workflow details" }));
    await waitFor(() => expect(fixture.detailClosed).toHaveBeenCalledTimes(1));
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(screen.getByText("running", { exact: true })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByRole("region", { name: "Frozen workflow source" });
    expect(fixture.observeRun).toHaveBeenCalledTimes(2);
  });
});
