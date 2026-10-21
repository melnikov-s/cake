import { randomUUID } from "node:crypto";
import type { InternalInput } from "../../../contracts/conversations/internal-input";
import { internalInputPart } from "./internal-input-projection";
import {
  addResponseModeReminder,
  responseModeFromReminder,
  stripResponseModeReminder,
  type ConversationResponseMode,
} from "../../../contracts/conversations/response-mode-reminders";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Attachment, UiPart } from "../../../contracts/conversations/session-contract";
import type { ProjectSessionPresentationMode } from "../../../contracts/project-sessions/project-session-presentation";
import { parsePiBuiltinCommand } from "../../../contracts/conversations/session-contract";
import { parseCrossSessionMessage } from "../../../contracts/conversations/cross-session-message";
import type {
  PiPendingMessageReorder,
  PiPendingMessages,
} from "../../../contracts/conversations/pending-message-data";
import { RuntimeTurnCompletion, TurnCanceledError } from "./RuntimeTurnCompletion";
import {
  addPresentationModeReminder,
  presentationModeFromReminder,
  stripPresentationModeReminder,
} from "../../../contracts/conversations/presentation-mode-reminders";
import {
  imageContent,
  locateQueuedMessage,
  queuedMessageIds,
  promptText,
  projectQueuedMessages,
  shellCommandPart,
} from "./session-projection";

import type { IdleCompactionResult } from "../../../contracts/project-sessions/session-compaction";

interface TurnRecoveryHooks {
  readonly onUserInput: () => void;
  readonly onAbort: () => void;
}

