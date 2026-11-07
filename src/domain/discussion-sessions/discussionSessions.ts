import { DateTime } from "effect";
import { DiscussionTitleRequests } from "../../services/discussion-sessions/DiscussionTitleRequests";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import { inheritTaskInputProtection } from "../conversations/taskInputs";
import { encodeCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import type { SideSessionFork } from "../../contracts/cake-chats/side-session-fork";
import * as cakeChatRuntime from "../cake-chats/cakeChatRuntime";
import * as cakeChatLocations from "../cake-chats/cakeChatLocations";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { cakeChatControlTools } from "../../contracts/application/window-control-definitions";
import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import { acquireOptions as acquireProjectSessionOptions } from "../project-sessions/projectSessionRuntime";
import { Effect, Schema, Stream } from "effect";
import type { DiscussionCatalogUpdate } from "../../contracts/application/catalog-data";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
  cakeChatSideChatConversationId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import {
  PiSessionError,
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
  type CakeSessionHandle,
} from "../../services/pi/CakeSessionRuntimes";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import {
  DiscussionSessionEnvironment,
  DiscussionSessionEnvironmentError,
  type DiscussionSessionRecord,
} from "../../services/discussion-sessions/DiscussionSessionEnvironment";
import {
  acquire as acquireConversation,
  observe as observeConversation,
  TurnId,
} from "../conversations/conversations";
import {
  type CakeChatSideChatStartInput,
  DiscussionSessionError,
  type DiscussionSessionProjection,
  type DiscussionSessionStartInput,
  type DiscussionSessionTarget,
  type DiscussionSessionUpdate,
  type DiscussionThread,
  DiscussionThreadMetadata,
} from "../../contracts/discussion-sessions/discussion-session-data";
import { ReviewStorage } from "../../services/storage/ReviewStorage";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import type { InterviewRecord } from "../../contracts/interviews/interview";

export * from "../../contracts/discussion-sessions/discussion-session-data";

const asError = (operation: string) =>
  Effect.mapError(
    (error: PiSessionError | DiscussionSessionEnvironmentError | unknown) =>
      new DiscussionSessionError({
        operation,
        message:
          error instanceof PiSessionError || error instanceof DiscussionSessionEnvironmentError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      }),
  );

const jsonValue = <A>(value: A): Schema.Schema.Type<typeof Schema.Json> =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));

const projectThread = (
  record: DiscussionSessionRecord,
  sidecarParts: ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>> = [],
): DiscussionThread => {
  const thread: DiscussionThread = {
    id: record.id,
    workingDirectory: record.workingDirectory,
    parentSessionId: record.parentSessionId,
    anchor: record.anchor,
    parts: [...sidecarParts, ...record.pendingParts],
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.title !== undefined) Object.assign(thread, { title: record.title });
  if (record.sidecarSessionId !== undefined)
    Object.assign(thread, { sidecarSessionId: record.sidecarSessionId });
  if (record.resolvedAt !== undefined) Object.assign(thread, { resolvedAt: record.resolvedAt });
  return thread;
};

/** A Cake Chat side chat branches from the permanent coordinator, not a Project Session. */
const isCakeChatSideChat = (record: { readonly parentSessionId: string }) =>
  isCakeChatSessionId(record.parentSessionId);

const parentHandle = Effect.fn("DiscussionSessions.parentHandle")(function* (
  target: DiscussionSessionTarget,
) {
  const sessions = yield* CakeSessionRuntimes;
  const locations = yield* projectSessionLocations.locations().pipe(asError("parentContext"));
  const location = locations.find(
    (candidate) => candidate.workingDirectory === target.workingDirectory,
  );
  if (!location)
    return yield* new DiscussionSessionError({
      operation: "parentContext",
      message: "The Discussion Session parent Working Directory is unavailable",
    });
  const options = yield* acquireProjectSessionOptions({
    location,
    sessionId: target.parentSessionId,
    newSession: false,
  }).pipe(asError("parentContext"));
  return yield* acquireConversation(sessions, options).pipe(asError("parentContext"));
});

