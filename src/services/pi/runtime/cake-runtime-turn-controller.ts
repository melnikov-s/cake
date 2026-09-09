import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Attachment, UiPart } from "../../../ipc/session-contract";
import { parsePiBuiltinCommand } from "../../../ipc/session-contract";
import { RuntimeTurnCompletion } from "./RuntimeTurnCompletion";
import { imageContent, promptText, shellCommandPart } from "./session-projection";

interface TurnRecoveryHooks {
  readonly onUserInput: () => void;
  readonly onAbort: () => void;
}

export interface CakeRuntimeTurnController {
  readonly compactionQueuedMessages: () => readonly string[];
  readonly executingTurnIds: () => ReadonlyArray<string>;
  readonly prompt: (
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown?: boolean,
    turnId?: string,
  ) => Promise<void>;
  readonly editMessage: (
    entryId: string,
    text: string,
    attachments: Attachment[],
    renderUserMessageAsMarkdown: boolean,
  ) => Promise<void>;
  readonly compact: (instructions?: string) => Promise<void>;
  readonly listQueuedMessages: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly clearQueue: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly cancelSteering: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly consumeUserMessage: (content: string) => void;
  readonly settleTurn: () => void;
  readonly compactionEnded: (willRetry: boolean) => void;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
}

