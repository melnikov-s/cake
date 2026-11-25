import { randomUUID } from "node:crypto";
import { parseScheduledMessage } from "../../../contracts/conversations/scheduled-message-envelope";
import type { InternalInput } from "../../../contracts/conversations/internal-input";
import { splitContextReminders } from "./session-context-reminders";
import { isAutomaticInput } from "./internal-input-projection";
import type { ConversationResponseMode } from "../../../contracts/conversations/response-mode-reminders";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Attachment, UiPart } from "../../../contracts/conversations/session-contract";
import type { ProjectSessionPresentationMode } from "../../../contracts/project-sessions/project-session-presentation";
import { parseBuiltinCommand } from "../../../contracts/conversations/session-contract";
import { parseCrossSessionMessage } from "../../../contracts/conversations/cross-session-message";
import type {
  PiPendingMessageReorder,
  PiPendingMessages,
} from "../../../contracts/conversations/pending-message-data";
import { RuntimeTurnCompletion, TurnCanceledError } from "./RuntimeTurnCompletion";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";
import { stripResponseModeReminder } from "../../../contracts/conversations/response-mode-reminders";
import { imageContent } from "./user-message-transport";
import { locateQueuedMessage, queuedMessageIds } from "./queued-message-projection";
import { shellCommandPart } from "./tool-projection";
import {
  turnInputContent,
  projectPendingInputParts,
  type QueuedInputPayload,
} from "./turn-input-presentation";

import type { IdleCompactionResult } from "../../../contracts/project-sessions/session-compaction";

interface TurnRecoveryHooks {
  readonly onUserInput: () => void;
  readonly onAbort: () => void;
}