/** Regenerates the read-only parent projection a sidecar reads before answering. */
const refreshParentContext = Effect.fn("DiscussionSessions.refreshParentContext")(function* (
  record: DiscussionSessionRecord,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const parent = yield* parentHandle({
    parentSessionId: record.parentSessionId,
    workingDirectory: record.workingDirectory,
    threadId: record.id,
  });
  const context = yield* parent.reviewParentContext().pipe(asError("parentContext"));
  yield* environment.prepareParentContext(record, context).pipe(asError("parentContext"));
});

type RefreshServices = Effect.Services<ReturnType<typeof refreshParentContext>>;

/**
 * Acquires the sidecar runtime for one stored Discussion Session. Cake-owned
 * thread policy rides on the shared conversation hooks so that every shared
 * Session Chat operation keeps the parent's catalog current, regenerates the
 * parent projection before each turn, and reopens a resolved thread when the
 * user prompts it again.
 */
interface SidecarConfiguration {
  readonly runtime: CakeSessionRuntimeAcquireOptions["runtime"];
  readonly hooks?: Pick<CakeSessionRuntimeAcquireOptions, "admitTurn" | "onTurnSettled">;
}

const acquireRecord = Effect.fn("DiscussionSessions.acquireRecord")(function* (
  record: DiscussionSessionRecord,
  configuration: SidecarConfiguration,
  sidecarSessionId: string,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const sessions = yield* CakeSessionRuntimes;
  const services = yield* Effect.context<RefreshServices>();
  const rendererRequests = yield* RendererRequestCoordinator;
  const catalogChanges = yield* SessionCatalogChanges;
  const run = makePiCallbackExecutor(services);
  const location = yield* environment.location(record).pipe(asError("acquire"));
  // Hooks run long after acquisition, so they re-read the stored thread each time.
  const current = Effect.suspend(() =>
    environment.get(record.workingDirectory, record.parentSessionId, record.id),
  );
  const refreshParentIndex = current.pipe(Effect.flatMap(environment.refreshParentIndex));
  const runtime = {
    ...configuration.runtime,
    cwd: record.workingDirectory,
    sessionDir: location.sessionDirectory,
    directSessionDir: true,
    newSession: record.sidecarSessionId === undefined,
    sessionId: sidecarSessionId,
    auxiliary: false,
    // Thread metadata owns naming for both backends, from this chat's first input.
    generateSessionTitle: undefined,
    allowBlockingUserInput: true,
    requestInterview: (interview: InterviewRecord, signal: AbortSignal) =>
      run(rendererRequests.requestInterview(sidecarSessionId, interview, signal)),
  };
  const handle = yield* acquireConversation(sessions, {
    profile: { _tag: "DiscussionSession" },
    runtime,
    onTurnActivityChanged: catalogChanges.publish({
      _tag: "DiscussionSessionActivityChanged",
      sessionId: sidecarSessionId,
      parentSessionId: record.parentSessionId,
      workingDirectory: record.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    }),
    onSessionChanged: refreshParentIndex,
    onTurnSettled: (event) =>
      (configuration.hooks?.onTurnSettled?.(event) ?? Effect.void).pipe(
        Effect.andThen(refreshParentIndex),
      ),
    admitTurn: (_input, accept) =>
      current.pipe(
        Effect.flatMap((latest) =>
          latest.status === "resolved"
            ? environment.setResolved(latest, false).pipe(Effect.asVoid)
            : Effect.void,
        ),
        // The projection points at a stable path, so refreshing it never
        // requires rebuilding the runtime. A parent that cannot be read right
        // now leaves the previous projection in place. A Cake Chat side chat
        // inherits its context through its native Durable fork.
        Effect.andThen(
          (isCakeChatSideChat(record)
            ? Effect.void
            : Effect.scoped(refreshParentContext(record))
          ).pipe(
            Effect.provide(services),
            Effect.catchTag("DiscussionSessionError", (error) =>
              error.operation === "parentContext" ? Effect.void : Effect.fail(error),
            ),
          ),
        ),
        Effect.andThen(configuration.hooks?.admitTurn?.(_input, accept) ?? accept),
      ),
  }).pipe(asError("acquire"));
  if (record.sidecarSessionId !== undefined) return { record, handle };
  const snapshot = yield* handle.snapshot().pipe(asError("acquire"));
  const linked = yield* environment
    .linkSidecar(record, { sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile })
    .pipe(asError("acquire"));
  return { record: linked, handle };
});

