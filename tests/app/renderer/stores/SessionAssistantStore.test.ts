import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../../src/domain/conversations/conversation-data";
import {
  isSessionAssistantThread,
  sessionAssistantThreadPath,
  type DiscussionThread,
} from "../../../../src/domain/discussion-sessions/discussion-session-data";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../../src/renderer/reducers/DiscussionReducer";
import { ActiveProjectSessionContext } from "../../../../src/renderer/stores/context/ActiveProjectSessionContext";
import { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import { SessionAssistantStore } from "../../../../src/renderer/stores/SessionAssistantStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { mountWithClient } from "../mount-with-client";

const tool = {
  command: "sessions.open",
  topic: "sessions",
  summary: "Open a session",
  parameters: { type: "object", properties: {} },
};

class AssistantHarnessStore extends Store<{
  sessionRegistry: SessionRegistryStore;
  projection: RootProjection;
  operations: SessionOperationCoordinatorStore;
  staged(): boolean;
}> {
  [ActiveProjectSessionContext.provide]() {
    return { sessionId: "parent-1", workingDirectory: "/project" };
  }

  @child
  get reviews(): ReviewsStore {
    return createStore(ReviewsStore, {
      sessionRegistry: this.props.sessionRegistry,
      discussionSessionModel: (sessionId, workingDirectory) =>
        this.props.projection.discussionConversation(sessionId, workingDirectory),
      operations: this.props.operations,
      modelPresets: () => [],
      openModelPresetSettings: () => undefined,
    });
  }

  @child
  get assistant(): SessionAssistantStore {
    return createStore(SessionAssistantStore, {
      sessionId: "parent-1",
      workspacePath: "/project",
      staged: this.props.staged,
      stagedMessages: () => [{ role: "user", text: "Draft the plan" }],
      thread: () =>
        this.props.projection.discussionCatalog("parent-1").threads.find(isSessionAssistantThread),
      tools: () => [tool],
      discussionSession: (threadId) => this.reviews.discussionSession(threadId),
    });
  }
}

const assistantThread: DiscussionThread = {
  id: "assistant-thread",
  workingDirectory: "/project",
  parentSessionId: "parent-1",
  sidecarSessionId: "sidecar-assistant",
  anchor: {
    path: sessionAssistantThreadPath("parent-1"),
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

const conversation = (
  sessionId: string,
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot => ({
  sessionId,
  sessionFile: `/reviews/${sessionId}.jsonl`,
  parts: [],
  models: [],
  thinkingLevel: "low",
  availableThinkingLevels: ["off", "low"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
  ...overrides,
});

function fixture(options: { threadListed: boolean; staged?: boolean }, client: object) {
  const projection = RootProjection.create({});
  const parent = projection.projectConversation("parent-1", "/project");
  applyConversationSnapshot(parent, conversation("parent-1"));
  const discussionCatalog = projection.discussionCatalog("parent-1");
  const listThread = (thread: DiscussionThread) =>
    applyDiscussionCatalogUpdate(discussionCatalog, "parent-1", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "parent-1",
      threads: [thread],
    });
  const observeSidecar = (parts: ConversationSnapshot["parts"] = [], streaming = false) => {
    const sidecar = projection.discussionConversation("sidecar-assistant", "/project");
    applyDiscussionSessionUpdate(sidecar, sidecar.sessionId, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        identity: {
          _tag: "DiscussionSession",
          sessionId: sidecar.sessionId,
          parentSessionId: "parent-1",
        },
        conversation: conversation(sidecar.sessionId, { parts, streaming }),
      },
    });
    return sidecar;
  };
  if (options.threadListed) {
    listThread(assistantThread);
    observeSidecar();
  }
  const parentSession = { model: parent, props: { discussionCatalog } };
  const sessionRegistry = {
    sessions: [parentSession],
    findModel: (sessionId: string) => (sessionId === "parent-1" ? parent : undefined),
    findSession: (sessionId: string) => (sessionId === "parent-1" ? parentSession : undefined),
  } as unknown as SessionRegistryStore;
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const mounted = mountWithClient(
    createStore(AssistantHarnessStore, {
      sessionRegistry,
      projection,
      operations,
      staged: () => options.staged ?? false,
    }),
    client as unknown as Client,
  );
  return {
    ...mounted,
    assistant: mounted.subject.assistant,
    projection,
    listThread,
    observeSidecar,
    dispose() {
      mounted.root[Symbol.dispose]();
      operations[Symbol.dispose]();
      projection[Symbol.dispose]();
    },
  };
}

const settle = (
  sidecar: ReturnType<typeof RootProjection.prototype.discussionConversation>,
  turnId = TurnId.make(crypto.randomUUID()),
) => {
  const sessionId = sidecar.sessionId;
  applyDiscussionSessionUpdate(sidecar, sessionId, {
    _tag: "Event",
    revision: 2,
    sessionId,
    event: {
      _tag: "PartUpdated",
      sessionId,
      part: {
        id: "user-1",
        kind: "text",
        role: "user",
        text: "Where is the plan?",
        status: "complete",
      },
    },
  });
  applyDiscussionSessionUpdate(sidecar, sessionId, {
    _tag: "Event",
    revision: 3,
    sessionId,
    event: {
      _tag: "PartUpdated",
      sessionId,
      part: {
        id: "assistant-1",
        kind: "text",
        role: "assistant",
        text: "It is in docs/plan.md.",
        status: "complete",
      },
    },
  });
  applyDiscussionSessionUpdate(sidecar, sessionId, {
    _tag: "Event",
    revision: 4,
    sessionId,
    event: { _tag: "StreamingChanged", sessionId, streaming: false },
  });
  applyDiscussionSessionUpdate(sidecar, sessionId, {
    _tag: "Event",
    revision: 5,
    sessionId,
    event: { _tag: "TurnSettled", sessionId, turnId, outcome: "complete" },
  });
};

describe("SessionAssistantStore", () => {
  it("starts the assistant side chat with the first quick prompt, then answers the bubble from its reply", async () => {
    const turnId = TurnId.make(crypto.randomUUID());
    const ensureSessionAssistant = vi.fn(async () => ({ thread: assistantThread, turnId }));
    const prompt = vi.fn(async () => crypto.randomUUID());
    const { assistant, listThread, observeSidecar, dispose } = fixture(
      { threadListed: false },
      { discussionSessions: { ensureSessionAssistant }, sessionChats: { prompt } },
    );
    assistant.beginQuickPrompt("plan");
    expect(assistant.quickChatStore.composerVisible).toBe(true);

    const submission = assistant.quickChatStore.submit("Where is the plan?");
    await vi.waitFor(() => expect(ensureSessionAssistant).toHaveBeenCalledOnce());
    // Like any side chat, the first message creates the sidecar; the parent
    // composer's selection rides along as user context.
    expect(ensureSessionAssistant).toHaveBeenCalledWith(
      {
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        tools: [tool],
        staged: false,
        stagedMessages: [],
        firstPrompt: {
          text: "Where is the plan?",
          annotations: [expect.objectContaining({ selectedText: "plan", endOffset: 4 })],
        },
      },
      expect.any(Object),
    );
    // Thinking bubble while the sidecar is created and observed.
    expect(assistant.processing).toBe(true);
    expect(assistant.quickChatStore.composerVisible).toBe(false);

    listThread(assistantThread);
    const sidecar = observeSidecar(
      [
        {
          id: "user-1",
          kind: "text",
          role: "user",
          text: "Where is the plan?",
          status: "complete",
        },
      ],
      true,
    );
    await Promise.resolve();
    // The started turn is not sent a second time.
    expect(prompt).not.toHaveBeenCalled();
    expect(assistant.processing).toBe(true);
    expect(assistant.quickParts).toEqual([]);

    settle(sidecar, turnId);
    await expect(submission).resolves.toBe(true);
    expect(assistant.processing).toBe(false);
    expect(assistant.quickParts.map((part) => part.kind === "text" && part.text)).toEqual([
      "It is in docs/plan.md.",
    ]);
    expect(assistant.quickResponseRevision).toBe(1);
    expect(assistant.quickChatStore.composerVisible).toBe(false);
    // The selection is not resent with the next message.
    expect(assistant.composerSelection).toBeUndefined();
    dispose();
  });

  it("shows a reply that settled before this window observed the new sidecar", async () => {
    const turnId = TurnId.make(crypto.randomUUID());
    const ensureSessionAssistant = vi.fn(async () => ({ thread: assistantThread, turnId }));
    const { assistant, listThread, observeSidecar, dispose } = fixture(
      { threadListed: false },
      { discussionSessions: { ensureSessionAssistant }, sessionChats: {} },
    );
    const submission = assistant.quickChatStore.submit("Quick one");
    await vi.waitFor(() => expect(ensureSessionAssistant).toHaveBeenCalledOnce());
    listThread(assistantThread);
    // The first snapshot already contains the completed exchange.
    observeSidecar([
      { id: "user-1", kind: "text", role: "user", text: "Quick one", status: "complete" },
      { id: "assistant-1", kind: "text", role: "assistant", text: "Done.", status: "complete" },
    ]);
    await expect(submission).resolves.toBe(true);
    expect(assistant.quickParts.map((part) => part.kind === "text" && part.text)).toEqual([
      "Done.",
    ]);
    dispose();
  });

  it("reuses the existing assistant sidecar and exposes the shared side chat as its full chat", async () => {
    const ensureSessionAssistant = vi.fn(async () => ({ thread: assistantThread }));
    const prompt = vi.fn(async () => crypto.randomUUID());
    const abort = vi.fn(async () => undefined);
    const { assistant, projection, dispose } = fixture(
      { threadListed: true },
      { discussionSessions: { ensureSessionAssistant }, sessionChats: { prompt, abort } },
    );
    const sidecar = projection.findDiscussionConversation("sidecar-assistant")!;
    const chat = assistant.chatStore;

    // The full chat is the side chat's own conversation Store, not a bespoke one.
    expect(chat).toBe(assistant.discussion?.chatStore);
    expect(chat.inputLabel).toBe("Message session assistant");
    expect(chat.placeholder).toBe("Ask the session assistant…");
    expect(chat.composerVisible).toBe(true);

    await chat.submit("Open the other session");
    expect(ensureSessionAssistant).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sidecar-assistant", text: "Open the other session" }),
      expect.any(Object),
    );

    applyDiscussionSessionUpdate(sidecar, sidecar.sessionId, {
      _tag: "Event",
      revision: 2,
      sessionId: sidecar.sessionId,
      event: { _tag: "StreamingChanged", sessionId: sidecar.sessionId, streaming: true },
    });
    expect(chat.composerVisible).toBe(true);
    expect(chat.canStop).toBe(true);
    await chat.abort();
    expect(abort).toHaveBeenCalledWith({ sessionId: "sidecar-assistant" }, expect.any(Object));
    dispose();
  });

  it("supplies a staged parent's messages when creating the assistant", async () => {
    const ensureSessionAssistant = vi.fn(async () => ({ thread: assistantThread }));
    const { assistant, dispose } = fixture(
      { threadListed: false, staged: true },
      { discussionSessions: { ensureSessionAssistant }, sessionChats: {} },
    );
    void assistant.quickChatStore.submit("Hello");
    await vi.waitFor(() => expect(ensureSessionAssistant).toHaveBeenCalledOnce());
    expect(ensureSessionAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        staged: true,
        stagedMessages: [{ role: "user", text: "Draft the plan" }],
      }),
      expect.any(Object),
    );
    await assistant.quickChatStore.abort();
    dispose();
  });
});
