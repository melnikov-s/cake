import { expect, it, vi } from "vitest";
import type { InterviewRecord } from "../../../src/contracts/interviews/interview";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { Client } from "../../../src/renderer/client/Client";
import { applyPartUpdate } from "../../../src/renderer/reducers/SessionPartReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Narrow ownership regressions: nested host routing/rendering is verified in its
// own workflow suite. Keep the real Root/Discussion/Interview composition here.
function setup() {
  const respond = vi.fn<Client["interviews"]["respond"]>(async () => {});
  const fixture = createRendererStoreFixture({ client: { interviews: { respond } } });
  const sidecarSessionId = cakeChatSideChatSessionId(2);
  const thread: DiscussionThread = {
    id: "interview-thread",
    parentSessionId: CAKE_CHAT_SESSION_ID,
    sidecarSessionId,
    workingDirectory: "/project",
    anchor: {
      path: `session:${CAKE_CHAT_SESSION_ID}`,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  applyDiscussionCatalogUpdate(
    fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID),
    CAKE_CHAT_SESSION_ID,
    {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: CAKE_CHAT_SESSION_ID,
      threads: [thread],
    },
  );
  const parent = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const discussion = parent.sideChats.discussionSession(thread.id)!;
  const record: InterviewRecord = {
    id: "interview-call",
    sessionId: sidecarSessionId,
    request: {
      protocol: "cake.request/v1",
      id: "scope",
      title: "Choose scope",
      responseSchema: { type: "object" },
      view: { type: "form", fields: [{ id: "scope", label: "Scope", type: "text" }] },
      fallback: { markdown: "Choose scope" },
    },
  };
  const receive = (request = record) =>
    discussion.receive({
      type: "interview-requested",
      operationId: "operation",
      interviewRequestId: "request",
      record: request,
    });
  const project = (settled = false) =>
    applyPartUpdate(
      discussion.model.parts,
      {
        id: "tool-interview",
        kind: "tool",
        name: "cake",
        command: "interview.open",
        input: "",
        state: settled ? "success" : "running",
        interview: record,
        ...(settled ? { interviewResult: { interviewId: record.id, cancelled: true } } : {}),
      },
      sidecarSessionId,
    );
  return { ...fixture, respond, discussion, record, receive, project };
}

it("keeps sidecar interview identity and partial answers when live metadata arrives, and responds only to that sidecar", async () => {
  using fixture = setup();
  fixture.receive({ ...fixture.record, sessionId: CAKE_CHAT_SESSION_ID });
  expect(fixture.discussion.interviews).toHaveLength(0);
  expect(fixture.discussion.waitingForInterview).toBe(false);
  fixture.receive();
  const interview = fixture.discussion.interviews[0]!;
  interview.setValue("scope", "Only this side chat");
  fixture.project();
  expect(fixture.discussion.interviews[0]).toBe(interview);
  expect(interview.values.scope).toBe("Only this side chat");
  expect(fixture.discussion.waitingForInterview).toBe(true);
  await interview.respond({ scope: "Only this side chat" });
  expect(fixture.respond).toHaveBeenCalledExactlyOnceWith(
    {
      sessionId: fixture.record.sessionId,
      operationId: "operation",
      interviewRequestId: "request",
      value: { scope: "Only this side chat" },
      cancelled: false,
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(fixture.discussion.waitingForInterview).toBe(false);
  expect(fixture.discussion.interviews[0]?.submitted).toBe(true);
});

it("removes a settled sidecar interview's live correlation without removing its historical result", () => {
  using fixture = setup();
  fixture.receive();
  fixture.project();
  const interview = fixture.discussion.interviews[0];
  fixture.project(true);
  expect(fixture.discussion.waitingForInterview).toBe(false);
  expect(fixture.discussion.interviews[0]).toBe(interview);
  expect(interview?.requested).toBe(false);
  expect(interview?.cancelled).toBe(true);
});