const sideChatConfiguration = Effect.fn("DiscussionSessions.sideChatConfiguration")(function* (
  record: DiscussionSessionRecord,
) {
  // Reuse the originating conversation's composition, not a side-chat allowlist.
  // Controls retain parent authority; messaging carries the fork's own identity.
  if (cakeChatSideChatConversationId(record.sidecarSessionId) !== undefined) {
    const available = yield* Effect.serviceOption(CakeChatConfiguration);
    if (available._tag === "None")
      return yield* new DiscussionSessionError({
        operation: "acquire",
        message: "Permanent chat configuration is unavailable",
      });
    const configuration = available.value;
    const location = yield* cakeChatLocations
      .resolve(configuration.location, record.parentSessionId)
      .pipe(asError("acquire"));
    const options = yield* cakeChatRuntime.acquireOptions({
      configuration: { ...configuration, location },
      target: { sessionId: record.parentSessionId, tools: cakeChatControlTools() },
      newSession: false,
      sideChatSessionId: record.sidecarSessionId,
    });
    return { runtime: options.runtime, hooks: options } satisfies SidecarConfiguration;
  }
  if (isCakeChatSideChat(record))
    return yield* new DiscussionSessionError({
      operation: "acquire",
      message:
        "This Cake Chat side chat has no native Durable conversation. Start a new side chat from the parent message.",
    });
  const environment = yield* DiscussionSessionEnvironment;
  const systemPrompt = yield* environment.sidecarSystemPrompt(record).pipe(asError("acquire"));
  const locations = yield* projectSessionLocations.locations().pipe(asError("acquire"));
  const location = locations.find((item) => item.workingDirectory === record.workingDirectory);
  if (!location)
    return yield* new DiscussionSessionError({
      operation: "acquire",
      message: "The side chat's originating project is unavailable",
    });
  const options = yield* acquireProjectSessionOptions({
    location,
    sessionId: record.parentSessionId,
    newSession: false,
    sideChatSessionId: record.sidecarSessionId,
  }).pipe(asError("acquire"));
  return {
    runtime: {
      ...options.runtime,
      additionalSystemPrompt: [options.runtime.additionalSystemPrompt, systemPrompt]
        .filter(Boolean)
        .join("\n\n"),
    },
  } satisfies SidecarConfiguration;
});

/** Acquires a thread's sidecar; the parent projection is regenerated per turn, not here. */
const prepare = Effect.fn("DiscussionSessions.prepare")(function* (
  record: DiscussionSessionRecord,
) {
  const sidecarSessionId = record.sidecarSessionId ?? crypto.randomUUID();
  const configuration = yield* sideChatConfiguration({ ...record, sidecarSessionId });
  return yield* acquireRecord(record, configuration, sidecarSessionId);
});

