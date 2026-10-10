/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TurnId,
  type ConversationSnapshot,
  type SessionChatPromptInput,
} from "../../../src/ipc/conversation-data";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { createCakeSessionRuntimeTurnController } from "../../../src/services/pi/runtime/cake-session-runtime-turn-controller";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const sessionId = "session-one";
const metadata = {
  version: 1 as const,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
  threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
  sequence: 1,
  expectsResponse: false,
  sender: { kind: "project-session" as const, sessionId: "source-session", title: "API review" },
};

/** Real Pi queue policy and projection; only the Pi SDK and transport are faked. */
function renderQueue(
  initial: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] },
) {
  let steering = [...initial.steering];
  let followUp = [...initial.followUp];
  let publish = () => {};
  const immediate: string[] = [];
  const pi = {
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: { getBranch: () => [] },
    prompt: vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
      if (options?.streamingBehavior === "steer") steering.push(text);
      else if (options?.streamingBehavior === "followUp") followUp.push(text);
      else immediate.push(text);
    }),
    steer: async (text: string) => {
      steering.push(text);
      return "queued";
    },
    followUp: async (text: string) => {
      followUp.push(text);
      return "queued";
    },
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
    clearQueue: () => {
      const queue = { steering, followUp };
      steering = [];
      followUp = [];
      return queue;
    },
    abort: vi.fn(async () => {}),
  } as unknown as AgentSession;
  const controller = createCakeSessionRuntimeTurnController({
    session: pi,
    isDisposed: () => false,
    allowUserBash: true,
    beforeIdleTurn: async () => {},
    withResponseRetries: (operation) => operation(),
    cancelResponseRetries: () => {},
    recovery: { onUserInput: () => {}, onAbort: () => {} },
    deliverTrackedUserMessage: (_text, _markdown, deliver) => deliver(),
    syncQueuedParts: () => publish(),
    emitPart: () => {},
    emitSnapshot: async () => publish(),
    emitSnapshotInBackground: () => publish(),
  });
  const reorder = vi.fn(async (input: { itemId: string; position: number }) => {
    await controller.reorderPendingMessage(input);
    return controller.listQueuedMessages();
  });
  const prompt = vi.fn(async (input: SessionChatPromptInput) => {
    await controller.prompt(
      input.text,
      "follow-up",
      [...input.attachments],
      input.renderUserMessageAsMarkdown,
    );
    return TurnId.make("10000000-0000-4000-8000-000000000001");
  });
  const fixture = createRendererStoreFixture({
    client: {
      sessionChats: {
        prompt,
        reorderQueuedMessage: reorder,
        removeQueuedMessage: ({ partId }) => controller.removeQueuedMessage(partId),
        steerQueuedMessage: ({ partId }) => controller.steerQueuedMessage(partId),
        sendQueuedMessageNow: async ({ partId }) =>
          (await controller.sendQueuedMessageNow(partId)).queued,
      },
    },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  const model = fixture.models.projectConversation(sessionId, "/project");
  let revision = 0;
  publish = () => {
    const snapshot: ConversationSnapshot = {
      sessionId,
      sessionFile: "/project/session-one.jsonl",
      parts: [
        {
          id: "assistant-1",
          kind: "text",
          role: "assistant",
          text: "Working",
          status: "streaming",
        },
        ...controller.queuedParts(),
      ],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: true,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    };
    applyConversationUpdate(model, { _tag: "Snapshot", revision: ++revision, snapshot });
  };
  publish();
  const view = render(
    <Chat
      store={session.conversationSessionStore.chatStore}
      embedded
      composerFocusEnabled={false}
    />,
  );
  return {
    user: userEvent.setup(),
    controller,
    prompt,
    reorder,
    pi,
    immediate,
    async enqueue(text: string) {
      const user = userEvent.setup();
      await user.type(screen.getByRole("combobox"), text);
      await user.click(screen.getByRole("button", { name: "Send" }));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
      controller.dispose();
    },
  };
}
function queuedTexts() {
  return within(screen.getByRole("list", { name: "Queued prompts" }))
    .getAllByRole("listitem")
    .map((item) => within(item).getByRole("button", { name: /^View queued message:/ }).textContent);
}
afterEach(cleanup);

describe("Prompt queue workflow", () => {
  it("projects commands in the shared queue with reordering and cancellation, without message-only edit or steering actions", async () => {
    using fixture = renderQueue({ followUp: ["Next task"], steering: [] });
    await act(async () => {
      await fixture.controller.queueCommand("/toolcompact");
    });
    expect(queuedTexts()).toEqual(["Next task", "/toolcompact"]);
    expect(screen.getByRole("button", { name: "Send now as steering: Next task" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit queued prompt: Next task" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Send now as steering: /toolcompact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit queued prompt: /toolcompact" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Move up: /toolcompact" }));
    expect(queuedTexts()).toEqual(["/toolcompact", "Next task"]);
    await fixture.user.click(
      screen.getByRole("button", { name: "Cancel queued message: /toolcompact" }),
    );
    expect(queuedTexts()).toEqual(["Next task"]);
    expect(fixture.pi.abort).not.toHaveBeenCalled();
  });

  it("interleaves user and agent inputs in both lanes and reorders through authoritative positions", async () => {
    using fixture = renderQueue({
      steering: ["First steer", encodeCrossSessionMessage("Agent steer", metadata)],
      followUp: [encodeCrossSessionMessage("Agent queued", metadata)],
    });
    await fixture.enqueue("User queued");
    expect(fixture.prompt).toHaveBeenCalledOnce();
    expect(queuedTexts()).toEqual(["First steer", "Agent steer", "Agent queued", "User queued"]);
    await fixture.user.click(screen.getByRole("button", { name: "Move up: User queued" }));
    expect(queuedTexts()).toEqual(["First steer", "Agent steer", "User queued", "Agent queued"]);
    await fixture.user.click(screen.getByRole("button", { name: "Move up: Agent steer" }));
    expect(queuedTexts()).toEqual(["Agent steer", "First steer", "User queued", "Agent queued"]);
    expect(fixture.reorder.mock.calls.map(([input]) => input.position)).toEqual([1, 1]);
    expect(screen.getByRole("group", { name: "Steering" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Queued" })).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move up: User queued" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move down: First steer" }).disabled,
    ).toBe(true);
  });

  it("appends promotion to steering and cancels individual agent or user items without demoting survivors", async () => {
    using fixture = renderQueue({
      steering: ["Existing steer"],
      followUp: [encodeCrossSessionMessage("Agent queued", metadata), "User queued"],
    });
    await fixture.user.click(
      screen.getByRole("button", { name: "Send now as steering: Agent queued" }),
    );
    expect(queuedTexts()).toEqual(["Existing steer", "Agent queued", "User queued"]);
    await fixture.user.click(screen.getByRole("button", { name: "Cancel steering: Agent queued" }));
    expect(queuedTexts()).toEqual(["Existing steer", "User queued"]);
    await fixture.user.click(
      screen.getByRole("button", { name: "Cancel queued message: User queued" }),
    );
    expect(queuedTexts()).toEqual(["Existing steer"]);
  });

  it("sends any queued item immediately without promoting or dropping the rest", async () => {
    using fixture = renderQueue({
      steering: ["Keep steering"],
      followUp: ["Keep queued", encodeCrossSessionMessage("Send agent now", metadata)],
    });
    await fixture.user.click(
      screen.getByRole("button", { name: "Stop and send now: Send agent now" }),
    );
    expect(fixture.pi.abort).toHaveBeenCalledOnce();
    expect(fixture.immediate).toEqual([encodeCrossSessionMessage("Send agent now", metadata)]);
    expect(queuedTexts()).toEqual(["Keep steering", "Keep queued"]);
  });

  it("restores an admitted user payload for editing and resubmits at the queue tail", async () => {
    using fixture = renderQueue();
    await fixture.enqueue("First");
    await fixture.enqueue("Second");
    await fixture.user.click(screen.getByRole("button", { name: "Edit queued prompt: First" }));
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("First");
    expect(queuedTexts()).toEqual(["Second"]);
    await fixture.user.type(screen.getByRole("combobox"), " revised");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(queuedTexts()).toEqual(["Second", "First revised"]);
  });

  it("does not expose invalid queue positions while another input is still being admitted", async () => {
    using fixture = renderQueue({ steering: [], followUp: ["First"] });
    let release = () => {};
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = fixture.prompt.getMockImplementation()!;
    fixture.prompt.mockImplementationOnce(async (input) => {
      await admission;
      return deliver(input);
    });
    await fixture.enqueue("Pending");
    expect(queuedTexts()).toEqual(["First", "Pending"]);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move down: First" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Cancel queued message: Pending" })
        .disabled,
    ).toBe(true);
    await act(async () => {
      release();
      await admission;
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move down: First" }).disabled,
    ).toBe(false);
    await fixture.user.click(screen.getByRole("button", { name: "Move up: Pending" }));
    expect(queuedTexts()).toEqual(["Pending", "First"]);
  });

  it("restores a failed admission to the draft and queues it on retry", async () => {
    using fixture = renderQueue();
    fixture.prompt.mockRejectedValueOnce(new Error("Runtime unavailable"));
    await fixture.enqueue("Retry this");
    expect(await screen.findByText("Runtime unavailable")).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("Retry this");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(queuedTexts()).toEqual(["Retry this"]);
    expect(fixture.prompt).toHaveBeenCalledTimes(2);
  });

  it("keeps queue order and displays a recoverable error when a mutation fails", async () => {
    using fixture = renderQueue({ steering: [], followUp: ["First", "Second"] });
    fixture.reorder.mockRejectedValueOnce(new Error("Queue unavailable"));
    await fixture.user.click(screen.getByRole("button", { name: "Move up: Second" }));
    expect(await screen.findByText("Queue unavailable")).toBeDefined();
    expect(queuedTexts()).toEqual(["First", "Second"]);
  });
});
