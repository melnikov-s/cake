import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createCakeSessionRuntimeTurnController } from "../../../../src/services/pi/runtime/cake-session-runtime-turn-controller";
import { encodeCrossSessionMessage } from "../../../../src/services/pi/cross-session-message";
import { projectQueuedMessages } from "../../../../src/services/pi/runtime/session-projection";
import { projectConversationDisplay } from "../../../../src/services/pi/runtime/conversation-display-projection";
import { appendToolCompactedBranch } from "../../../../src/services/pi/runtime/session-tool-compaction";
import {
  addResponseModeReminder,
  stripResponseModeReminder,
  responseModeReminders,
} from "../../../../src/services/pi/response-mode-reminders";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFixture(overrides: Partial<AgentSession> = {}) {
  const sessionManager = SessionManager.inMemory("/project");
  const session = {
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    prompt: vi.fn(async (content: string) => {
      sessionManager.appendMessage({ role: "user", content, timestamp: 0 });
    }),
    steer: vi.fn(async () => "queued" as const),
    followUp: vi.fn(async () => "queued" as const),
    compact: vi.fn(async () => undefined),
    executeBash: vi.fn(async () => ({ exitCode: 0, cancelled: false })),
    abortBash: vi.fn(),
    abort: vi.fn(async () => undefined),
    getSteeringMessages: vi.fn(() => []),
    getFollowUpMessages: vi.fn(() => []),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    sessionManager,
    ...overrides,
  } as unknown as AgentSession;
  const syncQueuedParts = vi.fn();
  const controller = createCakeSessionRuntimeTurnController({
    session,
    isDisposed: () => false,
    allowUserBash: true,
    beforeIdleTurn: async () => undefined,
    withResponseRetries: (operation) => operation(),
    cancelResponseRetries: vi.fn(),
    recovery: { onUserInput: vi.fn(), onAbort: vi.fn() },
    deliverTrackedUserMessage: (_content, _markdown, deliver) => deliver(),
    syncQueuedParts,
    emitPart: vi.fn(),
    emitSnapshot: async () => undefined,
    emitSnapshotInBackground: vi.fn(),
  });
  return { controller, session, syncQueuedParts };
}