export const list = Effect.fn("DiscussionSessions.list")(function* (input: {
  readonly workingDirectory: string;
  readonly parentSessionId: string;
}) {
  const environment = yield* DiscussionSessionEnvironment;
  const sessions = yield* CakeSessionRuntimes;
  const records = yield* environment
    .list(input.workingDirectory, input.parentSessionId)
    .pipe(asError("list"));
  return yield* Effect.forEach(
    records,
    (record) =>
      Effect.gen(function* () {
        if (!record.sidecarSessionId) return projectThread(record);
        const location = yield* environment.location(record).pipe(asError("list"));
        const preview = yield* sessions
          .inspect({
            workingDirectory: record.workingDirectory,
            sessionId: record.sidecarSessionId,
            sessionDirectory: location.sessionDirectory,
            direct: true,
          })
          .pipe(
            asError("list"),
            Effect.catchTag("DiscussionSessionError", () => Effect.succeed(undefined)),
          );
        return projectThread(record, preview?.parts.map(jsonValue) ?? []);
      }),
    { concurrency: 8 },
  );
});

const sameMetadata = Schema.toEquivalence(Schema.Array(DiscussionThreadMetadata));

/** Cold navigation observes ownership/status without inspecting or acquiring any Pi sidecar. */
export const observeMetadata = Effect.fn("DiscussionSessions.observeMetadata")(function* (input: {
  readonly workingDirectory: string;
  readonly parentSessionId: string;
}) {
  const environment = yield* DiscussionSessionEnvironment;
  const sessions = yield* CakeSessionRuntimes;
  const catalog = yield* SessionCatalogChanges;
  const changes = (yield* ReviewStorage).changes();
  const project = Effect.fn("DiscussionSessions.projectMetadata")(function* (
    record: DiscussionSessionRecord,
  ): Effect.fn.Return<DiscussionThreadMetadata, DiscussionSessionError> {
    let running = false;
    if (record.sidecarSessionId) {
      const location = yield* environment.location(record).pipe(asError("observeMetadata"));
      const status = yield* sessions.currentStatus({
        sessionId: record.sidecarSessionId,
        workingDirectory: record.workingDirectory,
        sessionDirectory: location.sessionDirectory,
      });
      running = status?.streaming === true;
    }
    return {
      id: record.id,
      workingDirectory: record.workingDirectory,
      parentSessionId: record.parentSessionId,
      ...(record.sidecarSessionId ? { sidecarSessionId: record.sidecarSessionId } : null),
      title: record.title || record.anchor.selectedText || "Side chat",
      running,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  });
  return changes.pipe(
    Stream.merge(
      catalog
        .initialThenChanges(Stream.empty)
        .pipe(
          Stream.filter(
            (change) =>
              change._tag === "DiscussionSessionActivityChanged" &&
              change.parentSessionId === input.parentSessionId,
          ),
        ),
    ),
    Stream.mapEffect(() =>
      environment.list(input.workingDirectory, input.parentSessionId).pipe(
        asError("observeMetadata"),
        Effect.flatMap((records) => Effect.forEach(records, project, { concurrency: 8 })),
      ),
    ),
    Stream.changesWith(sameMetadata),
  );
});

/** Current-first catalog of Cake-owned Discussion metadata for one parent session. */
export const observeCatalog = Effect.fn("DiscussionSessions.observeCatalog")(function* (input: {
  readonly workingDirectory: string;
  readonly parentSessionId: string;
}) {
  const changes = (yield* ReviewStorage).changes();
  return changes.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (observationRevision) =>
        list(input).pipe(
          Effect.map((threads) => {
            const revision = observationRevision + 1;
            const update: DiscussionCatalogUpdate =
              observationRevision === 0
                ? {
                    _tag: "Snapshot",
                    revision,
                    parentSessionId: input.parentSessionId,
                    threads,
                  }
                : {
                    _tag: "Event",
                    revision,
                    parentSessionId: input.parentSessionId,
                    event: { _tag: "Replaced", threads },
                  };
            return [revision, [update]] as const;
          }),
        ),
    ),
  );
});

