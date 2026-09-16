import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Attachment, UiPart } from "../../../ipc/session-contract";
import { parsePiBuiltinCommand } from "../../../ipc/session-contract";
import { parseCrossSessionMessage } from "../../../domain/conversations/cross-session-coordination";
import type { PiPendingMessageReorder, PiPendingMessages } from "../conversation-data";
import { RuntimeTurnCompletion, TurnCanceledError } from "./RuntimeTurnCompletion";
import {
  imageContent,
  locateQueuedMessage,
  promptText,
  shellCommandPart,
} from "./session-projection";

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
  readonly pendingMessages: () => Promise<PiPendingMessages>;
  readonly reorderPendingMessage: (input: PiPendingMessageReorder) => Promise<PiPendingMessages>;
  readonly clearQueue: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly cancelSteering: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly removeQueuedMessage: (
    partId: string,
  ) => Promise<{ steering: string[]; followUp: string[] }>;
  readonly steerQueuedMessage: (
    partId: string,
  ) => Promise<{ steering: string[]; followUp: string[] }>;
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
  type QueueLane = "steering" | "follow-up";
  type TrackedQueueItem = {
    itemId: string;
    content: string;
    attachments: Attachment[];
    renderUserMessageAsMarkdown: boolean;
  };
  interface TrackedQueue {
    steering: TrackedQueueItem[];
    "follow-up": TrackedQueueItem[];
  }
  let trackedQueue: TrackedQueue = {
    steering: [],
    "follow-up": [],
  };
  let compactionQueue: {
    itemId: string;
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
    if (generation !== abortGeneration) throw new TurnCanceledError("Session was aborted");
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
        const lane = item.delivery === "steer" ? "steering" : "follow-up";
        const rawQueue =
          lane === "steering" ? session.getSteeringMessages() : session.getFollowUpMessages();
        if (rawQueue.includes(content))
          trackedQueue[lane].push({
            itemId: item.itemId,
            content,
            attachments: item.attachments,
            renderUserMessageAsMarkdown: item.renderUserMessageAsMarkdown,
          });
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
          itemId: randomUUID(),
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
      const wasStreaming = session.isStreaming;
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
      if (wasStreaming) {
        const lane = delivery === "steer" ? "steering" : "follow-up";
        trackedQueue[lane].push({
          itemId: randomUUID(),
          content,
          attachments: [...attachments],
          renderUserMessageAsMarkdown,
        });
      }
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

  const reconcileContents = (
    steering: readonly string[],
    followUp: readonly string[],
  ): TrackedQueue => {
    const remaining = [...trackedQueue.steering, ...trackedQueue["follow-up"]];
    const take = (content: string): TrackedQueueItem => {
      const index = remaining.findIndex((item) => item.content === content);
      if (index >= 0) return remaining.splice(index, 1)[0]!;
      return {
        itemId: randomUUID(),
        content,
        attachments: [],
        renderUserMessageAsMarkdown: false,
      };
    };
    return { steering: steering.map(take), "follow-up": followUp.map(take) };
  };

  const reconcileQueue = () => {
    trackedQueue = reconcileContents(session.getSteeringMessages(), session.getFollowUpMessages());
  };

  const listQueuedMessages = async () => ({
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
  });

  const pendingMessages = async (): Promise<PiPendingMessages> => {
    reconcileQueue();
    const laneItems = (lane: QueueLane) => {
      const delivery = lane === "steering" ? "steer" : "follow-up";
      return [
        ...trackedQueue[lane].map((item) => ({
          itemId: item.itemId,
          state: "queued" as const,
          content: item.content,
        })),
        ...compactionQueue
          .filter((item) => item.delivery === delivery)
          .map((item) => ({
            itemId: item.itemId,
            state: "compaction-held" as const,
            content: item.text,
          })),
      ].map((item, index) => {
        const parsed = parseCrossSessionMessage(item.content);
        return {
          itemId: item.itemId,
          state: item.state,
          lane,
          position: index + 1,
          text: parsed?.text ?? item.content,
          ...(parsed ? { crossSession: parsed.metadata } : null),
        };
      });
    };
    return { items: [...laneItems("steering"), ...laneItems("follow-up")] };
  };

  // Pi only exposes whole-queue replacement. Keep Cake's process-lifetime item
  // identity and full input payload while rebuilding the authoritative Pi queue.
  const requeue = async (queues: {
    readonly steering: readonly TrackedQueueItem[];
    readonly "follow-up": readonly TrackedQueueItem[];
  }) => {
    for (const item of queues.steering)
      await session.prompt(item.content, {
        images: imageContent(item.attachments),
        source: "interactive",
        streamingBehavior: "steer",
      });
    for (const item of queues["follow-up"])
      await session.prompt(item.content, {
        images: imageContent(item.attachments),
        source: "interactive",
        streamingBehavior: "followUp",
      });
    trackedQueue = {
      steering: [...queues.steering],
      "follow-up": [...queues["follow-up"]],
    };
  };

  const editQueuedMessage = async (
    partId: string,
    edit: (
      queued: { steering: string[]; followUp: string[] },
      location: { list: "steering" | "followUp"; index: number },
    ) => string | undefined,
    editPending: (item: (typeof compactionQueue)[number], index: number) => void,
  ) => {
    assertActive();
    reconcileQueue();
    const location = locateQueuedMessage(
      partId,
      session.getSteeringMessages(),
      session.getFollowUpMessages(),
      compactionQueue.map((item) => item.text),
    );
    if (!location) return listQueuedMessages();
    if (location.list === "pending") {
      editPending(compactionQueue[location.index]!, location.index);
    } else {
      const queued = session.clearQueue();
      const removed = edit(queued, { list: location.list, index: location.index });
      if (removed !== undefined) turnCompletions.cancelQueued(removed);
      const reordered = reconcileContents(queued.steering, queued.followUp);
      await requeue(reordered);
    }
    input.syncQueuedParts();
    await input.emitSnapshot();
    return listQueuedMessages();
  };

  return {
    compactionQueuedMessages: () => compactionQueue.map((item) => item.text),
    executingTurnIds: () => turnCompletions.executingIds(),
    prompt,
    editMessage,
    compact: (instructions) => runCompact(instructions),
    listQueuedMessages,
    pendingMessages,
    async reorderPendingMessage({ itemId, position }) {
      assertActive();
      reconcileQueue();
      const sourceLane = (["steering", "follow-up"] as const).find((candidate) =>
        trackedQueue[candidate].some((item) => item.itemId === itemId),
      );
      const compactionItem = compactionQueue.find((item) => item.itemId === itemId);
      if (!sourceLane && !compactionItem) throw new Error(`Queued item ${itemId} no longer exists`);

      if (compactionItem) {
        if (trackedQueue.steering.length > 0 || trackedQueue["follow-up"].length > 0)
          throw new Error("Cannot reorder a compaction-held item across Pi's active queue");
        const lanes = {
          steer: compactionQueue.filter((item) => item.delivery === "steer"),
          "follow-up": compactionQueue.filter((item) => item.delivery === "follow-up"),
        };
        const source = lanes[compactionItem.delivery];
        const sourceIndex = source.findIndex((item) => item.itemId === itemId);
        source.splice(sourceIndex, 1);
        if (position > source.length + 1) {
          source.splice(sourceIndex, 0, compactionItem);
          const laneName = compactionItem.delivery === "steer" ? "steering" : "follow-up";
          throw new Error(`Position ${position} is outside the ${laneName} lane`);
        }
        source.splice(position - 1, 0, compactionItem);
        compactionQueue = [...lanes.steer, ...lanes["follow-up"]];
      } else {
        const source = trackedQueue[sourceLane!];
        const sourceIndex = source.findIndex((item) => item.itemId === itemId);
        const [item] = source.splice(sourceIndex, 1);
        if (position > source.length + 1) {
          source.splice(sourceIndex, 0, item!);
          throw new Error(`Position ${position} is outside the ${sourceLane} lane`);
        }
        source.splice(position - 1, 0, item!);
        session.clearQueue();
        await requeue(trackedQueue);
      }
      input.syncQueuedParts();
      await input.emitSnapshot();
      return pendingMessages();
    },
    removeQueuedMessage: (partId) =>
      editQueuedMessage(
        partId,
        (queued, location) => queued[location.list].splice(location.index, 1)[0],
        (item, index) => {
          compactionQueue.splice(index, 1);
          if (item.turnId)
            turnCompletions.failHandledInput(
              item.turnId,
              new TurnCanceledError("Queued input was canceled"),
            );
        },
      ),
    steerQueuedMessage: (partId) =>
      editQueuedMessage(
        partId,
        (queued, location) => {
          if (location.list === "steering") return undefined;
          const [text] = queued.followUp.splice(location.index, 1);
          if (text !== undefined) queued.steering.push(text);
          return undefined;
        },
        (item) => {
          item.delivery = "steer";
        },
      ),
    async clearQueue() {
      queueGeneration += 1;
      reconcileQueue();
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
      trackedQueue = { steering: [], "follow-up": [] };
      input.syncQueuedParts();
      await input.emitSnapshot();
      return { steering, followUp };
    },
    async cancelSteering() {
      reconcileQueue();
      const queued = session.clearQueue();
      await requeue({
        steering: [],
        "follow-up": [...trackedQueue.steering, ...trackedQueue["follow-up"]],
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
    consumeUserMessage(content) {
      for (const lane of ["steering", "follow-up"] as const) {
        const index = trackedQueue[lane].findIndex((item) => item.content === content);
        if (index >= 0) {
          trackedQueue[lane].splice(index, 1);
          break;
        }
      }
      turnCompletions.consume(content);
    },
    settleTurn: () => turnCompletions.settle(),
    compactionEnded(willRetry) {
      if (!willRetry) void flushCompactionQueue();
    },
    abort() {
      abortGeneration += 1;
      queueGeneration += 1;
      turnCompletions.cancel();
      compactionQueue = [];
      trackedQueue = { steering: [], "follow-up": [] };
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
      trackedQueue = { steering: [], "follow-up": [] };
    },
  };
}