export interface CakeSessionRuntimeTurnController {
  readonly compactionQueuedMessages: () => readonly string[];
  readonly queuedParts: () => UiPart[];
  readonly handoffActive: () => boolean;
  readonly idleCompactionActive: () => boolean;
  readonly pendingRecoveryInputs: () => ReadonlyArray<{
    turnId: string;
    delivery: "steer" | "follow-up";
  }>;
  readonly executingTurnIds: () => ReadonlyArray<string>;
  readonly prompt: (
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown?: boolean,
    turnId?: string,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
    internal?: InternalInput,
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
  readonly compactIfIdle: (instructions?: string) => Promise<IdleCompactionResult>;
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
  readonly internalInput: (content: string) => InternalInput | undefined;
  readonly consumeUserMessage: (content: string) => string | undefined;
  readonly resume: (turnId: string, content: string) => Promise<void>;
  readonly restorePending: (input: {
    turnId: string;
    text: string;
    attachments: Attachment[];
    markdown: boolean;
    internal?: InternalInput;
    presentationMode?: ProjectSessionPresentationMode;
    responseMode?: ConversationResponseMode;
  }) => Promise<void>;
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
  const assertImageSupport = (attachments: readonly Attachment[]) => {
    const count = attachments.filter((item) => item.kind === "image").length;
    if (!count) return;
    if (session.settingsManager.getBlockImages() || !session.model?.input.includes("image"))
      throw new Error(
        "This session cannot accept images. Select an image-capable model and enable images before sending.",
      );
    const maximum = session.model.inputLimits?.images?.maxPerMessage;
    if (maximum !== undefined && count > maximum)
      throw new Error(`This model accepts at most ${maximum} images per message`);
  };
  const turnCompletions = new RuntimeTurnCompletion();
  const commandCompletions = new RuntimeTurnCompletion();
  type QueueLane = "steering" | "follow-up";
  type TrackedQueueItem = {
    itemId: string;
    turnId?: string;
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
  let restoringRun = false;
  let pausedAfterRestart = false;
  let commandRunning = false;
  let promptOperations = 0;
  let idleCompactionActive = false;
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

  // Pi's active branch is the authority, so reload, editing, branching and Tool
  // Compact naturally recover (or reset) the modes without a second persisted flag.
  const previousModes = (delivery: "prompt" | "steer" | "follow-up") => {
    let presentation: ProjectSessionPresentationMode = "normal";
    let response: ConversationResponseMode = "text";
    const consume = (messages: readonly string[]) => {
      for (const message of messages) {
        presentation = presentationModeFromReminder(message) ?? presentation;
        response = responseModeFromReminder(message) ?? response;
      }
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
    return { presentation, response };
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
    const previous = previousModes(
      delivery === "prompt" &&
        (session.isStreaming ||
          session.isCompacting ||
          commandRunning ||
          compactionQueue.length > 0)
        ? "follow-up"
        : delivery,
    );
    const presented =
      presentationMode === undefined
        ? content
        : addPresentationModeReminder(content, previous.presentation, presentationMode);
    return responseMode === previous.response
      ? presented
      : addResponseModeReminder(presented, responseMode);
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
      pausedAfterRestart ||
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
          assertImageSupport(item.attachments);
          const images = imageContent(item.attachments);
          const lane = item.delivery === "steer" ? "steering" : "follow-up";
          trackedQueue[lane].push({
            itemId: item.itemId,
            ...(item.turnId ? { turnId: item.turnId } : null),
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
    internal?: InternalInput,
  ) => {
    assertActive();
    assertImageSupport(attachments);
    const generation = abortGeneration;
    input.recovery.onUserInput();
    if (!parseCrossSessionMessage(text)) pausedAfterRestart = false;
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
    const completion = turnId ? turnCompletions.track(turnId, content, true, internal) : undefined;
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
          ...(turnId ? { turnId } : null),
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
    assertImageSupport(attachments);
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
            ...(item.turnId ? { turnId: item.turnId } : null),
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
            ...(item.turnId ? { turnId: item.turnId } : null),
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
          turnId: entry.turnId ?? held.get(entry.itemId)?.turnId,
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
    idleCompactionActive: () => idleCompactionActive,
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
        const internal = item?.turnId ? turnCompletions.internalInputById(item.turnId) : undefined;
        if (internal?._tag === "WorkboardDelivery") return internalInputPart(internal, part.id);
        return part.kind === "text" && item
          ? {
              ...part,
              text:
                part.crossSession || part.scheduled
                  ? part.text
                  : internal?._tag === "UserWithReminders"
                    ? internal.text
                    : item.text,
              renderAs: item.renderUserMessageAsMarkdown ? ("markdown" as const) : part.renderAs,
              queuedInput: {
                itemId: item.itemId,
                ...(item.turnId ? { turnId: item.turnId } : null),
                ...(item.command ? { command: item.command } : null),
                text: internal?._tag === "UserWithReminders" ? internal.text : item.text,
                attachments: item.attachments,
                renderUserMessageAsMarkdown: item.renderUserMessageAsMarkdown,
              },
            }
          : part;
      });
    },
    executingTurnIds: () => turnCompletions.executingIds(),
    async prompt(...args) {
      // Include asynchronous preparation before Pi exposes isStreaming.
      promptOperations += 1;
      try {
        await prompt(...args);
      } finally {
        promptOperations -= 1;
      }
    },
    editMessage,
    compact: (instructions) => runCompact(instructions),
    async compactIfIdle(instructions) {
      assertActive();
      if (
        promptOperations > 0 ||
        session.isStreaming ||
        session.isCompacting ||
        session.isBashRunning ||
        commandRunning ||
        restoringRun ||
        rebuildingQueue ||
        handingOff ||
        flushingHeldQueue ||
        compactionQueue.length > 0 ||
        session.getSteeringMessages().length > 0 ||
        session.getFollowUpMessages().length > 0
      )
        return { status: "busy" };
      // Reserve synchronously before the first await. New normal inputs use the
      // existing held-input lane until this operation settles. Pi compact()
      // aborts first, so never call it on an active/preparing/queued turn.
      commandRunning = true;
      idleCompactionActive = true;
      try {
        await runCompact(instructions);
        return { status: "compacted" };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "Already compacted" ||
            error.message === "Nothing to compact (session too small)")
        )
          return { status: "unchanged" };
        throw error;
      } finally {
        commandRunning = false;
        idleCompactionActive = false;
        void flushCompactionQueue();
      }
    },
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
      assertImageSupport(selected.attachments);

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
    pendingRecoveryInputs() {
      reconcileQueue();
      return [
        ...trackedQueue.steering.flatMap((item) =>
          item.turnId ? [{ turnId: item.turnId, delivery: "steer" as const }] : [],
        ),
        ...compactionQueue
          .filter((item) => item.delivery === "steer")
          .flatMap((item) =>
            item.turnId ? [{ turnId: item.turnId, delivery: "steer" as const }] : [],
          ),
        ...trackedQueue["follow-up"].flatMap((item) =>
          item.turnId ? [{ turnId: item.turnId, delivery: "follow-up" as const }] : [],
        ),
        ...compactionQueue
          .filter((item) => item.delivery === "follow-up")
          .flatMap((item) =>
            item.turnId ? [{ turnId: item.turnId, delivery: "follow-up" as const }] : [],
          ),
      ];
    },
    async restorePending(restored) {
      const content = contentForPresentation(
        restored.text,
        restored.attachments,
        "follow-up",
        restored.presentationMode,
        restored.responseMode,
      );
      const completion = turnCompletions.track(restored.turnId, content, true, restored.internal);
      pausedAfterRestart = true;
      compactionQueue.push({
        itemId: randomUUID(),
        turnId: restored.turnId,
        text: restored.text,
        content,
        attachments: restored.attachments,
        delivery: "follow-up",
        renderUserMessageAsMarkdown: restored.markdown,
        ...(restored.presentationMode === undefined
          ? null
          : { presentationMode: restored.presentationMode }),
      });
      input.syncQueuedParts();
      await completion;
    },
    async resume(turnId, content) {
      assertActive();
      input.recovery.onUserInput();
      const completion = turnCompletions.track(turnId, content);
      turnCompletions.consume(content);
      try {
        if (!session.isStreaming && !restoringRun) {
          restoringRun = true;
          await input.withResponseRetries(() =>
            session.sendCustomMessage(
              {
                customType: "cake.restart-recovery",
                content,
                display: false,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            ),
          );
        }
        await completion;
      } finally {
        turnCompletions.forget(turnId);
        restoringRun = false;
      }
    },
    internalInput(content) {
      // Pi consumes steering before follow-ups. Bind provenance to that queue item,
      // not the first identical text admitted in another lane.
      for (const lane of ["steering", "follow-up"] as const) {
        const item = trackedQueue[lane].find((candidate) => candidate.content === content);
        if (item) return item.turnId ? turnCompletions.internalInputById(item.turnId) : undefined;
      }
      return turnCompletions.internalInput(content);
    },
    consumeUserMessage(content) {
      let turnId: string | undefined;
      for (const lane of ["steering", "follow-up"] as const) {
        const index = trackedQueue[lane].findIndex((item) => item.content === content);
        if (index >= 0) {
          turnId = trackedQueue[lane].splice(index, 1)[0]?.turnId;
          break;
        }
      }
      return turnCompletions.consume(content, turnId);
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