/** Observes one sidecar conversation in the shared Cake Session update shape. */
export const observe = Effect.fn("DiscussionSessions.observe")(function* (
  target: DiscussionSessionTarget,
  connectionId?: number,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment
    .get(target.workingDirectory, target.parentSessionId, target.threadId)
    .pipe(asError("observe"));
  if (!record.sidecarSessionId)
    return yield* new DiscussionSessionError({
      operation: "observe",
      message: "The Discussion Session has no sidecar transcript yet",
    });
  const prepared = yield* prepare(record);
  yield* bindSidecarRenderer(prepared.handle, connectionId);
  const sessionId = prepared.record.sidecarSessionId ?? record.sidecarSessionId;
  return observeConversation(prepared.handle).pipe(
    Stream.map((update): DiscussionSessionUpdate => {
      if (update._tag === "Event")
        return { _tag: "Event", revision: update.revision, sessionId, event: update.event };
      const snapshot: DiscussionSessionProjection = {
        identity: {
          _tag: "DiscussionSession",
          sessionId: update.snapshot.sessionId,
          parentSessionId: record.parentSessionId,
        },
        conversation: update.snapshot,
      };
      return { _tag: "Snapshot", revision: update.revision, snapshot };
    }),
    Stream.mapError((error) =>
      error instanceof DiscussionSessionError
        ? error
        : new DiscussionSessionError({ operation: "observe", message: String(error) }),
    ),
  );
});

type FirstPrompt = Pick<
  DiscussionSessionStartInput,
  "text" | "annotations" | "model" | "thinkingLevel"
>;

const requirePrompt = (input: FirstPrompt) =>
  !input.text.trim() && (input.annotations ?? []).length === 0
    ? Effect.fail(
        new DiscussionSessionError({
          operation: "start",
          message: "A Discussion Session prompt cannot be empty",
        }),
      )
    : Effect.void;

/** Bind only an already-authorized, acquired sidecar, before it can request input. */
const bindSidecarRenderer = Effect.fn("DiscussionSessions.bindSidecarRenderer")(function* (
  handle: CakeSessionHandle,
  connectionId: number | undefined,
) {
  if (connectionId === undefined) return;
  const requests = yield* RendererRequestCoordinator;
  const { sessionId } = yield* handle.snapshot().pipe(asError("bindRenderer"));
  yield* requests
    .bind({ _tag: "ProjectSession", sessionId }, connectionId)
    .pipe(asError("bindRenderer"));
});

/** Acquires a new thread's sidecar and delivers its first prompt. */
const deliverFirstPrompt = Effect.fn("DiscussionSessions.deliverFirstPrompt")(function* (
  record: DiscussionSessionRecord,
  input: FirstPrompt,
  connectionId?: number,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const annotations = input.annotations ?? [];
  const prepared = yield* prepare(record);
  yield* bindSidecarRenderer(prepared.handle, connectionId);
  if (input.model)
    yield* prepared.handle.setModel(input.model.provider, input.model.id).pipe(asError("start"));
  if (input.thinkingLevel)
    yield* prepared.handle.setThinkingLevel(input.thinkingLevel).pipe(asError("start"));
  const attachments = annotations.length > 0 ? [{ kind: "annotation" as const, annotations }] : [];
  const turnId = TurnId.make(
    yield* prepared.handle.prompt(input.text.trim(), attachments).pipe(asError("start")),
  );
  yield* (yield* DiscussionTitleRequests).offer({
    workingDirectory: record.workingDirectory,
    parentSessionId: record.parentSessionId,
    threadId: record.id,
    firstUserMessage: input.text.trim() || annotations.map((item) => item.comment ?? "").join("\n"),
  });
  yield* environment.refreshParentIndex(prepared.record).pipe(asError("start"));
  return { turnId, thread: projectThread(prepared.record) };
});

/** Creates a Discussion Session and delivers its first prompt to a new sidecar. */
export const start = Effect.fn("DiscussionSessions.start")(function* (
  input: DiscussionSessionStartInput,
  connectionId?: number,
) {
  yield* requirePrompt(input);
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment
    .create(input.workingDirectory, input.parentSessionId, input.anchor)
    .pipe(asError("start"));
  return yield* deliverFirstPrompt(record, input, connectionId);
});