export function createCakeRuntimeTurnController(input: {
  readonly session: AgentSession;
  readonly isDisposed: () => boolean;
  readonly beforeIdleTurn: () => Promise<void>;
  readonly withResponseRetries: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly cancelResponseRetries: () => void;
  readonly recovery: TurnRecoveryHooks;
  readonly deliverTrackedUserMessage: (
    content: string,
    renderUserMessageAsMarkdown: boolean,
    deliver: () => Promise<void>,
  ) => Promise<void>;
  readonly syncQueuedParts: () => void;
  readonly emitPart: (part: UiPart) => void;
  readonly emitSnapshot: () => Promise<void>;
  readonly emitSnapshotInBackground: () => void;
}): CakeRuntimeTurnController {
  const { session } = input;
  const turnCompletions = new RuntimeTurnCompletion();
  let compactionQueue: {
    turnId?: string;
    text: string;
    attachments: Attachment[];
    delivery: "steer" | "follow-up";
    renderUserMessageAsMarkdown: boolean;
  }[] = [];
  let abortGeneration = 0;
  let queueGeneration = 0;

  const assertActive = () => {
    if (input.isDisposed()) throw new Error("The Cake runtime has been disposed");
  };

  const assertNotAborted = (generation: number) => {
    assertActive();
    if (generation !== abortGeneration) throw new Error("Session was aborted");
  };

  const runCompact = async (instructions?: string, generation?: number) => {
    assertActive();
    if (!session.isStreaming) {
      await input.beforeIdleTurn();
      if (generation !== undefined) assertNotAborted(generation);
    }
    await session.compact(instructions || undefined);
    await input.emitSnapshot();
  };

  const deliverPrompt = (
    content: string,
    images: ReturnType<typeof imageContent>,
    renderUserMessageAsMarkdown: boolean,
  ) =>
    input.deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
      input.withResponseRetries(() => session.prompt(content, { images, source: "interactive" })),
    );

  // Delivers messages that were submitted while compaction held the session.
  // Pi's prompt operation atomically starts an idle session or applies the
  // requested queue policy if a run is active.
  const flushCompactionQueue = async () => {
    if (input.isDisposed() || compactionQueue.length === 0) return;
    const generation = queueGeneration;
    while (!input.isDisposed() && generation === queueGeneration) {
      const item = compactionQueue.shift();
      if (!item) break;
      input.syncQueuedParts();
      try {
        const content = promptText(item.text, item.attachments);
        const images = imageContent(item.attachments);
        await input.deliverTrackedUserMessage(content, item.renderUserMessageAsMarkdown, () =>
          input.withResponseRetries(() =>
            session.prompt(content, {
              images,
              source: "interactive",
              streamingBehavior: item.delivery === "steer" ? "steer" : "followUp",
            }),
          ),
        );
        if (
          item.turnId &&
          !session.isStreaming &&
          !session.isCompacting &&
          session.getSteeringMessages().length === 0 &&
          session.getFollowUpMessages().length === 0
        )
          turnCompletions.finishHandledInput(item.turnId);
      } catch (error) {
        // This flush is detached from the accepted-turn runner. Settle a failed
        // delivery explicitly rather than leaving its correlation alive forever.
        if (!input.isDisposed() && generation === queueGeneration && item.turnId)
          turnCompletions.failHandledInput(item.turnId, error);
      }
    }
    input.emitSnapshotInBackground();
  };

  const prompt = async (
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown = false,
    turnId?: string,
  ) => {
    assertActive();
    const generation = abortGeneration;
    input.recovery.onUserInput();
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "compact") {
      await runCompact(builtin.args || undefined, generation);
      return;
    }
    const shellPrefix = text.startsWith("!!") ? "!!" : text.startsWith("!") ? "!" : undefined;
    const shellCommand = shellPrefix ? text.slice(shellPrefix.length).trim() : "";
    if (shellPrefix && attachments.length === 0) {
      if (!shellCommand) return;
      const partId = `bash-${randomUUID()}`;
      const excludeFromContext = shellPrefix === "!!";
      let output = "";
      const project = (state: "running" | "success" | "error") =>
        input.emitPart(
          shellCommandPart({
            id: partId,
            command: shellCommand,
            output: output.slice(-500_000),
            excludeFromContext,
            state,
          }),
        );
      project("running");
      const result = await session.executeBash(
        shellCommand,
        (chunk) => {
          output += chunk;
          project("running");
        },
        { excludeFromContext, id: partId },
      );
      project(result.exitCode === 0 && !result.cancelled ? "success" : "error");
      await input.emitSnapshot();
      return;
    }
    if (!session.isStreaming) {
      await input.beforeIdleTurn();
      assertNotAborted(generation);
    }
    const completion = turnId
      ? turnCompletions.track(turnId, promptText(text, attachments), true)
      : undefined;
    try {
      if (session.isCompacting) {
        compactionQueue.push({
          turnId,
          text,
          attachments,
          delivery: delivery === "steer" ? "steer" : "follow-up",
          renderUserMessageAsMarkdown,
        });
        input.syncQueuedParts();
        await completion;
        return;
      }
      const content = promptText(text, attachments);
      const images = imageContent(attachments);
      await input.deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
        input.withResponseRetries(() =>
          session.prompt(content, {
            images,
            source: "interactive",
            ...(delivery === "steer"
              ? { streamingBehavior: "steer" as const }
              : { streamingBehavior: "followUp" as const }),
          }),
        ),
      );
      // Pi extensions may handle input without creating a user message or run.
      if (
        turnId &&
        !session.isStreaming &&
        !session.isCompacting &&
        session.getSteeringMessages().length === 0 &&
        session.getFollowUpMessages().length === 0
      )
        turnCompletions.finishHandledInput(turnId);
      await completion;
    } finally {
      if (turnId) turnCompletions.forget(turnId);
    }
  };

  const editMessage = async (
    entryId: string,
    text: string,
    attachments: Attachment[],
    renderUserMessageAsMarkdown: boolean,
  ) => {
    assertActive();
    if (session.isStreaming || session.isCompacting)
      throw new Error("Wait for the current response to finish before editing a message");
    const lastUserEntry = session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "user");
    if (!lastUserEntry || lastUserEntry.id !== entryId)
      throw new Error("Only the last user message can be edited");
    const generation = abortGeneration;
    input.recovery.onUserInput();
    const result = await session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) throw new Error("Message editing was cancelled");
    assertNotAborted(generation);
    await input.emitSnapshot();
    assertNotAborted(generation);
    await deliverPrompt(
      promptText(text, attachments),
      imageContent(attachments),
      renderUserMessageAsMarkdown,
    );
  };

  return {
    compactionQueuedMessages: () => compactionQueue.map((item) => item.text),
    executingTurnIds: () => turnCompletions.executingIds(),
    prompt,
    editMessage,
    compact: (instructions) => runCompact(instructions),
    async listQueuedMessages() {
      return {
        steering: [
          ...session.getSteeringMessages(),
          ...compactionQueue
            .filter((message) => message.delivery === "steer")
            .map((message) => message.text),
        ],
        followUp: [
          ...session.getFollowUpMessages(),
          ...compactionQueue
            .filter((message) => message.delivery === "follow-up")
            .map((message) => message.text),
        ],
      };
    },
    async clearQueue() {
      queueGeneration += 1;
      const queued = session.clearQueue();
      turnCompletions.cancel(true);
      const steering = [
        ...queued.steering,
        ...compactionQueue
          .filter((message) => message.delivery === "steer")
          .map((message) => message.text),
      ];
      const followUp = [
        ...queued.followUp,
        ...compactionQueue
          .filter((message) => message.delivery === "follow-up")
          .map((message) => message.text),
      ];
      compactionQueue = [];
      input.syncQueuedParts();
      await input.emitSnapshot();
      return { steering, followUp };
    },
    async cancelSteering() {
      const queued = session.clearQueue();
      for (const text of [...queued.steering, ...queued.followUp])
        await session.prompt(text, {
          source: "interactive",
          streamingBehavior: "followUp",
        });
      compactionQueue = compactionQueue.map((message) =>
        message.delivery === "steer" ? { ...message, delivery: "follow-up" } : message,
      );
      input.syncQueuedParts();
      await input.emitSnapshot();
      return {
        steering: [],
        followUp: [
          ...queued.steering,
          ...queued.followUp,
          ...compactionQueue.map((message) => message.text),
        ],
      };
    },
    consumeUserMessage: (content) => turnCompletions.consume(content),
    settleTurn: () => turnCompletions.settle(),
    compactionEnded(willRetry) {
      if (!willRetry) void flushCompactionQueue();
    },
    abort() {
      abortGeneration += 1;
      queueGeneration += 1;
      turnCompletions.cancel();
      compactionQueue = [];
      input.syncQueuedParts();
      input.recovery.onAbort();
      input.cancelResponseRetries();
      if (session.isBashRunning) {
        session.abortBash();
        return Promise.resolve();
      }
      return session.abort();
    },
    dispose() {
      abortGeneration += 1;
      queueGeneration += 1;
      turnCompletions.cancel();
      compactionQueue = [];
    },
  };
}