describe("CakeSessionRuntime turn controller", () => {
  it("captures voice response style through prompt, steering, follow-up and compaction-held delivery", async () => {
    for (const delivery of ["prompt", "steer", "follow-up"] as const) {
      const { controller, session } = createFixture();
      await controller.prompt("Voice", delivery, [], false, undefined, undefined, "voice");
      expect(vi.mocked(session.prompt).mock.calls[0]?.[0]).toBe(
        addResponseModeReminder("Voice", "voice"),
      );
      controller.dispose();
    }
    const { controller, session } = createFixture({ isStreaming: true, isCompacting: true });
    await controller.prompt("Held voice", "follow-up", [], false, undefined, undefined, "voice");
    expect(session.prompt).not.toHaveBeenCalled();
    Object.assign(session, { isCompacting: false });
    controller.compactionEnded(false);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    expect(vi.mocked(session.prompt).mock.calls[0]?.[0]).toContain(responseModeReminders.voice);
    controller.dispose();
  });
  it("defaults to text and adds reminders only at voice/text transitions", async () => {
    const { controller, session } = createFixture();
    await controller.prompt("Initial text", "prompt", []);
    await controller.prompt("More text", "prompt", [], false, undefined, undefined, "text");
    await controller.prompt("Start voice", "prompt", [], false, undefined, undefined, "voice");
    await controller.prompt("Stay voice", "prompt", [], false, undefined, undefined, "voice");
    await controller.prompt("Back to text", "prompt", []);
    await controller.prompt("Stay text", "prompt", []);
    await controller.prompt("Voice again", "prompt", [], false, undefined, undefined, "voice");
    expect(vi.mocked(session.prompt).mock.calls.map(([text]) => text)).toEqual([
      "Initial text",
      "More text",
      addResponseModeReminder("Start voice", "voice"),
      "Stay voice",
      addResponseModeReminder("Back to text", "text"),
      "Stay text",
      addResponseModeReminder("Voice again", "voice"),
    ]);
    controller.dispose();
  });

  it("discloses only mode transitions and Tool Compact removes them from replay, resetting the default", async () => {
    const { controller, session } = createFixture();
    await controller.prompt("Initial text", "prompt", []);
    await controller.prompt("Start voice", "prompt", [], false, undefined, undefined, "voice");
    await controller.prompt("Stay voice", "prompt", [], false, undefined, undefined, "voice");
    await controller.prompt("Back to text", "prompt", []);
    await controller.prompt("Stay text", "prompt", []);
    // Finish in voice mode to prove compacted context does not inherit the removed guidance.
    await controller.prompt("Voice again", "prompt", [], false, undefined, undefined, "voice");
    const reminders = projectConversationDisplay(session.sessionManager).filter(
      (part) => part.kind === "context",
    );
    expect(reminders.map((part) => part.text)).toEqual([
      responseModeReminders.voice,
      responseModeReminders.text,
      responseModeReminders.voice,
    ]);
    const leaf = session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    });
    appendToolCompactedBranch(session.sessionManager, leaf);
    expect(
      session.sessionManager
        .buildSessionContext()
        .messages.map((message) =>
          message.role === "user" || message.role === "assistant" ? message.content : message.role,
        ),
    ).toEqual([
      "Initial text",
      "Start voice",
      "Stay voice",
      "Back to text",
      "Stay text",
      "Voice again",
      [{ type: "text", text: "Answer" }],
    ]);
    expect(
      projectConversationDisplay(session.sessionManager).filter((part) => part.kind === "context"),
    ).toEqual(
      reminders.map((part) => expect.objectContaining({ text: part.text, origin: "compacted" })),
    );
    await controller.prompt("Default text after compact", "prompt", []);
    await controller.prompt(
      "Voice after compact",
      "prompt",
      [],
      false,
      undefined,
      undefined,
      "voice",
    );
    expect(
      vi
        .mocked(session.prompt)
        .mock.calls.slice(-2)
        .map(([text]) => text),
    ).toEqual([
      "Default text after compact",
      addResponseModeReminder("Voice after compact", "voice"),
    ]);
    controller.dispose();
  });

  it("deduplicates response guidance against preceding queued and compaction-held inputs", async () => {
    for (const delivery of ["prompt", "steer", "follow-up"] as const) {
      for (const isCompacting of [false, true]) {
        const steering: string[] = [];
        const followUp: string[] = [];
        const { controller, session } = createFixture({
          isStreaming: true,
          isCompacting,
          prompt: vi.fn(async (text: string, options) => {
            (options?.streamingBehavior === "steer" ? steering : followUp).push(text);
          }),
          getSteeringMessages: () => steering,
          getFollowUpMessages: () => followUp,
        });
        await controller.prompt("Start voice", delivery, [], false, undefined, undefined, "voice");
        await controller.prompt("Stay voice", delivery, [], false, undefined, undefined, "voice");
        await controller.prompt("Back to text", delivery, []);
        await controller.prompt("Stay text", delivery, []);
        expect((await controller.pendingMessages()).items.map((item) => item.text)).toEqual([
          "Start voice",
          "Stay voice",
          "Back to text",
          "Stay text",
        ]);
        if (isCompacting) {
          Object.assign(session, { isCompacting: false });
          controller.compactionEnded(false);
          await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(4));
        }
        expect(vi.mocked(session.prompt).mock.calls.map(([text]) => text)).toEqual([
          addResponseModeReminder("Start voice", "voice"),
          "Stay voice",
          addResponseModeReminder("Back to text", "text"),
          "Stay text",
        ]);
        controller.dispose();
      }
    }
  });

  it("recovers the response mode from existing multimodal Pi history rather than controller lifetime", async () => {
    const sessionManager = SessionManager.inMemory("/project");
    sessionManager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: addResponseModeReminder("Earlier", "voice") },
        { type: "image", mimeType: "image/png", data: "AAA=" },
      ],
      timestamp: 0,
    });
    const { controller, session } = createFixture({ sessionManager });
    await controller.prompt("Still voice", "prompt", [], false, undefined, undefined, "voice");
    await controller.prompt("Now text", "prompt", []);
    expect(vi.mocked(session.prompt).mock.calls.map(([text]) => text)).toEqual([
      "Still voice",
      addResponseModeReminder("Now text", "text"),
    ]);
    controller.dispose();
  });

  it("omitted responseMode explicitly restores text guidance after a voice submission", async () => {
    const { controller, session } = createFixture();
    await controller.prompt("Spoken first", "prompt", [], false, undefined, undefined, "voice");
    await controller.prompt("Normal next", "prompt", []);
    expect(vi.mocked(session.prompt).mock.calls[0]?.[0]).toBe(
      addResponseModeReminder("Spoken first", "voice"),
    );
    expect(vi.mocked(session.prompt).mock.calls[1]?.[0]).toBe(
      addResponseModeReminder("Normal next", "text"),
    );
    controller.dispose();
  });
  it("reordered queued voice and text inputs each retain their own response style rather than a mutable mode flag", async () => {
    const queue: string[] = [];
    const { controller, session } = createFixture({
      isStreaming: true,
      prompt: vi.fn(async (text: string, options) => {
        if (options?.streamingBehavior) queue.push(text);
      }),
      getFollowUpMessages: () => queue,
      clearQueue: () => ({ steering: [], followUp: queue.splice(0) }),
      followUp: vi.fn(async (text: string) => {
        queue.push(text);
        return "queued" as const;
      }),
    });
    await controller.prompt("Voice", "follow-up", [], false, undefined, undefined, "voice");
    await controller.prompt("Text", "follow-up", []);
    const pending = await controller.pendingMessages();
    await controller.reorderPendingMessage({ itemId: pending.items[1]!.itemId, position: 1 });
    expect(queue).toEqual([
      addResponseModeReminder("Text", "text"),
      addResponseModeReminder("Voice", "voice"),
    ]);
    const part = controller.queuedParts()[1]!;
    await controller.sendQueuedMessageNow(part.id);
    expect(vi.mocked(session.prompt).mock.calls.at(-1)?.[0]).toBe(
      addResponseModeReminder("Voice", "voice"),
    );
    expect(queue).toEqual([addResponseModeReminder("Text", "text")]);
  });
  it("display, editable queue payloads and user-message projection exclude exact response-mode reminders", async () => {
    const { controller } = createFixture({ isStreaming: true, isCompacting: true });
    await controller.prompt("Visible voice", "prompt", [], false, undefined, "draw", "voice");
    const [part] = controller.queuedParts();
    expect(part).toMatchObject({
      kind: "text",
      text: "Visible voice",
      queuedInput: { text: "Visible voice" },
    });
    expect((await controller.pendingMessages()).items[0]?.text).toBe("Visible voice");
    expect(
      projectQueuedMessages([], [addResponseModeReminder("Visible text", "voice")])[0],
    ).toMatchObject({ text: "Visible text" });
  });
  it("voice decoration preserves built-in commands, attachments, cross-session provenance and presentation guidance", async () => {
    const { controller, session } = createFixture();
    await controller.prompt("/compact preserve", "prompt", [], false, undefined, "draw", "voice");
    expect(session.compact).toHaveBeenCalledWith("preserve");
    await controller.prompt("!pwd", "prompt", [], false, undefined, "draw", "voice");
    expect(session.executeBash).toHaveBeenCalledWith(
      "pwd",
      expect.any(Function),
      expect.any(Object),
    );
    const text = encodeCrossSessionMessage("Context", {
      version: 1,
      messageId: "00000000-0000-4000-8000-000000000001",
      threadId: "00000000-0000-4000-8000-000000000002",
      sequence: 1,
      expectsResponse: false,
      sender: {
        sessionId: "peer",
        title: "Peer",
        kind: "project-session",
        projectName: "Project",
        workingDirectory: "/project",
      },
    });
    await controller.prompt(
      text,
      "prompt",
      [{ kind: "image", name: "a.png", mimeType: "image/png", data: "AAA=" }],
      false,
      undefined,
      "draw",
      "voice",
    );
    const call = vi.mocked(session.prompt).mock.calls.at(-1)!;
    expect(call[0]).toContain(text);
    expect(call[0]).toContain("entered Draw");
    expect(call[0]).toContain(responseModeReminders.voice);
    expect(call[1]?.images).toEqual([{ type: "image", data: "AAA=", mimeType: "image/png" }]);
    expect(stripResponseModeReminder(call[0])).not.toContain("Cake response mode");
  });
  it("does not dispatch an accepted idle prompt after abort wins during preparation", async () => {
    const preparation = deferred();
    const { controller, session } = createFixture();
    const preparedController = createCakeSessionRuntimeTurnController({
      session,
      isDisposed: () => false,
      allowUserBash: true,
      beforeIdleTurn: () => preparation.promise,
      withResponseRetries: (operation) => operation(),
      cancelResponseRetries: vi.fn(),
      recovery: { onUserInput: vi.fn(), onAbort: vi.fn() },
      deliverTrackedUserMessage: (_content, _markdown, deliver) => deliver(),
      syncQueuedParts: vi.fn(),
      emitPart: vi.fn(),
      emitSnapshot: async () => undefined,
      emitSnapshotInBackground: vi.fn(),
    });

    const prompt = preparedController.prompt("Do work", "prompt", [], false, "turn-1");
    await preparedController.abort();
    preparation.resolve();

    await expect(prompt).rejects.toThrow("Session was aborted");
    expect(session.prompt).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("injects a hidden reminder only when the Project Session presentation changes", async () => {
    const branch: Array<{
      type: "message";
      message: { role: "user"; content: string };
    }> = [];
    const prompt = vi.fn(async (content: string) => {
      branch.push({ type: "message", message: { role: "user", content } });
    });
    const { controller } = createFixture({
      prompt,
      sessionManager: {
        getBranch: vi.fn(() => branch),
      } as unknown as AgentSession["sessionManager"],
    });

    await controller.prompt("Open this", "prompt", [], false, undefined, "vscode");
    await controller.prompt("Keep going", "prompt", [], false, undefined, "vscode");
    await controller.prompt("Summarize", "prompt", [], false, undefined, "normal");

    expect(prompt.mock.calls[0]?.[0]).toContain("entered embedded VS Code");
    expect(prompt.mock.calls[0]?.[0]).toContain("Open this");
    expect(prompt.mock.calls[1]?.[0]).toBe("Keep going");
    expect(prompt.mock.calls[2]?.[0]).toContain("returned to the normal conversation view");
    expect(prompt.mock.calls[2]?.[0]).toContain("Summarize");
  });

  it("keeps later compaction-held input visible and clearable while the first item runs", async () => {
    const delivery = deferred();
    const prompt = vi.fn(() => delivery.promise);
    const { controller, session } = createFixture({
      isStreaming: true,
      isCompacting: true,
      prompt,
    });

    await controller.prompt("First", "prompt", []);
    await controller.prompt("Second", "prompt", []);
    Object.assign(session, { isStreaming: false, isCompacting: false });
    controller.compactionEnded(false);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

    expect(await controller.listQueuedMessages()).toEqual({
      steering: [],
      followUp: ["Second"],
    });
    await expect(controller.clearQueue()).resolves.toEqual({
      steering: [],
      followUp: ["Second"],
    });
    delivery.resolve();
    await Promise.resolve();
    expect(session.followUp).not.toHaveBeenCalled();
  });

  it("rejects a correlated compaction-held turn when detached delivery fails", async () => {
    const { controller, session } = createFixture({
      isStreaming: true,
      isCompacting: true,
      prompt: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    });

    const accepted = controller.prompt("Do work", "prompt", [], false, "turn-1");
    Object.assign(session, { isStreaming: false, isCompacting: false });
    controller.compactionEnded(false);

    await expect(accepted).rejects.toThrow("delivery failed");
    expect(controller.executingTurnIds()).toEqual([]);
  });

  it("keeps compaction-held input queued without dispatching it when the session is aborted", async () => {
    const live = { followUp: [] as string[] };
    const { controller, session, syncQueuedParts } = createFixture({
      isStreaming: true,
      isCompacting: true,
      followUp: vi.fn(async (text: string) => {
        live.followUp.push(text);
        return "queued" as const;
      }),
      getFollowUpMessages: vi.fn(() => live.followUp),
      clearQueue: vi.fn(() => {
        const queued = { steering: [], followUp: [...live.followUp] };
        live.followUp = [];
        return queued;
      }),
    });

    const prompt = controller.prompt("Do work later", "prompt", [], false, "turn-1");
    await controller.abort();

    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.followUp).toHaveBeenCalledWith("Do work later", []);
    expect(await controller.listQueuedMessages()).toEqual({
      steering: [],
      followUp: ["Do work later"],
    });
    expect(controller.compactionQueuedMessages()).toEqual([]);
    expect(syncQueuedParts).toHaveBeenCalledTimes(2);

    const [part] = controller.queuedParts();
    await controller.removeQueuedMessage(part!.id);
    await expect(prompt).rejects.toThrow("Queued input was canceled");
  });

  describe("per-item edits of Pi's queue", () => {
    const partIds = (steering: string[], followUp: string[], pending: string[] = []) =>
      projectQueuedMessages(steering, followUp, pending).map((part) => part.id);

    function createQueuedFixture(queue: { steering: string[]; followUp: string[] }) {
      const live = { steering: [...queue.steering], followUp: [...queue.followUp] };
      return createFixture({
        isStreaming: true,
        prompt: vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
          if (options?.streamingBehavior === "steer") live.steering.push(text);
          else if (options?.streamingBehavior === "followUp") live.followUp.push(text);
        }),
        steer: vi.fn(async (text: string) => {
          live.steering.push(text);
          return "queued" as const;
        }),
        followUp: vi.fn(async (text: string) => {
          live.followUp.push(text);
          return "queued" as const;
        }),
        getSteeringMessages: vi.fn(() => live.steering),
        getFollowUpMessages: vi.fn(() => live.followUp),
        clearQueue: vi.fn(() => {
          const cleared = { steering: [...live.steering], followUp: [...live.followUp] };
          live.steering = [];
          live.followUp = [];
          return cleared;
        }),
      });
    }

    it("aborts active work without dispatching or dropping the held queue", async () => {
      const { controller, session } = createQueuedFixture({
        steering: ["Change direction"],
        followUp: ["Do this next"],
      });

      await controller.abort();

      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.prompt).not.toHaveBeenCalled();
      expect(await controller.listQueuedMessages()).toEqual({
        steering: ["Change direction"],
        followUp: ["Do this next"],
      });
    });

    it("stops and sends only the selected queued item while preserving the rest", async () => {
      const { controller, session } = createQueuedFixture({
        steering: ["Send immediately"],
        followUp: ["Keep queued"],
      });
      const [selectedId] = partIds(["Send immediately"], ["Keep queued"]);

      await expect(controller.sendQueuedMessageNow(selectedId)).resolves.toEqual({
        queued: { steering: [], followUp: ["Keep queued"] },
        abortedTurnIds: [],
      });

      expect(session.abort).toHaveBeenCalledOnce();
      expect(vi.mocked(session.prompt).mock.calls).toEqual([
        ["Send immediately", expect.objectContaining({ source: "interactive" })],
      ]);
      expect(await controller.listQueuedMessages()).toEqual({
        steering: [],
        followUp: ["Keep queued"],
      });
    });

    it("waits for an admitted steering message so rapid third-enter delivery cannot miss it", async () => {
      const { controller, session } = createQueuedFixture({ steering: [], followUp: [] });

      const sendNow = controller.sendQueuedMessageNow();
      await Promise.resolve();
      await controller.prompt("Rapid steering", "steer", []);

      await expect(sendNow).resolves.toEqual({
        queued: { steering: [], followUp: [] },
        abortedTurnIds: [],
      });
      expect(vi.mocked(session.prompt).mock.calls.at(-1)).toEqual([
        "Rapid steering",
        expect.objectContaining({ source: "interactive" }),
      ]);
    });

    it("removes one held follow-up, re-queues the rest in order, and cancels its correlation", async () => {
      const { controller, session, syncQueuedParts } = createQueuedFixture({
        steering: ["Change direction"],
        followUp: ["Do this next"],
      });
      const tracked = controller.prompt("Then this", "follow-up", [], false, "turn-then");
      const [, , thenThisId] = partIds(["Change direction"], ["Do this next", "Then this"]);

      await expect(controller.removeQueuedMessage(thenThisId!)).resolves.toEqual({
        steering: ["Change direction"],
        followUp: ["Do this next"],
      });

      await expect(tracked).rejects.toThrow("Queued input was canceled");
      expect(session.clearQueue).toHaveBeenCalledOnce();
      expect(
        vi.mocked(session.prompt).mock.calls.map(([text, options]) => [text, options]),
      ).toEqual([["Then this", expect.objectContaining({ streamingBehavior: "followUp" })]]);
      expect(session.steer).toHaveBeenCalledWith("Change direction", []);
      expect(session.followUp).toHaveBeenCalledWith("Do this next", []);
      expect(syncQueuedParts).toHaveBeenCalled();
    });

    it("promotes one held follow-up to steering without touching other correlations", async () => {
      const { controller, session } = createQueuedFixture({ steering: [], followUp: [] });
      const tracked = controller.prompt("Do this next", "follow-up", [], false, "turn-next");
      await controller.prompt("Then this", "follow-up", []);
      const next = "Do this next",
        then = "Then this";
      const [doThisNextId] = partIds([], [next, then]);

      await expect(controller.steerQueuedMessage(doThisNextId!)).resolves.toEqual({
        steering: [next],
        followUp: [then],
      });

      expect(session.steer).toHaveBeenCalledWith(next, []);
      expect(session.followUp).toHaveBeenCalledWith(then, []);
      controller.consumeUserMessage(next);
      controller.settleTurn();
      await expect(tracked).resolves.toBeUndefined();
    });

    it("reorders by stable identity with exact lane positions and preserves payload correlation", async () => {
      const { controller, session } = createQueuedFixture({ steering: [], followUp: [] });
      const attachment = {
        kind: "image" as const,
        name: "diagram.png",
        mimeType: "image/png",
        data: "aW1hZ2U=",
      };
      const first = controller.prompt("First", "follow-up", [attachment], false, "turn-first");
      await controller.prompt("Second", "follow-up", []);

      const initial = await controller.pendingMessages();
      expect(
        initial.items.map(({ lane, position, state, text }) => ({ lane, position, state, text })),
      ).toEqual([
        {
          lane: "follow-up",
          position: 1,
          state: "queued",
          text: expect.stringContaining("First"),
        },
        { lane: "follow-up", position: 2, state: "queued", text: "Second" },
      ]);
      const firstId = initial.items[0]!.itemId;
      expect(initial.items.map((item) => item.partId)).toEqual(
        partIds([], [...session.getFollowUpMessages()]),
      );

      const reordered = await controller.reorderPendingMessage({
        itemId: firstId,
        position: 2,
      });
      expect(reordered.items).toEqual([
        expect.objectContaining({ lane: "follow-up", position: 1, text: "Second" }),
        expect.objectContaining({ itemId: firstId, lane: "follow-up", position: 2 }),
      ]);
      expect(vi.mocked(session.followUp).mock.calls.at(-1)).toEqual([
        expect.stringContaining("First"),
        [expect.objectContaining({ data: "aW1hZ2U=" })],
      ]);

      const firstContent = vi.mocked(session.prompt).mock.calls[0]![0] as string;
      controller.consumeUserMessage(firstContent);
      controller.settleTurn();
      await expect(first).resolves.toBeUndefined();
    });

    it("projects cross-session queue metadata without exposing the routing envelope as text", async () => {
      const encoded = encodeCrossSessionMessage("Review the API", {
        version: 1,
        messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
        threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
        sequence: 1,
        expectsResponse: true,
        context: { usedTokens: 81_000, windowTokens: 128_000 },
        sender: {
          kind: "project-session",
          sessionId: "source-session",
          title: "Review",
        },
      });
      const { controller } = createQueuedFixture({ steering: [], followUp: [encoded] });

      expect((await controller.pendingMessages()).items).toEqual([
        expect.objectContaining({
          lane: "follow-up",
          position: 1,
          text: "Review the API",
          crossSession: expect.objectContaining({
            messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
            context: { usedTokens: 81_000, windowTokens: 128_000 },
          }),
        }),
      ]);
    });

    it("rejects stale identities and out-of-range positions without changing Pi's queue", async () => {
      const { controller, session } = createQueuedFixture({
        steering: [],
        followUp: ["Do this next"],
      });
      const [item] = (await controller.pendingMessages()).items;
      await expect(
        controller.reorderPendingMessage({
          itemId: item!.itemId,
          position: 3,
        }),
      ).rejects.toThrow("outside the follow-up lane");
      await expect(
        controller.reorderPendingMessage({
          itemId: "00000000-0000-4000-8000-000000000000",
          position: 1,
        }),
      ).rejects.toThrow("no longer exists");
      expect(session.clearQueue).not.toHaveBeenCalled();
    });

    it("leaves the queue untouched for an unknown part id", async () => {
      const { controller, session } = createQueuedFixture({
        steering: [],
        followUp: ["Do this next"],
      });

      await expect(controller.removeQueuedMessage("queued-follow-up-missing-1")).rejects.toThrow(
        "no longer available",
      );
      expect(await controller.listQueuedMessages()).toEqual({
        steering: [],
        followUp: ["Do this next"],
      });
      expect(session.clearQueue).not.toHaveBeenCalled();
      expect(session.prompt).not.toHaveBeenCalled();
    });

    it("edits compaction-held input in place", async () => {
      const { controller, session } = createFixture({ isStreaming: true, isCompacting: true });
      const removed = controller.prompt("Drop me", "prompt", [], false, "turn-drop");
      await controller.prompt("Steer me", "prompt", []);
      const [dropId, steerId] = partIds([], ["Drop me", "Steer me"]);
      expect((await controller.pendingMessages()).items).toEqual([
        expect.objectContaining({
          partId: dropId,
          lane: "follow-up",
          position: 1,
          state: "compaction-held",
          text: "Drop me",
        }),
        expect.objectContaining({
          lane: "follow-up",
          position: 2,
          partId: steerId,
          state: "compaction-held",
          text: "Steer me",
        }),
      ]);

      await expect(controller.removeQueuedMessage(dropId!)).resolves.toEqual({
        steering: [],
        followUp: ["Steer me"],
      });
      await expect(removed).rejects.toThrow("Queued input was canceled");

      await expect(controller.steerQueuedMessage(steerId!)).resolves.toEqual({
        steering: ["Steer me"],
        followUp: [],
      });
      expect(session.prompt).not.toHaveBeenCalled();
    });

    it("keeps sender-neutral order through mixed compaction queues, promotion, and cancellation", async () => {
      const { controller, session } = createQueuedFixture({
        steering: ["Live steer"],
        followUp: ["Live queued"],
      });
      Object.assign(session, { isCompacting: true });
      await controller.prompt("Held steer", "steer", []);
      await controller.prompt("Held queued", "follow-up", []);
      const initial = (await controller.pendingMessages()).items;
      const held = initial.find((item) => item.text === "Held queued")!;
      await controller.reorderPendingMessage({ itemId: held.itemId, position: 1 });
      expect((await controller.pendingMessages()).items.map((item) => item.text)).toEqual([
        "Live steer",
        "Held steer",
        "Held queued",
        "Live queued",
      ]);
      const queued = (await controller.pendingMessages()).items.find(
        (item) => item.text === "Live queued",
      )!;
      await controller.steerQueuedMessage(queued.partId!);
      expect((await controller.pendingMessages()).items.map((item) => item.text)).toEqual([
        "Live steer",
        "Held steer",
        "Live queued",
        "Held queued",
      ]);
      const steer = (await controller.pendingMessages()).items.find(
        (item) => item.text === "Held steer",
      )!;
      await controller.removeQueuedMessage(steer.partId!);
      expect(
        controller
          .queuedParts()
          .map((part) => part.kind === "text" && [part.text, part.deliveryState]),
      ).toEqual([
        ["Live steer", "steering"],
        ["Live queued", "steering"],
        ["Held queued", "queued"],
      ]);
      expect(
        (await controller.pendingMessages()).items.find((item) => item.text === "Held queued")!
          .itemId,
      ).toBe(held.itemId);
    });

    it("preserves payload identity through synchronous Pi queue-update callbacks during reorder", async () => {
      const { controller, session } = createQueuedFixture({ steering: [], followUp: [] });
      const attachment = {
        kind: "image" as const,
        name: "image.png",
        mimeType: "image/png",
        data: "aW1hZ2U=",
      };
      await controller.prompt("First", "follow-up", [attachment], true);
      await controller.prompt("Second", "follow-up", []);
      const first = (await controller.pendingMessages()).items[0]!;
      const clearQueue = session.clearQueue.bind(session);
      session.clearQueue = vi.fn(() => {
        const result = clearQueue();
        controller.queuedParts();
        return result;
      });
      const followUp = session.followUp.bind(session);
      session.followUp = vi.fn(async (text, images, options) => {
        const result = await followUp(text, images, options);
        controller.queuedParts();
        return result;
      });
      await controller.reorderPendingMessage({ itemId: first.itemId, position: 2 });
      expect(controller.queuedParts().at(-1)).toMatchObject({
        text: "First",
        queuedInput: {
          itemId: first.itemId,
          text: "First",
          attachments: [attachment],
          renderUserMessageAsMarkdown: true,
        },
      });
    });

    it("marks only send-now's interruption as an intentional handoff", async () => {
      const { controller, session } = createQueuedFixture({ steering: [], followUp: ["Next"] });
      const handoffs: boolean[] = [];
      session.abort = vi.fn(async () => {
        handoffs.push(controller.handoffActive());
      });
      await controller.sendQueuedMessageNow((await controller.pendingMessages()).items[0]!.partId);
      expect(controller.handoffActive()).toBe(false);
      await controller.abort();
      expect(handoffs).toEqual([true, false]);
    });
  });
});