/**
 * Branches a side chat from one Cake Chat message. Cake Chat forks its Durable
 * conversation after that exchange, so the side chat continues from Cake Chat's
 * exact model context (and its provider prompt cache). A native Durable fork is
 * required before storing a thread; a failed fork never creates a copy-backed
 * or empty discussion.
 */
export const startCakeChatSideChat = Effect.fn("DiscussionSessions.startCakeChatSideChat")(
  function* (input: CakeChatSideChatStartInput, workingDirectory: string, connectionId?: number) {
    const parentSessionId = input.parentSessionId ?? CAKE_CHAT_SESSION_ID;
    yield* requirePrompt(input);
    const messageId = input.anchor.messageId;
    if (input.anchor.view !== "message" || !messageId)
      return yield* new DiscussionSessionError({
        operation: "start",
        message: "A Cake Chat side chat must branch from a message",
      });
    const entryId = input.anchor.entryId;
    if (!entryId?.trim())
      return yield* new DiscussionSessionError({
        operation: "start",
        message: "That Cake Chat message has no entry to branch from. Choose a completed reply.",
      });
    const sessions = yield* CakeSessionRuntimes;
    const environment = yield* DiscussionSessionEnvironment;
    const forked = yield* Effect.scoped(
      sessions
        .acquireSession(parentSessionId)
        .pipe(Effect.flatMap((handle) => handle.fork(entryId, "Side chat"))),
    ).pipe(
      Effect.tapError((error) => Effect.logWarning("Could not fork a Cake Chat side chat", error)),
      Effect.mapError(
        () =>
          new DiscussionSessionError({
            operation: "start",
            message:
              "Could not create a native Cake Chat side chat. Try again from a completed reply.",
          }),
      ),
    );
    if (cakeChatSideChatConversationId(forked.sessionId) === undefined)
      return yield* new DiscussionSessionError({
        operation: "start",
        message: "Cake Chat did not return a native Durable side chat. No discussion was created.",
      });
    const record = yield* environment
      .create(workingDirectory, parentSessionId, input.anchor)
      .pipe(asError("start"));
    const linked = yield* environment
      .linkSidecar(record, { sessionId: forked.sessionId })
      .pipe(asError("start"));
    return yield* deliverFirstPrompt(linked, input, connectionId);
  },
);

/** Agent task launch: native context, existing side-chat presentation and normal result journal. */
export const startTaskSideSession = Effect.fn("DiscussionSessions.startTaskSideSession")(function* (
  input: SideSessionFork,
  source: { sessionId: string; title: string; workingDirectory: string; projectPath?: string },
) {
  const application = yield* ApplicationState;
  if (
    !isCakeChatSessionId(source.sessionId) ||
    (source.projectPath !== undefined && source.projectPath !== input.workspacePath) ||
    !application.snapshot().projects.some((project) => project.path === input.workspacePath) ||
    !(yield* (yield* ProjectAccess).isAllowed(input.workspacePath))
  )
    return yield* new DiscussionSessionError({
      operation: "forkTask",
      message: "The Project is not authorized for this permanent chat",
    });
  const durable = yield* CakeChatDurable;
  const worktree = yield* managedWorktrees.create({
    projectPath: input.workspacePath,
    worktreeName: input.worktreeName,
    backgroundSetup: true,
  });
  yield* (yield* ManagedWorktrees).awaitSetup(worktree.worktreePath);
  const fork = yield* durable.forkTask(source.sessionId, worktree.worktreePath, input.entryId);
  yield* inheritTaskInputProtection(source.sessionId, fork.sessionId);
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment.create(source.workingDirectory, source.sessionId, {
    path: input.name,
    view: "message",
    messageId: fork.entryId,
    entryId: fork.entryId,
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: input.name,
    contextBefore: "",
    contextAfter: "",
    diff: "",
  });
  const linked = yield* environment.linkSidecar(record, { sessionId: fork.sessionId });
  const resultDelivery = input.resultDelivery ?? "notification";
  yield* (yield* SessionFamilyStorage).registerSpawn({
    sessionId: fork.sessionId,
    projectPath: input.workspacePath,
    workingDirectory: worktree.worktreePath,
    requester: { sessionId: source.sessionId, kind: "cake-chat", title: source.title },
    title: input.name,
    reportDelivered: false,
    resultDelivery,
    launchedAt: DateTime.formatIso(yield* DateTime.now),
    handoffSettled: resultDelivery === "ignore",
  });
  const requestId = crypto.randomUUID();
  const text = encodeCrossSessionMessage(input.initialPrompt, {
    version: 1,
    messageId: requestId,
    threadId: requestId,
    sequence: 1,
    expectsResponse: resultDelivery !== "ignore",
    resultDelivery,
    sender: { sessionId: source.sessionId, kind: "cake-chat", title: source.title },
  });
  const started = yield* deliverFirstPrompt(linked, { text });
  return {
    ok: true,
    command: "sessions.fork",
    status: "started",
    sessionId: fork.sessionId,
    sourceSessionId: source.sessionId,
    entryId: fork.entryId,
    workspacePath: worktree.worktreePath,
    managedWorktree: worktree,
    thread: started.thread,
    turnId: started.turnId,
  };
});

