import { applySnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  type CakeChatControlRequest,
} from "../../../../src/contracts/cake-chats/cake-chat-data";
import { TurnId } from "../../../../src/contracts/conversations/conversation-data";
import type { JsonValue } from "../../../../src/contracts/serialization/json-contract";
import type { ProjectSessionControlRequest } from "../../../../src/contracts/project-sessions/project-session-data";
import { applyCakeChatControlUpdate } from "../../../../src/renderer/reducers/CakeChatControlReducer";
import { fixtureTimestamp, projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import type { TestClientOverrides } from "../test-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const projectPath = "/project";
const requestId = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;

function createControlFixture(client: TestClientOverrides) {
  return createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    sessions: [sessionSummary({ sessionId: "parent", projectPath })],
  });
}

const projectRequest = (id: number): ProjectSessionControlRequest => ({
  sessionId: "parent",
  controlRequestId: requestId(id),
  invocation: { _tag: "InvokeAppControl", command: "app.state", input: {} },
});

const childRequest = (id: number, childSessionId: string): ProjectSessionControlRequest => ({
  sessionId: "parent",
  controlRequestId: requestId(id),
  invocation: {
    _tag: "ProjectChildSession",
    childSessionId,
    title: "Child",
    familyId: "family",
    familyChildOrder: 0,
    familyDepth: 1,
    workingDirectory: projectPath,
    placement: "none",
  },
});

interface ProjectReply {
  sessionId: string;
  controlRequestId: string;
  result: JsonValue;
}

