import { randomUUID } from "node:crypto";
import {
  addResponseModeReminder,
  stripResponseModeReminder,
  type ConversationResponseMode,
} from "../response-mode-reminders";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Attachment, UiPart } from "../../../ipc/session-contract";
import type { ProjectSessionPresentationMode } from "../../../ipc/project-session-presentation";
import { parsePiBuiltinCommand } from "../../../ipc/session-contract";
import { parseCrossSessionMessage } from "../cross-session-message";
import type { PiPendingMessageReorder, PiPendingMessages } from "../conversation-data";
import { RuntimeTurnCompletion, TurnCanceledError } from "./RuntimeTurnCompletion";
import {
  addPresentationModeReminder,
  presentationModeFromReminder,
  stripPresentationModeReminder,
} from "../presentation-mode-reminders";
import {
  imageContent,
  locateQueuedMessage,
  queuedMessageIds,
  promptText,
  projectQueuedMessages,
  shellCommandPart,
} from "./session-projection";

interface TurnRecoveryHooks {
  readonly onUserInput: () => void;
  readonly onAbort: () => void;
}

export interface CakeSessionRuntimeTurnController {
  readonly compactionQueuedMessages: () => readonly string[];
  readonly queuedParts: () => UiPart[];
  readonly handoffActive: () => boolean;
  readonly executingTurnIds: () => ReadonlyArray<string>;
  readonly prompt: (
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown?: boolean,
    turnId?: string,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
  ) => Promise<void>;
  readonly editMessage: (
    entryId: string,
    text: string,
    attachments: Attachment[],
    renderUserMessageAsMarkdown: boolean,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
  ) => Promise<void>;
  readonly compact: (instructions?: string) => Promise<void>;
  readonly queueCommand: (
    command: string,
    onSettled?: () => void,
  ) => Promise<{ itemId: string; status: "queued" }>;
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
  readonly sendQueuedMessageNow: (partId?: string) => Promise<{
    queued: { steering: string[]; followUp: string[] };
    abortedTurnIds: string[];
  }>;
  readonly consumeUserMessage: (content: string) => void;
  readonly settleTurn: () => void;
  readonly compactionEnded: (willRetry: boolean) => void;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
}

