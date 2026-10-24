/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Queue, Stream } from "effect";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { applicationEventSchema } from "../../../src/contracts/application/cake-rpc-contract";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { InterviewRecord } from "../../../src/contracts/interviews/interview";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { observeApplicationEvents } from "../../../src/renderer/observers/application-events";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { artifactRevision, referenceMetadata } from "./artifact-reference-workflow-fixture";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { observerClient, observerRuntime } from "./observers/observer-test-runtime";
import {
  handleId,
  parentSessionId,
  workerActivity,
  workerTranscript,
} from "./subagent-activity-workflow-fixture";
import type { TestClientOverrides } from "./test-client";

const snapshot = (sessionId: string, parts: UiPart[] = []): ConversationSnapshot => ({
  sessionId,
  sessionFile: `/sessions/${sessionId}.jsonl`,
  parts,
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

function mountNested(client: TestClientOverrides, worker?: ReturnType<typeof workerActivity>) {
  const fixture = createRendererStoreFixture({
    client: {
      ...client,
      projectSessions: { open: async () => undefined, ...client.projectSessions },
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
    },
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: parentSessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(parentSessionId, "/project");
  applyConversationSnapshot(
    session.model,
    snapshot(parentSessionId, worker ? workerTranscript() : []),
  );
  fixture.root.navigationStore.selectProjectSession(parentSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(parentSessionId);
  if (worker)
    applySubagentUpdate(fixture.models.subagentCatalog(parentSessionId), parentSessionId, {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId,
      activities: [worker],
      backgroundActive: false,
    });
  else {
    applyDiscussionCatalogUpdate(
      fixture.models.discussionCatalog(parentSessionId),
      parentSessionId,
      {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId,
        threads: [
          {
            id: "thread",
            sidecarSessionId: "sidecar",
            parentSessionId,
            workingDirectory: "/project",
            anchor: {
              path: `session:${parentSessionId}`,
              view: "session",
              start: { diffLine: 0 },
              end: { diffLine: 0 },
              selectedText: "",
              contextBefore: "",
              contextAfter: "",
              diff: "",
            },
            parts: [],
            status: "open",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    );
    applyDiscussionSessionUpdate(
      fixture.models.discussionConversation("sidecar", "/project"),
      "sidecar",
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          identity: { _tag: "DiscussionSession", sessionId: "sidecar", parentSessionId },
          conversation: snapshot("sidecar"),
        },
      },
    );
  }
  for (const chat of [
    session.conversationSessionStore.chatStore,
    ...session.subagentActivityStore.chatStores,
    ...fixture.root.reviewsStore.discussionSessions.map((discussion) => discussion.chatStore),
  ])
    chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const events = Effect.runSync(Queue.unbounded<typeof applicationEventSchema.Type>());
  const runtime = observerRuntime(
    observerClient({ events: { application: () => Stream.fromQueue(events) } }),
  );
  const stop = observeApplicationEvents(runtime, fixture.root);
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        <App />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    async emit(event: typeof applicationEventSchema.Type) {
      await act(async () => {
        Queue.offerUnsafe(events, event);
        await Effect.runPromise(Queue.take(runtime.consumed));
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      stop();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

const interview = (sessionId: string): InterviewRecord => ({
  id: "same-call",
  sessionId,
  request: {
    protocol: "cake.request/v1",
    id: "choice",
    title: "Choose",
    responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    view: { type: "form", fields: [{ id: "answer", label: "Answer", type: "text" }] },
    fallback: { markdown: "Choose" },
  },
});

describe("child-scoped nested interaction routing", () => {
  it("answers a live sidecar interview before its tool projection while preserving the parent's separate request", async () => {
    const respond = vi.fn<Client["interviews"]["respond"]>(async () => undefined);
    using fixture = mountNested({ interviews: { respond } });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(
      within(screen.getByRole("dialog", { name: "Open side chats" })).getByRole("button"),
    );
    await fixture.emit({
      type: "interview-requested",
      requestId: "parent-operation",
      interviewRequestId: "parent-request",
      record: interview(parentSessionId),
    });
    await fixture.emit({
      type: "interview-requested",
      requestId: "sidecar-operation",
      interviewRequestId: "sidecar-request",
      record: interview("sidecar"),
    });
    const panel = within(screen.getByRole("complementary", { name: "Side chat" }));
    await fixture.user.type(
      await panel.findByRole("textbox", { name: "Answer" }),
      "Use the child context",
    );
    await fixture.user.click(panel.getByRole("button", { name: "Review" }));
    await fixture.user.click(panel.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        {
          operationId: "sidecar-operation",
          interviewRequestId: "sidecar-request",
          sessionId: "sidecar",
          value: { answer: "Use the child context" },
          cancelled: false,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.getByRole("textbox", { name: "Answer" })).toBeDefined();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "loads a worker's retained image through public parent/handle access (released: %s)",
    async (released) => {
      const reference = {
        kind: "input" as const,
        id: "4a3d9c1e-5b2f-4c8a-9e7d-6f1a2b3c4d5e",
        name: "worker.png",
        mimeType: "image/png",
        byteLength: 68,
      };
      const readAttachment = vi.fn<Client["subagents"]["readAttachment"]>(async () => ({
        kind: "image",
        reference,
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=",
      }));
      using fixture = mountNested(
        {
          subagents: { readAttachment },
          artifacts: {
            referenceMetadata: async (reference) => referenceMetadata(reference),
            readExact: async (id, revision) => artifactRevision(id, revision),
          },
        },
        workerActivity({
          projectPath: "/worker-project",
          released,
          status: released ? "complete" : "running",
          streaming: !released,
          parts: [
            {
              id: "worker-image",
              kind: "attachment",
              attachmentKind: "image",
              role: "user",
              name: reference.name,
              mediaType: "image/png",
              inputReference: reference,
            },
            {
              id: "worker-publication",
              kind: "tool",
              name: "cake",
              command: "artifacts.present",
              input: "",
              state: "success",
              artifactId: "report",
              artifactReference: "cake://artifact/report@r1",
            },
          ],
        }),
      );
      const summary = (await screen.findByText("Work log")).closest("summary");
      if (!summary) throw new Error("Missing work log disclosure");
      await fixture.user.click(summary);
      await fixture.user.click(await screen.findByRole("button", { name: "Open subagent chat" }));
      const panel = within(screen.getByRole("complementary", { name: "Subagent" }));
      expect((await panel.findByRole("img", { name: reference.name })).getAttribute("src")).toBe(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=",
      );
      expect(readAttachment).toHaveBeenCalledExactlyOnceWith(
        { parentSessionId, handleId, reference: reference.id },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(await panel.findByText("report content r1")).toBeDefined();
      expect(panel.queryByRole("button", { name: "Copy attachment link" })).toBeNull();
      if (released) expect(panel.queryByRole("combobox")).toBeNull();
    },
  );
});