// Agent-control transport is externally initiated, not an ordinary GUI workflow.
// Exercise its real Root/Models/Stores, host adapter and protocol bridge with typed
// external Client services. Do not invent buttons or replace collaborating Stores
// with callbacks. Existing root-app/app-shell/navigation/workbench/browser/Draw/
// Cake Chat workflows own GUI transitions; RootStore's transport suite owns pane
// placement. These regressions specifically cover correlation, accepted-request
// replay, failed delivery and disposal rather than repeating those GUI journeys.
describe("Application control transport integration", () => {
  it("correlates the real app projection and accepts a Project request only once, including during response delivery", async () => {
    const delivery = deferred<void>();
    const responding = deferred<void>();
    const replies: ProjectReply[] = [];
    using fixture = createControlFixture({
      projectSessions: {
        respondControl: async (sessionId, controlRequestId, result) => {
          replies.push({ sessionId, controlRequestId, result });
          responding.resolve();
          await delivery.promise;
        },
      },
    });
    const request = projectRequest(1);
    const store = fixture.root.applicationControlStore;

    const pending = store.handleProjectSessionRequest(request);
    await responding.promise;
    await store.handleProjectSessionRequest(request);
    delivery.resolve();
    await pending;
    await store.handleProjectSessionRequest(request);

    expect(replies).toEqual([
      {
        sessionId: "parent",
        controlRequestId: requestId(1),
        result: expect.objectContaining({
          ok: true,
          command: "app.state",
          state: expect.objectContaining({
            selection: { kind: "workbench" },
            projectCount: 1,
            sessionCount: 1,
            projects: [{ path: projectPath, name: "Project", sessionCount: 1 }],
            recentSessions: [expect.objectContaining({ sessionId: "parent" })],
          }),
        }),
      },
    ]);
  });

  it("responds to child success, failed opening and invalid invocation without repeating accepted mutations", async () => {
    const opened: string[] = [];
    const replies: ProjectReply[] = [];
    using fixture = createControlFixture({
      projectSessions: {
        open: async ({ sessionId }) => {
          opened.push(sessionId);
          if (sessionId === "failed-child") throw new Error("child failed");
        },
        respondControl: async (sessionId, controlRequestId, result) => {
          replies.push({ sessionId, controlRequestId, result });
        },
      },
    });
    const store = fixture.root.applicationControlStore;
    const requests: ProjectSessionControlRequest[] = [
      childRequest(2, "child-1"),
      childRequest(3, "failed-child"),
      {
        sessionId: "parent",
        controlRequestId: requestId(4),
        invocation: { _tag: "InvokeAppControl", command: "sessions.open", input: {} },
      },
    ];

    for (const request of requests) {
      await store.handleProjectSessionRequest(request);
      await store.handleProjectSessionRequest(request);
    }

    expect(opened).toEqual(["child-1", "failed-child"]);
    expect(replies).toEqual([
      {
        sessionId: "parent",
        controlRequestId: requestId(2),
        result: { ok: true, childSessionId: "child-1", placement: "none" },
      },
      {
        sessionId: "parent",
        controlRequestId: requestId(3),
        result: { ok: false, error: "child failed" },
      },
      {
        sessionId: "parent",
        controlRequestId: requestId(4),
        result: expect.objectContaining({
          ok: false,
          command: "sessions.open",
          error: expect.any(String),
        }),
      },
    ]);
    expect(fixture.root.sessionCatalogStore.find("child-1")).toMatchObject({
      familyId: "family",
      familyParentSessionId: "parent",
      pending: true,
    });
    expect(fixture.root.sessionRegistry.findSession("failed-child")).toBeUndefined();
    expect(fixture.root.sessionCatalogStore.find("failed-child")).toBeUndefined();
  });

  it("consumes replayed Cake Chat control snapshots once and reports a failed response through the real error owner", async () => {
    const replayConsumed = deferred<void>();
    const replies: { controlRequestId: string; result: JsonValue }[] = [];
    using fixture = createControlFixture({
      cakeChats: {
        respondControl: async (controlRequestId, result) => {
          replies.push({ controlRequestId, result });
          if (controlRequestId === requestId(5)) throw new Error("request expired");
          replayConsumed.resolve();
        },
      },
    });
    const request: CakeChatControlRequest = {
      _tag: "ControlRequested",
      sessionId: CAKE_CHAT_SESSION_ID,
      controlRequestId: requestId(5),
      invocation: { name: "app.state", arguments: {} },
    };
    fixture.root.applicationControlStore.start();
    const controls = fixture.models.controlsForCakeChat(CAKE_CHAT_SESSION_ID);
    applySnapshot(fixture.models.cakeChatCatalog, {
      sessions: [
        {
          sessionId: CAKE_CHAT_SESSION_ID,
          title: "Cake Chat",
          resolved: false,
          unread: false,
          createdAt: fixtureTimestamp,
          modifiedAt: fixtureTimestamp,
          messageCount: 0,
        },
      ],
    });
    // A request may already be projected before its owning session is registered.
    applyCakeChatControlUpdate(controls, { _tag: "Snapshot", requests: [request] });
    fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
    applyCakeChatControlUpdate(controls, { _tag: "Snapshot", requests: [request] });

    await vi.waitFor(() =>
      expect(fixture.root.cakeChatCollectionStore.error).toBe("request expired"),
    );
    expect(fixture.root.cakeChatCollectionStore.errorDetails).toContain(
      "Cake Chat control response: app.state",
    );
    applyCakeChatControlUpdate(controls, { _tag: "Snapshot", requests: [] });
    // A fresh request proves the replayed snapshot was consumed, without sleeps
    // or assuming that one microtask is sufficient to finish bridge invocation.
    applyCakeChatControlUpdate(controls, {
      _tag: "Snapshot",
      requests: [request, { ...request, controlRequestId: requestId(7) }],
    });
    await replayConsumed.promise;
    expect(replies).toEqual([
      {
        controlRequestId: requestId(5),
        result: expect.objectContaining({ ok: true, command: "app.state" }),
      },
      {
        controlRequestId: requestId(7),
        result: expect.objectContaining({ ok: true, command: "app.state" }),
      },
    ]);
  });

  it.each(["success", "failure"] as const)(
    "does not deliver or report a session-creation %s that settles after control-owner disposal",
    async (outcome) => {
      const creation = deferred<TurnId>();
      const started = deferred<AbortSignal | undefined>();
      const replies: ProjectReply[] = [];
      using fixture = createControlFixture({
        projectSessions: {
          start: async (_input, options) => {
            started.resolve(options?.signal);
            return creation.promise;
          },
          respondControl: async (sessionId, controlRequestId, result) => {
            replies.push({ sessionId, controlRequestId, result });
          },
        },
      });
      const store = fixture.root.applicationControlStore;
      const workbench = fixture.root.projectWorkbenchStore;
      const pending = store.handleProjectSessionRequest({
        sessionId: "parent",
        controlRequestId: requestId(6),
        invocation: {
          _tag: "InvokeAppControl",
          command: "sessions.create",
          input: { workspacePath: projectPath, name: "Child", initialPrompt: "Start" },
        },
      });

      const signal = await started.promise;
      fixture.root[Symbol.dispose]();
      expect(signal?.aborted).toBe(true);
      if (outcome === "success")
        creation.resolve(TurnId.make("10000000-0000-4000-8000-000000000001"));
      else creation.reject(new Error("start failed"));
      await pending;

      expect(replies).toEqual([]);
      expect(workbench.error).toBeUndefined();
    },
  );
});