export function createCakeSessionRuntimeTurnController(input: {
  readonly session: AgentSession;
  readonly isDisposed: () => boolean;
  readonly allowUserBash: boolean;
  readonly beforeIdleTurn: (signal: AbortSignal) => Promise<void>;
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
  readonly executeQueuedCommand?: (command: string) => Promise<void>;
  readonly reportQueuedCommandError?: (command: string, error: unknown) => void;
}): CakeSessionRuntimeTurnController {
  const { session } = input;
  const turnCompletions = new RuntimeTurnCompletion();
  const commandCompletions = new RuntimeTurnCompletion();
  type QueueLane = "steering" | "follow-up";
  type TrackedQueueItem = {
    itemId: string;
    text: string;
    content: string;
    attachments: Attachment[];
    renderUserMessageAsMarkdown: boolean;
    command?: string;
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
    content: string;
    attachments: Attachment[];
    delivery: "steer" | "follow-up";
    renderUserMessageAsMarkdown: boolean;
    presentationMode?: ProjectSessionPresentationMode;
    command?: string;
  }[] = [];
  let flushingHeldQueue = false;
  let commandRunning = false;
  let rebuildingQueue = false;
  let handingOff = false;
  let abortGeneration = 0;
  let preparation = new AbortController();
  let queueGeneration = 0;
  let steeringWaiters: Array<() => void> = [];

  const notifySteeringQueued = () => {
    const waiters = steeringWaiters;
    steeringWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const waitForSteering = () =>
    new Promise<void>((resolve) => {
      steeringWaiters.push(resolve);
    });

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
      await input.beforeIdleTurn(preparation.signal);
      if (generation !== undefined) assertNotAborted(generation);
    }
    await session.compact(instructions || undefined);
    await input.emitSnapshot();
  };

  const previousPresentationMode = (delivery: "prompt" | "steer" | "follow-up") => {
    let mode: ProjectSessionPresentationMode = "normal";
    const consume = (messages: readonly string[]) => {
      for (const message of messages) mode = presentationModeFromReminder(message) ?? mode;
    };
    consume(
      session.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user"
          ? [
              typeof entry.message.content === "string"
                ? entry.message.content
                : entry.message.content
                    .filter((item) => item.type === "text")
                    .map((item) => item.text)
                    .join("\n"),
            ]
          : [],
      ),
    );
    if (delivery !== "prompt") {
      consume(session.getSteeringMessages());
      consume(
        compactionQueue.filter((item) => item.delivery === "steer").map((item) => item.content),
      );
    }
    if (delivery === "follow-up") {
      consume(session.getFollowUpMessages());
      consume(
        compactionQueue.filter((item) => item.delivery === "follow-up").map((item) => item.content),
      );
    }
    return mode;
  };

  const contentForPresentation = (
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer" | "follow-up",
    presentationMode?: ProjectSessionPresentationMode,
    responseMode: ConversationResponseMode = "text",
  ) => {
    const content = promptText(text, attachments);
    if (text.startsWith("/")) return content;
    return addResponseModeReminder(
      presentationMode === undefined
        ? content
        : addPresentationModeReminder(
            content,
            previousPresentationMode(delivery),
            presentationMode,
          ),
      responseMode,
    );
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
    if (
      input.isDisposed() ||
      (session.isStreaming && compactionQueue.some((item) => item.command)) ||
      session.isCompacting ||
      flushingHeldQueue ||
      commandRunning ||
      compactionQueue.length === 0
    )
      return;
    flushingHeldQueue = true;
    const generation = queueGeneration;
    try {
      while (!input.isDisposed() && generation === queueGeneration) {
        const steeringIndex = compactionQueue.findIndex((item) => item.delivery === "steer");
        const [item] = compactionQueue.splice(steeringIndex < 0 ? 0 : steeringIndex, 1);
        if (!item) break;
        input.syncQueuedParts();
        try {
          if (item.command) {
            if (!input.executeQueuedCommand) throw new Error("Queued commands are unavailable");
            commandRunning = true;
            commandCompletions.consume(item.itemId);
            try {
              await input.executeQueuedCommand(item.command);
            } finally {
              commandRunning = false;
            }
            commandCompletions.finishHandledInput(item.itemId);
            continue;
          }
          const delivery = item.delivery === "steer" ? "steer" : "follow-up";
          const content = item.content;
          const images = imageContent(item.attachments);
          const lane = item.delivery === "steer" ? "steering" : "follow-up";
          trackedQueue[lane].push({
            itemId: item.itemId,
            text: item.text,
            content,
            attachments: item.attachments,
            renderUserMessageAsMarkdown: item.renderUserMessageAsMarkdown,
          });
          await input.deliverTrackedUserMessage(content, item.renderUserMessageAsMarkdown, () =>
            input.withResponseRetries(() =>
              session.prompt(content, {
                images,
                source: "interactive",
                streamingBehavior: delivery === "steer" ? "steer" : "followUp",
              }),
            ),
          );
          reconcileQueue();
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
          if (item.command) commandCompletions.failHandledInput(item.itemId, error);
          if (!input.isDisposed() && generation === queueGeneration) {
            if (item.turnId) turnCompletions.failHandledInput(item.turnId, error);
            if (item.command) input.reportQueuedCommandError?.(item.command, error);
            if (item.command)
              input.emitPart({
                kind: "notice",
                id: `command-error-${item.itemId}`,
                tone: "error",
                title: "Queued command failed",
                detail: `${item.command}: ${error instanceof Error ? error.message : String(error)}`,
              });
          }
        }
      }
    } finally {
      flushingHeldQueue = false;
      input.emitSnapshotInBackground();
    }
  };

  const prompt = async (
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown = false,
    turnId?: string,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
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
    if (input.allowUserBash && shellPrefix && attachments.length === 0) {
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
      await input.beforeIdleTurn(preparation.signal);
      assertNotAborted(generation);
    }
    const content = contentForPresentation(
      text,
      attachments,
      delivery,
      presentationMode,
      responseMode,
    );
    const completion = turnId ? turnCompletions.track(turnId, content, true) : undefined;
    try {
      if (
        session.isCompacting ||
        commandRunning ||
        ((flushingHeldQueue || compactionQueue.length > 0) && delivery !== "steer")
      ) {
        compactionQueue.push({
          itemId: randomUUID(),
          turnId,
          text,
          content,
          attachments,
          delivery: delivery === "steer" ? "steer" : "follow-up",
          renderUserMessageAsMarkdown,
          ...(presentationMode === undefined ? null : { presentationMode }),
        });
        if (delivery === "steer") notifySteeringQueued();
        input.syncQueuedParts();
        void flushCompactionQueue();
        await completion;
        return;
      }
      const images = imageContent(attachments);
      const wasStreaming = session.isStreaming;
      const lane = delivery === "steer" ? "steering" : "follow-up";
      if (wasStreaming)
        trackedQueue[lane].push({
          itemId: randomUUID(),
          text,
          content,
          attachments: [...attachments],
          renderUserMessageAsMarkdown,
        });
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
        if (lane === "steering") notifySteeringQueued();
        input.syncQueuedParts();
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
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
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
      contentForPresentation(text, attachments, "prompt", presentationMode, responseMode),
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
        text: stripResponseModeReminder(stripPresentationModeReminder(content)),
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
      const queuedIds = queuedMessageIds(
        lane === "steering" ? "queued-steering" : "queued-follow-up",
        lane === "steering" ? "steering" : "queued",
        [
          ...(lane === "steering" ? session.getSteeringMessages() : session.getFollowUpMessages()),
          ...compactionQueue
            .filter((item) => item.delivery === delivery)
            .map((item) => item.content),
        ],
      );
      return [
        ...trackedQueue[lane].map((item, index) => ({
          itemId: item.itemId,
          partId: queuedIds[index],
          state: "queued" as const,
          content: item.content,
        })),
        ...compactionQueue
          .filter((item) => item.delivery === delivery)
          .map((item, index) => ({
            itemId: item.itemId,
            partId: queuedIds[trackedQueue[lane].length + index],
            state: item.command ? ("command-queued" as const) : ("compaction-held" as const),
            content: item.text,
          })),
      ].map((item, index) => {
        const visibleContent = stripResponseModeReminder(
          stripPresentationModeReminder(item.content),
        );
        const parsed = parseCrossSessionMessage(visibleContent);
        return {
          itemId: item.itemId,
          ...(item.partId ? { partId: item.partId } : null),
          state: item.state,
          lane,
          position: index + 1,
          text: parsed?.text ?? visibleContent,
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
    // Publish the intended queue throughout Pi's whole-queue replacement, preserving
    // stable identities and payloads across its synchronous queue_update callbacks.
    trackedQueue = { steering: [...queues.steering], "follow-up": [...queues["follow-up"]] };
    rebuildingQueue = true;
    try {
      session.clearQueue();
      // Queue primitives never start an idle turn if a response settles during an edit.
      for (const item of queues.steering)
        await session.steer(item.content, imageContent(item.attachments));
      for (const item of queues["follow-up"])
        await session.followUp(item.content, imageContent(item.attachments));
    } finally {
      rebuildingQueue = false;
    }
  };

  const queuedForStop = (): TrackedQueue => {
    if (!rebuildingQueue) reconcileQueue();
    return {
      steering: [
        ...trackedQueue.steering,
        ...compactionQueue
          .filter((item) => item.delivery === "steer")
          .map((item) => ({
            itemId: item.itemId,
            text: item.text,
            content: item.content,
            attachments: item.attachments,
            renderUserMessageAsMarkdown: item.renderUserMessageAsMarkdown,
          })),
      ],
      "follow-up": [
        ...trackedQueue["follow-up"],
        ...compactionQueue
          .filter((item) => item.delivery === "follow-up")
          .map((item) => ({
            itemId: item.itemId,
            text: item.text,
            content: item.content,
            attachments: item.attachments,
            renderUserMessageAsMarkdown: item.renderUserMessageAsMarkdown,
            command: item.command,
          })),
      ],
    } satisfies TrackedQueue;
  };

  const replacePendingQueues = async (queues: TrackedQueue) => {
    if (
      session.isCompacting ||
      commandRunning ||
      queues["follow-up"].some((item) => item.command) ||
      flushingHeldQueue
    ) {
      const held = new Map(compactionQueue.map((entry) => [entry.itemId, entry]));
      const holdSteering = session.isCompacting || commandRunning;
      const heldLanes = holdSteering
        ? (["steering", "follow-up"] as const)
        : (["follow-up"] as const);
      compactionQueue = heldLanes.flatMap((lane) =>
        queues[lane].map((entry) => ({
          ...entry,
          turnId: held.get(entry.itemId)?.turnId,
          delivery: lane === "steering" ? ("steer" as const) : ("follow-up" as const),
        })),
      );
      await requeue({ steering: holdSteering ? [] : queues.steering, "follow-up": [] });
    } else {
      compactionQueue = [];
      await requeue(queues);
    }
  };

  const locatePendingPart = (partId: string) => {
    const queues = queuedForStop();
    const location = locateQueuedMessage(
      partId,
      queues.steering.map((item) => item.content),
      queues["follow-up"].map((item) => item.content),
    );
    if (!location || location.list === "pending") return undefined;
    const lane = location.list === "steering" ? "steering" : "follow-up";
    if (location.index < trackedQueue[lane].length) return location;
    const item = queues[lane][location.index];
    const index = compactionQueue.findIndex((candidate) => candidate.itemId === item?.itemId);
    return index < 0 ? undefined : { list: "pending" as const, index };
  };

  const stopActiveTurn = async () => {
    abortGeneration += 1;
    preparation.abort();
    preparation = new AbortController();
    queueGeneration += 1;
    const abortedTurnIds = turnCompletions.cancelExecuting();
    input.recovery.onAbort();
    input.cancelResponseRetries();
    if (session.isBashRunning) session.abortBash();
    else await session.abort();
    return abortedTurnIds;
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
    const location = locatePendingPart(partId);
    if (!location) throw new Error("That queued message is no longer available");
    if (location.list === "pending") {
      editPending(compactionQueue[location.index]!, location.index);
    } else {
      const queued = {
        steering: [...session.getSteeringMessages()],
        followUp: [...session.getFollowUpMessages()],
      };
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
    handoffActive: () => handingOff,
    queuedParts: () => {
      const queues = queuedForStop();
      const parts = projectQueuedMessages(
        queues.steering.map((item) => item.content),
        queues["follow-up"].map((item) => item.content),
      );
      const payloads = new Map<string, TrackedQueueItem>();
      for (const [lane, items] of [
        ["steering", queues.steering],
        ["queued", queues["follow-up"]],
      ] as const) {
        const ids = queuedMessageIds(
          lane === "steering" ? "queued-steering" : "queued-follow-up",
          lane,
          items.map((item) => item.content),
        );
        items.forEach((item, index) => {
          const id = ids[index];
          if (id) payloads.set(id, item);
        });
      }
      return parts.map((part) => {
        const item = payloads.get(part.id);
        return part.kind === "text" && item
          ? {
              ...part,
              text: part.crossSession || part.scheduled ? part.text : item.text,
              renderAs: item.renderUserMessageAsMarkdown ? ("markdown" as const) : part.renderAs,
              queuedInput: {
                itemId: item.itemId,
                ...(item.command ? { command: item.command } : null),
                text: item.text,
                attachments: item.attachments,
                renderUserMessageAsMarkdown: item.renderUserMessageAsMarkdown,
              },
            }
          : part;
      });
    },
    executingTurnIds: () => turnCompletions.executingIds(),
    prompt,
    editMessage,
    compact: (instructions) => runCompact(instructions),
    async queueCommand(command, onSettled) {
      assertActive();
      const itemId = randomUUID();
      if (onSettled) void commandCompletions.track(itemId, itemId).then(onSettled, onSettled);
      const queues = queuedForStop();
      queues["follow-up"].push({
        itemId,
        text: command,
        content: command,
        command,
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      await replacePendingQueues(queues);
      input.syncQueuedParts();
      await input.emitSnapshot();
      void flushCompactionQueue();
      return { itemId, status: "queued" };
    },
    listQueuedMessages,
    pendingMessages,
    async reorderPendingMessage({ itemId, position }) {
      assertActive();
      if (!Number.isSafeInteger(position) || position < 1)
        throw new Error("Position must be a positive integer");
      const queues = queuedForStop();
      const lane = (["steering", "follow-up"] as const).find((candidate) =>
        queues[candidate].some((item) => item.itemId === itemId),
      );
      if (!lane) throw new Error(`Queued item ${itemId} no longer exists`);
      const source = queues[lane];
      if (position > source.length)
        throw new Error(`Position ${position} is outside the ${lane} lane`);
      const index = source.findIndex((item) => item.itemId === itemId);
      const [item] = source.splice(index, 1);
      source.splice(position - 1, 0, item!);
      await replacePendingQueues(queues);
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
          if (item.command)
            commandCompletions.failHandledInput(
              item.itemId,
              new TurnCanceledError("Queued command was canceled"),
            );
          else turnCompletions.cancelQueued(item.content);
          if (item.turnId)
            turnCompletions.failHandledInput(
              item.turnId,
              new TurnCanceledError("Queued input was canceled"),
            );
        },
      ),
    async steerQueuedMessage(partId) {
      assertActive();
      const queues = queuedForStop();
      const location = locateQueuedMessage(
        partId,
        queues.steering.map((item) => item.content),
        queues["follow-up"].map((item) => item.content),
      );
      if (!location) throw new Error("That queued message is no longer available");
      if (location.list === "followUp" && queues["follow-up"][location.index]?.command)
        throw new Error("Commands execute between responses and cannot be steered");
      if (location.list === "followUp") {
        const [item] = queues["follow-up"].splice(location.index, 1);
        queues.steering.push(item!);
        await replacePendingQueues(queues);
        notifySteeringQueued();
        input.syncQueuedParts();
        await input.emitSnapshot();
      }
      return listQueuedMessages();
    },
    async sendQueuedMessageNow(partId) {
      assertActive();
      if (commandRunning)
        throw new Error("Wait for the executing command to finish before sending queued input now");
      if (
        !partId &&
        session.getSteeringMessages().length === 0 &&
        !compactionQueue.some((item) => item.delivery === "steer")
      )
        await waitForSteering();
      assertActive();
      const queues = queuedForStop();
      const location = partId
        ? locatePendingPart(partId)
        : queues.steering.length > 0
          ? { list: "steering" as const, index: 0 }
          : undefined;
      if (!location) throw new Error("That queued message is no longer available");

      const lane =
        location.list === "pending"
          ? compactionQueue[location.index]?.delivery === "steer"
            ? "steering"
            : "follow-up"
          : location.list === "steering"
            ? "steering"
            : "follow-up";
      const laneIndex =
        location.list === "pending"
          ? compactionQueue
              .slice(0, location.index)
              .filter((item) => item.delivery === (lane === "steering" ? "steer" : "follow-up"))
              .length + trackedQueue[lane].length
          : location.index;
      const [selected] = queues[lane].splice(laneIndex, 1);
      if (!selected) throw new Error("That queued message is no longer available");

      session.clearQueue();
      compactionQueue = [];
      trackedQueue = { steering: [], "follow-up": [] };
      let abortedTurnIds: string[];
      handingOff = true;
      try {
        abortedTurnIds = await stopActiveTurn();
      } finally {
        handingOff = false;
      }
      if (selected.command) {
        if (!input.executeQueuedCommand) throw new Error("Queued commands are unavailable");
        commandRunning = true;
        commandCompletions.consume(selected.itemId);
        try {
          await replacePendingQueues(queues);
          input.syncQueuedParts();
          await input.emitSnapshot();
          await input.executeQueuedCommand(selected.command);
        } finally {
          commandRunning = false;
          commandCompletions.finishHandledInput(selected.itemId);
          void flushCompactionQueue();
        }
        return { queued: await listQueuedMessages(), abortedTurnIds };
      }
      await replacePendingQueues(queues);
      input.syncQueuedParts();
      await input.emitSnapshot();
      await input.beforeIdleTurn(preparation.signal);
      await input.deliverTrackedUserMessage(
        selected.content,
        selected.renderUserMessageAsMarkdown,
        () =>
          input.withResponseRetries(() =>
            session.prompt(selected.content, {
              images: imageContent(selected.attachments),
              source: "interactive",
            }),
          ),
      );
      return { queued: await listQueuedMessages(), abortedTurnIds };
    },
    async clearQueue() {
      queueGeneration += 1;
      reconcileQueue();
      const queued = session.clearQueue();
      turnCompletions.cancel(true);
      commandCompletions.cancel(true);
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
      const queued = {
        steering: [...session.getSteeringMessages()],
        followUp: [...session.getFollowUpMessages()],
      };
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
    settleTurn: () => {
      turnCompletions.settle();
      queueMicrotask(() => {
        void flushCompactionQueue();
      });
    },
    compactionEnded(willRetry) {
      if (!willRetry) void flushCompactionQueue();
    },
    async abort() {
      const queues = queuedForStop();
      session.clearQueue();
      compactionQueue = [];
      trackedQueue = { steering: [], "follow-up": [] };
      await stopActiveTurn();
      if (queues["follow-up"].some((item) => item.command)) await replacePendingQueues(queues);
      else await requeue(queues);
      input.syncQueuedParts();
      await input.emitSnapshot();
    },
    dispose() {
      abortGeneration += 1;
      preparation.abort();
      queueGeneration += 1;
      turnCompletions.cancel();
      commandCompletions.cancel();
      compactionQueue = [];
      trackedQueue = { steering: [], "follow-up": [] };
      notifySteeringQueued();
    },
  };
}