/** Import historical dialogue without submitting a request or changing thread lifecycle. */
export const merge = Effect.fn("DiscussionSessions.merge")(function* (
  target: DiscussionSessionTarget,
) {
  if (!isCakeChatSessionId(target.parentSessionId))
    return yield* new DiscussionSessionError({
      operation: "merge",
      message: "Only Project Chat and Cake Chat side chats can merge into main chat",
    });
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment
    .get(target.workingDirectory, target.parentSessionId, target.threadId)
    .pipe(asError("merge"));
  if (record.parentSessionId !== target.parentSessionId || !record.sidecarSessionId)
    return yield* new DiscussionSessionError({
      operation: "merge",
      message: "This side chat has no conversation to merge",
    });
  const sessions = yield* CakeSessionRuntimes;
  const parent = yield* sessions.acquireSession(record.parentSessionId).pipe(asError("merge"));
  const { handle: source } = yield* prepare(record);
  for (const handle of [parent, source]) {
    const snapshot = yield* handle.snapshot().pipe(asError("merge"));
    const turns = yield* handle.currentTurnIds();
    const pending = yield* handle.pendingMessages().pipe(asError("merge"));
    if (snapshot.streaming || turns.length > 0 || pending.items.length > 0)
      return yield* new DiscussionSessionError({
        operation: "merge",
        message: "Wait for both chats to finish before merging",
      });
  }
  const history = yield* source.exportSideChatHistory().pipe(asError("merge"));
  if (history.inputReferenceIds.length > 0) {
    const inputs = yield* TaskInputStorage;
    for (let offset = 0; offset < history.inputReferenceIds.length; offset += 20) {
      const grants = yield* inputs
        .authorizeForward(
          record.sidecarSessionId,
          history.inputReferenceIds.slice(offset, offset + 20),
          record.parentSessionId,
        )
        .pipe(asError("merge"));
      yield* inputs.grant(record.parentSessionId, grants).pipe(asError("merge"));
    }
  }
  return yield* parent
    .importSideChatHistory({ ...history, threadId: record.id, title: "Side chat" })
    .pipe(asError("merge"));
}, Effect.scoped);

export const setResolved = Effect.fn("DiscussionSessions.setResolved")(function* (
  target: DiscussionSessionTarget,
  resolved: boolean,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment
    .get(target.workingDirectory, target.parentSessionId, target.threadId)
    .pipe(asError("setResolved"));
  const thread = projectThread(
    yield* environment.setResolved(record, resolved).pipe(asError("setResolved")),
  );
  return thread;
});