export interface CakeSessionRuntimeTurnController {
  readonly compactionQueuedMessages: () => readonly string[];
  readonly queuedParts: () => UiPart[];
  readonly queuePaused: () => boolean;
  readonly setQueuePaused: (paused: boolean) => Promise<void>;
  readonly queueChanged: () => void;
  readonly handoffActive: () => boolean;
  readonly idleCompactionActive: () => boolean;
  readonly toolPruningActive: () => boolean;
  readonly cancellationPending: () => boolean;
  readonly waitForStop: () => Promise<void>;
  readonly bashParts: () => UiPart[];
  readonly withToolPruning: <T>(compact: () => Promise<T>) => Promise<T>;
  readonly pendingRecoveryInputs: () => ReadonlyArray<{
    turnId: string;
    delivery: "steer" | "follow-up";
    text: string;
    internal?: InternalInput;
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
    resumeQueue?: boolean,
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
  readonly toolPruneIfIdle: (compact: () => Promise<void>) => Promise<IdleCompactionResult>;
  readonly queueCommand: (
    command: string,
    onSettled?: () => void,
  ) => Promise<{ itemId: string; status: "queued" }>;
  readonly listQueuedMessages: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly pendingMessages: () => Promise<PiPendingMessages>;
  readonly reorderPendingMessage: (input: PiPendingMessageReorder) => Promise<PiPendingMessages>;
  readonly clearQueue: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly cancelSteering: () => Promise<{ steering: string[]; followUp: string[] }>;
  readonly updateQueuedMessage: (
    partId: string,
    text: string,
  ) => Promise<{ steering: string[]; followUp: string[] }>;
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
  readonly cancelScheduledInput: (turnId: string) => Promise<void>;
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
  /** False for external automation: every input is literal text, including command prefixes. */
  readonly allowInputCommands: boolean;
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
  readonly onTurnStarted?: () => void;
  readonly onAbortRequested?: () => void;
  readonly onAbortSignaled?: () => void;
  readonly onAbortSettled?: (error?: unknown) => void;
}): CakeSessionRuntimeTurnController {
  const { session } = input;
  const canceledScheduledInputs = new Set<string>();
  const assertScheduledInput = (turnId?: string) => {
    if (turnId && canceledScheduledInputs.has(turnId))
      throw new TurnCanceledError("Scheduled input was canceled");
  };
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
  type TrackedQueueItem = QueuedInputPayload;
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
  let queuePaused = false;
  // A paused queue drains at response boundaries after Play or a priority Send.
  let drainBetweenResponses = false;
  let priorityItemId: string | undefined;
  const claimedInputs: TrackedQueueItem[] = [];
  // A Pi input hook can be awaiting when Pause inspects the display queue.
  const preparingNativeInputs = new Set<TrackedQueueItem>();
  let restoringRun = false;
  let pausedAfterRestart = false;
  let commandRunning = false;
  let promptOperations = 0;
  let idleCompactionActive = false;
  let toolPruningActive = false;
  const isCompacting = () => session.isCompacting || toolPruningActive;
  let rebuildingQueue = false;
  let handingOff = false;
  let abortGeneration = 0;
  let preparation = new AbortController();
  // Pi's abort signals synchronously but joins provider/tool cleanup asynchronously.
  // Keep that join out of Stop's acknowledgment, without reusing Pi before it ends.
  let abortCleanup: Promise<void> | undefined;
  let bashCompletion: Promise<unknown> | undefined;
  let bashPart: Extract<UiPart, { kind: "command" }> | undefined;
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

  const contentForPresentation = (
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer" | "follow-up",
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
    internal?: InternalInput,
    priority?: boolean,
  ) =>
    turnInputContent({
      session,
      heldInputs: priority ? [] : compactionQueue,
      busy: isCompacting() || commandRunning,
      internalInput: (content) => turnCompletions.internalInput(content),
      text,
      attachments,
      delivery,
      presentationMode,
      responseMode,
      internal,
    });

  const promptOptions = {
    source: "interactive",
    expandPromptTemplates: input.allowInputCommands,
  } as const;
  const deliverPrompt = (
    content: string,
    images: ReturnType<typeof imageContent>,
    renderUserMessageAsMarkdown: boolean,
  ) =>
    input.deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
      input.withResponseRetries(() => session.prompt(content, { ...promptOptions, images })),
    );

  // Delivers messages that were submitted while compaction held the session.
  // Pi's prompt operation atomically starts an idle session or applies the
  // requested queue policy if a run is active.
  const flushCompactionQueue = async () => {
    if (
      input.isDisposed() ||
      pausedAfterRestart ||
      queuePaused ||
      (drainBetweenResponses && session.isStreaming) ||
      abortCleanup !== undefined ||
      (session.isStreaming && compactionQueue.some((item) => item.command)) ||
      isCompacting() ||
      flushingHeldQueue ||
      commandRunning ||
      compactionQueue.length === 0
    )
      return;
    flushingHeldQueue = true;
    const generation = queueGeneration;
    try {
      while (
        !input.isDisposed() &&
        generation === queueGeneration &&
        !queuePaused &&
        !(drainBetweenResponses && session.isStreaming)
      ) {
        const priorityIndex = compactionQueue.findIndex((item) => item.itemId === priorityItemId);
        const steeringIndex = compactionQueue.findIndex((item) => item.delivery === "steer");
        const [item] = compactionQueue.splice(
          priorityIndex >= 0 ? priorityIndex : Math.max(0, steeringIndex),
          1,
        );
        if (item?.itemId === priorityItemId) priorityItemId = undefined;
        if (!item) break;
        input.syncQueuedParts();
        try {
          if (drainBetweenResponses) input.onTurnStarted?.();
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
            input.withResponseRetries(() => {
              assertScheduledInput(item.turnId);
              return session.prompt(content, {
                images,
                ...promptOptions,
                streamingBehavior: delivery === "steer" ? "steer" : "followUp",
              });
            }),
          );
          reconcileQueue();
          if (
            item.turnId &&
            !session.isStreaming &&
            !isCompacting() &&
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
      if (!queuePaused && compactionQueue.length === 0) drainBetweenResponses = false;
      input.emitSnapshotInBackground();
    }
  };

  const prompt = async (
    admitted: () => void,
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown = false,
    turnId?: string,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
    internal?: InternalInput,
    resumeQueue?: boolean,
  ) => {
    assertActive();
    assertScheduledInput(turnId);
    assertImageSupport(attachments);
    const generation = abortGeneration;
    if (abortCleanup) {
      await abortCleanup;
      assertNotAborted(generation);
    }
    input.onTurnStarted?.();
    input.recovery.onUserInput();
    // Only a person's input resumes work held after a restart; sender and Cake inputs wait.
    if (
      !parseCrossSessionMessage(text) &&
      !parseScheduledMessage(text) &&
      !isAutomaticInput(internal)
    )
      pausedAfterRestart = false;
    const builtin = input.allowInputCommands ? parseBuiltinCommand(text) : undefined;
    if (builtin?.name === "compact") {
      await runCompact(builtin.args || undefined, generation);
      return;
    }
    const shellPrefix = text.startsWith("!!") ? "!!" : text.startsWith("!") ? "!" : undefined;
    const shellCommand = shellPrefix ? text.slice(shellPrefix.length).trim() : "";
    if (input.allowInputCommands && shellPrefix && attachments.length === 0) {
      if (!shellCommand) return;
      const partId = `bash-${randomUUID()}`;
      const excludeFromContext = shellPrefix === "!!";
      let output = "";
      const project = (state: "running" | "success" | "error") => {
        bashPart = shellCommandPart({
          id: partId,
          command: shellCommand,
          output: output.slice(-500_000),
          excludeFromContext,
          state,
        });
        input.emitPart(bashPart);
      };
      project("running");
      const execution = session.executeBash(
        shellCommand,
        (chunk) => {
          if (generation !== abortGeneration) return;
          output += chunk;
          project("running");
        },
        { excludeFromContext, id: partId },
      );
      bashCompletion = execution;
      try {
        const result = await execution;
        assertNotAborted(generation);
        project(result.exitCode === 0 && !result.cancelled ? "success" : "error");
        await input.emitSnapshot();
      } finally {
        if (bashCompletion === execution) {
          bashCompletion = undefined;
          bashPart = undefined;
        }
      }
      return;
    }
    if (!session.isStreaming) {
      await input.beforeIdleTurn(preparation.signal);
      assertNotAborted(generation);
    }
    assertScheduledInput(turnId);
    const priority = queuePaused && resumeQueue;
    const content = contentForPresentation(
      text,
      attachments,
      priority ? "prompt" : delivery,
      presentationMode,
      responseMode,
      internal,
      priority,
    );
    const completion = turnId ? turnCompletions.track(turnId, content, true, internal) : undefined;
    try {
      if (
        queuePaused ||
        drainBetweenResponses ||
        isCompacting() ||
        commandRunning ||
        ((flushingHeldQueue || compactionQueue.length > 0) && delivery !== "steer")
      ) {
        const item = {
          itemId: randomUUID(),
          turnId,
          text,
          content,
          attachments,
          delivery: !priority && delivery === "steer" ? ("steer" as const) : ("follow-up" as const),
          renderUserMessageAsMarkdown,
          ...(presentationMode === undefined ? null : { presentationMode }),
        };
        if (priority) {
          compactionQueue.unshift(item);
          priorityItemId = item.itemId;
          queuePaused = false;
          pausedAfterRestart = false;
          input.emitSnapshotInBackground();
        } else compactionQueue.push(item);
        if (item.delivery === "steer") notifySteeringQueued();
        input.syncQueuedParts();
        void flushCompactionQueue();
        admitted();
        await completion;
        return;
      }
      const images = imageContent(attachments);
      const wasStreaming = session.isStreaming;
      const lane = delivery === "steer" ? "steering" : "follow-up";
      const preparing = wasStreaming
        ? {
            itemId: randomUUID(),
            turnId,
            text,
            content,
            attachments: [...attachments],
            renderUserMessageAsMarkdown,
          }
        : undefined;
      if (preparing) {
        trackedQueue[lane].push(preparing);
        preparingNativeInputs.add(preparing);
      }
      try {
        await input.deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
          input.withResponseRetries(() => {
            assertScheduledInput(turnId);
            return session.prompt(content, {
              images,
              ...promptOptions,
              ...(delivery === "steer"
                ? { streamingBehavior: "steer" as const }
                : { streamingBehavior: "followUp" as const }),
            });
          }),
        );
      } finally {
        if (preparing) preparingNativeInputs.delete(preparing);
      }
      if (wasStreaming) {
        if (lane === "steering") notifySteeringQueued();
        input.syncQueuedParts();
      }
      // Pi extensions may handle input without creating a user message or run.
      if (
        turnId &&
        !compactionQueue.some((item) => item.turnId === turnId) &&
        !claimedInputs.some((item) => item.turnId === turnId) &&
        !session.isStreaming &&
        !isCompacting() &&
        session.getSteeringMessages().length === 0 &&
        session.getFollowUpMessages().length === 0
      )
        turnCompletions.finishHandledInput(turnId);
      admitted();
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
    if (abortCleanup || session.isStreaming || isCompacting())
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
    const remaining = [
      ...new Set([
        ...trackedQueue.steering,
        ...trackedQueue["follow-up"],
        ...preparingNativeInputs,
      ]),
    ];
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
          turnId: item.turnId,
          partId: queuedIds[index],
          state: "queued" as const,
          content: item.content,
        })),
        ...compactionQueue
          .filter((item) => item.delivery === delivery)
          .map((item, index) => ({
            itemId: item.itemId,
            turnId: item.turnId,
            partId: queuedIds[trackedQueue[lane].length + index],
            state: item.command ? ("command-queued" as const) : ("compaction-held" as const),
            content: item.text,
          })),
      ].map((item, index) => {
        const visibleContent = stripResponseModeReminder(
          stripPresentationModeReminder(item.content),
        );
        const parsed = parseCrossSessionMessage(visibleContent);
        const internal = item.turnId ? turnCompletions.internalInputById(item.turnId) : undefined;
        return {
          itemId: item.itemId,
          ...(parseScheduledMessage(visibleContent) && item.turnId
            ? { turnId: item.turnId }
            : null),
          ...(item.partId ? { partId: item.partId } : null),
          state: item.state,
          lane,
          position: index + 1,
          // A person's queued words, never the Cake context carried with them.
          text:
            internal?._tag === "UserWithReminders"
              ? (internal.userText ?? internal.text)
              : (parsed?.text ?? visibleContent),
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

  const holdQueues = (queues: TrackedQueue) => {
    const held = new Map(compactionQueue.map((entry) => [entry.itemId, entry]));
    compactionQueue = (["steering", "follow-up"] as const).flatMap((lane) =>
      queues[lane].map((entry) => ({
        ...held.get(entry.itemId),
        ...entry,
        delivery: lane === "steering" ? ("steer" as const) : ("follow-up" as const),
      })),
    );
    trackedQueue = { steering: [], "follow-up": [] };
    rebuildingQueue = true;
    try {
      session.clearQueue();
    } finally {
      rebuildingQueue = false;
    }
  };

  const holdUndispatched = (late = false) => {
    const queues = queuedForStop();
    // Pi's display queue includes inputs already pulled by the loop until it emits
    // their user message. Only take the actual agent queue, never replay a claim.
    const agent = session.agent;
    const steeringMode = agent.steeringMode;
    const followUpMode = agent.followUpMode;
    let steeringCount = 0;
    let followUpCount = 0;
    try {
      agent.steeringMode = agent.followUpMode = "all";
      const next = agent.peekQueuedMessages();
      agent.clearSteeringQueue();
      const followUps = agent.peekQueuedMessages();
      steeringCount = next[0] !== followUps[0] ? next.length : 0;
      followUpCount = followUps.length;
    } finally {
      agent.steeringMode = steeringMode;
      agent.followUpMode = followUpMode;
    }
    for (const [lane, count] of [
      ["steering", steeringCount],
      ["follow-up", followUpCount],
    ] as const) {
      const visible = trackedQueue[lane].length;
      const claimed = Math.max(0, visible - count);
      claimedInputs.push(...queues[lane].splice(0, claimed));
      // Input hooks still in flight when Pause took effect can append to Pi
      // later. Keep those arrivals behind the inputs we already held.
      if (late) queues[lane].push(...queues[lane].splice(0, visible - claimed));
    }
    holdQueues(queues);
  };

  const replacePendingQueues = async (queues: TrackedQueue) => {
    if (queuePaused || drainBetweenResponses) {
      holdQueues(queues);
      return;
    }
    if (
      abortCleanup !== undefined ||
      isCompacting() ||
      commandRunning ||
      queues["follow-up"].some((item) => item.command) ||
      flushingHeldQueue
    ) {
      const held = new Map(compactionQueue.map((entry) => [entry.itemId, entry]));
      const holdSteering = abortCleanup !== undefined || isCompacting() || commandRunning;
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
    await session.abort();
    await bashCompletion;
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

  const runIdleCompaction = async (
    compact: () => Promise<IdleCompactionResult>,
  ): Promise<IdleCompactionResult> => {
    assertActive();
    if (
      abortCleanup !== undefined ||
      promptOperations > 0 ||
      session.isStreaming ||
      isCompacting() ||
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
    // existing held-input lane until maintenance and snapshot publication settle.
    commandRunning = true;
    idleCompactionActive = true;
    try {
      return await compact();
    } finally {
      commandRunning = false;
      idleCompactionActive = false;
      void flushCompactionQueue();
    }
  };

  return {
    compactionQueuedMessages: () => compactionQueue.map((item) => item.text),
    handoffActive: () => handingOff,
    idleCompactionActive: () => idleCompactionActive,
    toolPruningActive: () => toolPruningActive,
    cancellationPending: () => abortCleanup !== undefined,
    waitForStop: async () => {
      await abortCleanup;
    },
    bashParts: () => (bashPart?.state === "running" ? [bashPart] : []),
    async withToolPruning(compact) {
      assertActive();
      if (
        abortCleanup ||
        promptOperations > 0 ||
        commandRunning ||
        session.isStreaming ||
        isCompacting() ||
        session.isBashRunning ||
        restoringRun ||
        rebuildingQueue ||
        handingOff ||
        flushingHeldQueue
      )
        throw new Error("Wait for the current operation before tool pruning");
      // Tree navigation sets Pi's compaction flag only during navigateTree and
      // emits no compaction_end. Reserve through snapshot publication and always
      // wake the held-input lane, including failed/cancelled navigation.
      toolPruningActive = true;
      try {
        return await compact();
      } finally {
        toolPruningActive = false;
        void flushCompactionQueue();
      }
    },
    queuedParts: () =>
      projectPendingInputParts(queuedForStop(), (turnId) =>
        turnCompletions.internalInputById(turnId),
      ),
    executingTurnIds: () => turnCompletions.executingIds(),
    queuePaused: () => queuePaused,
    async setQueuePaused(paused) {
      assertActive();
      if (queuePaused === paused) return;
      if (paused) {
        if (
          !trackedQueue.steering.length &&
          !trackedQueue["follow-up"].length &&
          !compactionQueue.length &&
          !session.pendingMessageCount
        )
          return;
        queuePaused = drainBetweenResponses = true;
        holdUndispatched();
      } else {
        queuePaused = pausedAfterRestart = false;
        void flushCompactionQueue();
      }
      input.syncQueuedParts();
      await input.emitSnapshot();
    },
    queueChanged() {
      // Pi emits queue_update synchronously, just before inserting into its agent
      // queue. Recheck after insertion for an admission whose input hook was in flight.
      if (!rebuildingQueue && (queuePaused || (drainBetweenResponses && session.isStreaming)))
        queueMicrotask(() => {
          if ((queuePaused || drainBetweenResponses) && session.pendingMessageCount > 0) {
            holdUndispatched(true);
            input.syncQueuedParts();
          }
        });
    },
    async prompt(...args) {
      // Reserve preparation and Pi delivery, not the lifetime of a queued turn.
      // Its completion promise intentionally stays pending across Stop/compaction.
      promptOperations += 1;
      let pending = true;
      const admitted = () => {
        if (!pending) return;
        pending = false;
        promptOperations -= 1;
      };
      try {
        await prompt(admitted, ...args);
      } finally {
        admitted();
      }
    },
    editMessage,
    compact: (instructions) => runCompact(instructions),
    compactIfIdle: (instructions) =>
      runIdleCompaction(async () => {
        try {
          // Pi compact() aborts first; only enter after reserving an idle target.
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
        }
      }),
    toolPruneIfIdle: (compact) =>
      runIdleCompaction(async () => {
        await compact();
        return { status: "compacted" };
      }),
    async queueCommand(command, onSettled) {
      if (!input.allowInputCommands)
        throw new Error("Commands are unavailable in report-only sessions");
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
    async updateQueuedMessage(partId, text) {
      assertActive();
      const queues = queuedForStop();
      const location = locateQueuedMessage(
        partId,
        queues.steering.map((item) => item.content),
        queues["follow-up"].map((item) => item.content),
      );
      if (!location || location.list === "pending")
        throw new Error("That queued message is no longer available");
      const lane = location.list === "steering" ? "steering" : "follow-up";
      const item = queues[lane][location.index]!;
      const internal = item.turnId ? turnCompletions.internalInputById(item.turnId) : undefined;
      if (
        item.command ||
        isAutomaticInput(internal) ||
        parseCrossSessionMessage(item.content) ||
        parseScheduledMessage(stripPresentationModeReminder(item.content))
      )
        throw new Error("That queued message cannot be edited");
      if (!text.trim() && !item.attachments.length)
        throw new Error("Enter a message or keep an attachment");
      const oldText =
        internal?._tag === "UserWithReminders" ? (internal.userText ?? internal.text) : item.text;
      // Cake's own context blocks ride along in the model input: session updates, reports and
      // to-dos precede the person's words, the application view follows them. An edit replaces
      // only those words and keeps the hidden context on both sides.
      const userBody =
        internal?._tag === "UserWithReminders" ? splitContextReminders(internal.text).text : "";
      const context =
        internal?._tag !== "UserWithReminders" || !userBody.startsWith(oldText)
          ? ""
          : internal.text.endsWith(userBody)
            ? internal.text.slice(0, internal.text.length - userBody.length)
            : internal.text.slice(0, Math.max(0, internal.text.indexOf(userBody)));
      const body = stripPresentationModeReminder(item.content);
      const offset = item.content.length - body.length;
      let found = item.content.indexOf(context + oldText, offset);
      let start = found + context.length;
      // Pi's visible queue content can carry only the person's words.
      if (found < 0 && context) start = found = item.content.indexOf(oldText, offset);
      if (found < 0 || !item.text.startsWith(context))
        throw new Error("That queued message cannot be edited");
      // Words added to an attachment-only message stay separate from that context.
      const words = context && !oldText && text && !context.endsWith("\n") ? `\n\n${text}` : text;
      const updatedText = context + words + item.text.slice(context.length + oldText.length);
      const updatedContent =
        item.content.slice(0, start) +
        words +
        (!oldText && !item.text && body && text ? "\n\n" : "") +
        item.content.slice(start + oldText.length);
      const updatedInternal =
        internal?._tag === "UserWithReminders"
          ? {
              ...internal,
              text: context + words + internal.text.slice(context.length + oldText.length),
              userText: text,
            }
          : internal;
      queues[lane][location.index] = { ...item, text: updatedText, content: updatedContent };
      if (item.turnId) turnCompletions.updateQueued(item.turnId, updatedContent, updatedInternal);
      await replacePendingQueues(queues);
      input.syncQueuedParts();
      await input.emitSnapshot();
      return listQueuedMessages();
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
      const generation = abortGeneration;
      if (abortCleanup) {
        await abortCleanup;
        assertNotAborted(generation);
      }
      input.onTurnStarted?.();
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
      let handoffGeneration: number;
      handingOff = true;
      try {
        const stopping = stopActiveTurn();
        handoffGeneration = abortGeneration;
        abortedTurnIds = await stopping;
        assertNotAborted(handoffGeneration);
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
      assertNotAborted(handoffGeneration);
      await input.deliverTrackedUserMessage(
        selected.content,
        selected.renderUserMessageAsMarkdown,
        () =>
          input.withResponseRetries(() =>
            session.prompt(selected.content, {
              images: imageContent(selected.attachments),
              ...promptOptions,
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
      const queues = queuedForStop();
      return (["steering", "follow-up"] as const).flatMap((lane) =>
        queues[lane].flatMap((item) => {
          if (!item.turnId) return [];
          const internal = turnCompletions.internalInputById(item.turnId);
          return [
            {
              turnId: item.turnId,
              delivery: lane === "steering" ? ("steer" as const) : ("follow-up" as const),
              text: item.text,
              ...(internal === undefined ? null : { internal }),
            },
          ];
        }),
      );
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
                details: { turnId },
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
      const claimed = claimedInputs.find((item) => item.content === content);
      if (claimed)
        return claimed.turnId ? turnCompletions.internalInputById(claimed.turnId) : undefined;
      // Pi consumes steering before follow-ups. Bind provenance to that queue item,
      // not the first identical text admitted in another lane.
      for (const lane of ["steering", "follow-up"] as const) {
        const item = trackedQueue[lane].find((candidate) => candidate.content === content);
        if (item) return item.turnId ? turnCompletions.internalInputById(item.turnId) : undefined;
      }
      return turnCompletions.internalInput(content);
    },
    async cancelScheduledInput(turnId) {
      if (turnCompletions.executingIds().includes(turnId)) return;
      canceledScheduledInputs.add(turnId);
      const item = (await pendingMessages()).items.find((item) => item.turnId === turnId);
      if (item) await this.removeQueuedMessage(item.partId ?? item.itemId);
    },
    consumeUserMessage(content) {
      const claimed = claimedInputs.findIndex((item) => item.content === content);
      if (claimed >= 0)
        return turnCompletions.consume(content, claimedInputs.splice(claimed, 1)[0]?.turnId);
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
      // A repeated Stop must also fence input waiting for the previous cleanup.
      if (abortCleanup) {
        abortGeneration += 1;
        return;
      }
      const queues = queuedForStop();
      pausedAfterRestart = true;
      let release: () => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      abortCleanup = new Promise<void>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      // The detached join owns its failure; waiting inputs still receive it.
      void abortCleanup.catch(() => undefined);
      input.onAbortRequested?.();
      session.clearQueue();
      compactionQueue = (["steering", "follow-up"] as const).flatMap((lane) =>
        queues[lane].map((item) => ({
          ...item,
          delivery: lane === "steering" ? ("steer" as const) : ("follow-up" as const),
        })),
      );
      trackedQueue = { steering: [], "follow-up": [] };
      const stopping = stopActiveTurn();
      input.onAbortSignaled?.();
      void stopping
        .then(async () => {
          if (!input.isDisposed() && !queuePaused && !drainBetweenResponses) {
            // Read the held queue again: the user may have removed items during cleanup.
            const remaining = queuedForStop();
            compactionQueue = [];
            if (remaining["follow-up"].some((item) => item.command))
              await replacePendingQueues(remaining);
            else await requeue(remaining);
          }
        })
        .then(
          () => {
            abortCleanup = undefined;
            input.onAbortSettled?.();
            release();
            if (drainBetweenResponses) void flushCompactionQueue();
            input.syncQueuedParts();
            input.emitSnapshotInBackground();
          },
          (error: unknown) => {
            // Do not reuse a runtime whose cleanup failed.
            input.onAbortSettled?.(error);
            reject(error);
            input.emitSnapshotInBackground();
          },
        );
      input.syncQueuedParts();
      input.emitSnapshotInBackground();
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
