import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import * as backendAgentControl from "../application/agentControl";
import * as sessionReferences from "../project-sessions/sessionReferences";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import { forwardTaskInputControl } from "../cake-chats/taskInputControls";
import { validateMessageReferenceControl } from "../conversations/messageReferenceForwarding";
import { acquireOptions as acquireProjectSessionOptions } from "../project-sessions/projectSessionRuntime";
import { Effect, Option, Schema, Stream } from "effect";
import type { DiscussionCatalogUpdate } from "../../contracts/application/catalog-data";
import { type CakeControlTool } from "../../contracts/cake-chats/cake-chat-data";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
  cakeChatSideChatConversationId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { jsonObjectSchema } from "../../contracts/serialization/json-contract";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import {
  PiSessionError,
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
  type CakeSessionHandle,
} from "../../services/pi/CakeSessionRuntimes";
import { sessionAssistantSystemPrompt } from "../../services/pi/session-assistant";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { ApplicationState } from "../../services/storage/ApplicationState";
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
  isSessionAssistantThread,
  type SessionAssistantEnsureInput,
  type SessionAssistantEnsured,
  sessionAssistantThreadPath,
} from "../../contracts/discussion-sessions/discussion-session-data";
import { ReviewStorage } from "../../services/storage/ReviewStorage";

export * from "../../contracts/discussion-sessions/discussion-session-data";

const sessionAssistantAnchor = (parentSessionId: string) => ({
  path: sessionAssistantThreadPath(parentSessionId),
  view: "session" as const,
  start: { diffLine: 0 },
  end: { diffLine: 0 },
  selectedText: "",
  contextBefore: "",
  contextAfter: "",
  diff: "",
});

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
/** How one sidecar differs from the default read-only side chat runtime. */
interface SidecarConfiguration {
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<string>;
  readonly sessionControl?: CakeSessionRuntimeAcquireOptions["runtime"]["sessionControl"];
  /** Applied on every acquisition so the sidecar follows this model. */
  readonly model?: {
    readonly provider: string;
    readonly modelId: string;
    readonly thinkingLevel: Parameters<CakeSessionHandle["setThinkingLevel"]>[0];
  };
}

const acquireRecord = Effect.fn("DiscussionSessions.acquireRecord")(function* (
  record: DiscussionSessionRecord,
  configuration: SidecarConfiguration,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const sessions = yield* CakeSessionRuntimes;
  const services = yield* Effect.context<RefreshServices>();
  const location = yield* environment.location(record).pipe(asError("acquire"));
  const sidecarSessionId = record.sidecarSessionId ?? crypto.randomUUID();
  // Hooks run long after acquisition, so they re-read the stored thread each time.
  const current = Effect.suspend(() =>
    environment.get(record.workingDirectory, record.parentSessionId, record.id),
  );
  const refreshParentIndex = current.pipe(Effect.flatMap(environment.refreshParentIndex));
  const runtime = {
    cwd: record.workingDirectory,
    trusted: location.trusted,
    agentDir: location.agentDirectory,
    sessionDir: location.sessionDirectory,
    directSessionDir: true,
    newSession: record.sidecarSessionId === undefined,
    sessionId: sidecarSessionId,
    auxiliary: true,
    tools: [...configuration.tools],
    slashCommands: [],
    additionalSystemPrompt: configuration.systemPrompt,
    requestUi: async () => undefined,
  };
  if (configuration.sessionControl)
    Object.assign(runtime, { sessionControl: configuration.sessionControl });
  const handle = yield* acquireConversation(sessions, {
    profile: { _tag: "DiscussionSession" },
    runtime,
    onSessionChanged: refreshParentIndex,
    onTurnSettled: () => refreshParentIndex,
    admitTurn: (_input, accept) =>
      current.pipe(
        Effect.flatMap((latest) =>
          latest.status === "resolved"
            ? environment.setResolved(latest, false).pipe(Effect.asVoid)
            : Effect.void,
        ),
        // The projection points at a stable path, so refreshing it never
        // requires rebuilding the runtime. A parent that cannot be read right
        // now leaves the previous projection in place. A Cake Chat side chat's
        // branch context is captured once when it starts.
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
        Effect.andThen(accept),
      ),
  }).pipe(asError("acquire"));
  if (configuration.model) {
    yield* handle
      .setModel(configuration.model.provider, configuration.model.modelId)
      .pipe(asError("acquire"));
    yield* handle.setThinkingLevel(configuration.model.thinkingLevel).pipe(asError("acquire"));
  }
  if (record.sidecarSessionId !== undefined) return { record, handle };
  const snapshot = yield* handle.snapshot().pipe(asError("acquire"));
  const linked = yield* environment
    .linkSidecar(record, { sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile })
    .pipe(asError("acquire"));
  return { record: linked, handle };
});

const sideChatConfiguration = Effect.fn("DiscussionSessions.sideChatConfiguration")(function* (
  record: DiscussionSessionRecord,
): Effect.fn.Return<SidecarConfiguration, DiscussionSessionError, DiscussionSessionEnvironment> {
  // A Durable fork inherits Cake Chat's exact agent (prompt, model and tools) at
  // its branch point; Cake Chat's runtime refuses Cake controls inside it.
  if (cakeChatSideChatConversationId(record.sidecarSessionId) !== undefined)
    return { systemPrompt: "", tools: [] };
  const environment = yield* DiscussionSessionEnvironment;
  const systemPrompt = yield* environment.sidecarSystemPrompt(record).pipe(asError("acquire"));
  // A copied-context Cake Chat side chat discusses the inlined branch context
  // and cannot act on the workspace or Cake.
  return {
    systemPrompt,
    tools: isCakeChatSideChat(record) ? [] : ["read", "grep", "find", "ls"],
  };
});

/**
 * The session assistant is an ordinary side chat on the utility model with the
 * validated Cake application-control gateway for its parent Project Session.
 * Unlike a read-only side chat, it has the standard file and shell tools in
 * the parent's Working Directory, plus the complete validated application controls.
 */
const sessionAssistantConfiguration = Effect.fn("DiscussionSessions.sessionAssistantConfiguration")(
  function* (record: DiscussionSessionRecord, tools: ReadonlyArray<CakeControlTool>) {
    const environment = yield* DiscussionSessionEnvironment;
    const application = yield* ApplicationState;
    const rendererRequests = yield* RendererRequestCoordinator;
    const utilityModel = application.snapshot().utilityModel;
    if (!utilityModel)
      return yield* new DiscussionSessionError({
        operation: "acquire",
        message: "Configure a utility model in Settings before using the session assistant",
      });
    const run = makePiCallbackExecutor(
      yield* Effect.context<backendAgentControl.AgentControlServices>(),
    );
    const controlTools = tools.map((tool) => ({
      ...tool,
      parameters: Schema.decodeUnknownSync(jsonObjectSchema)(tool.parameters),
      examples: tool.examples?.map((example) => ({
        ...example,
        input:
          example.input === undefined
            ? undefined
            : Schema.decodeUnknownSync(jsonObjectSchema)(example.input),
      })),
    }));
    const parentContextPrompt = yield* environment
      .sidecarSystemPrompt(record)
      .pipe(asError("acquire"));
    const configuration: SidecarConfiguration = {
      systemPrompt: sessionAssistantSystemPrompt({
        parentContextPrompt,
        parentSessionId: record.parentSessionId,
        tools: controlTools,
      }),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "cake"],
      sessionControl: {
        tools: controlTools,
        // Pi requires a Promise callback; this is the final adapter from the
        // Cake-owned control Effect to the Pi runtime callback contract.
        invoke: (invocation, signal) =>
          run(
            Effect.scoped(
              Effect.gen(function* () {
                if (!backendAgentControl.handles(invocation.name))
                  return yield* rendererRequests.requestProjectControl(
                    record.parentSessionId,
                    {
                      _tag: "InvokeAppControl",
                      command: invocation.name,
                      input: Schema.decodeUnknownSync(jsonObjectSchema)(invocation.arguments),
                    },
                    signal,
                    "discussion-session",
                  );
                const argumentsObject = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(
                  invocation.arguments,
                );
                if (Schema.is(Schema.String)(argumentsObject.sessionId))
                  invocation = {
                    ...invocation,
                    arguments: {
                      ...argumentsObject,
                      sessionId: yield* sessionReferences.resolve(argumentsObject.sessionId),
                    },
                  };
                const location = yield* findLocation({
                  sessionId: record.parentSessionId,
                  workingDirectory: record.workingDirectory,
                });
                yield* validateMessageReferenceControl(invocation);
                const forwarded = yield* forwardTaskInputControl(
                  record.parentSessionId,
                  invocation,
                );
                const summary = yield* (yield* CakeSessionRuntimes).catalogEntry(
                  {
                    workingDirectory: location.workingDirectory,
                    sessionDirectory: location.sessionDirectory,
                  },
                  record.parentSessionId,
                );
                const result = yield* backendAgentControl.invoke(
                  forwarded.name,
                  forwarded.arguments,
                  {
                    kind: "project-session",
                    sessionId: record.parentSessionId,
                    title: summary?.title ?? `Project Session ${record.parentSessionId}`,
                    projectName: location.projectName,
                    projectPath: location.projectPath,
                    workingDirectory: location.workingDirectory,
                  },
                );
                if (result === undefined)
                  return yield* new DiscussionSessionError({
                    operation: "control",
                    message: "Backend control was not handled",
                  });
                return result;
              }),
            ).pipe(Effect.orDie),
            { signal },
          ),
      },
      model: {
        provider: utilityModel.provider,
        modelId: utilityModel.modelId,
        thinkingLevel: utilityModel.thinkingLevel,
      },
    };
    return configuration;
  },
);

/** Acquires a thread's sidecar; the parent projection is regenerated per turn, not here. */
const prepare = Effect.fn("DiscussionSessions.prepare")(function* (
  record: DiscussionSessionRecord,
  tools?: ReadonlyArray<CakeControlTool>,
) {
  const configuration = isSessionAssistantThread(record)
    ? yield* sessionAssistantConfiguration(record, tools ?? [])
    : yield* sideChatConfiguration(record);
  return yield* acquireRecord(record, configuration);
});

/**
 * Ensures a parent's assistant Discussion Session exists. A thread that has no
 * sidecar yet is started with the pending first message, exactly as `start`
 * does for other side chats; Pi persists the sidecar with that message.
 */
export const ensureSessionAssistant = Effect.fn("DiscussionSessions.ensureSessionAssistant")(
  function* (
    input: SessionAssistantEnsureInput,
  ): Effect.fn.Return<
    SessionAssistantEnsured,
    DiscussionSessionError,
    | RefreshServices
    | RendererRequestCoordinator
    | ApplicationState
    | backendAgentControl.AgentControlServices
  > {
    const environment = yield* DiscussionSessionEnvironment;
    const record = yield* environment
      .ensure(
        input.workingDirectory,
        input.parentSessionId,
        sessionAssistantAnchor(input.parentSessionId),
      )
      .pipe(asError("ensureSessionAssistant"));
    // A staged parent has no transcript to project; its renderer-held messages
    // stand in until the parent materializes and per-turn regeneration takes over.
    if (input.staged)
      yield* environment
        .prepareStagedParentContext(record, input.stagedMessages)
        .pipe(asError("ensureSessionAssistant"));
    if (record.sidecarSessionId !== undefined) return { thread: projectThread(record) };
    const firstPrompt = input.firstPrompt;
    if (!firstPrompt) return { thread: projectThread(record) };
    const prepared = yield* prepare(record, input.tools);
    const annotations = firstPrompt.annotations ?? [];
    const attachments =
      annotations.length > 0 ? [{ kind: "annotation" as const, annotations }] : [];
    const turnId = TurnId.make(
      yield* prepared.handle
        .prompt(firstPrompt.text.trim(), attachments)
        .pipe(asError("ensureSessionAssistant")),
    );
    yield* environment.refreshParentIndex(prepared.record).pipe(asError("ensureSessionAssistant"));
    return { thread: projectThread(prepared.record), turnId };
  },
);

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
  const prepared = yield* prepare(record, target.tools);
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

/** Acquires a new thread's sidecar and delivers its first prompt. */
const deliverFirstPrompt = Effect.fn("DiscussionSessions.deliverFirstPrompt")(function* (
  record: DiscussionSessionRecord,
  input: FirstPrompt,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const annotations = input.annotations ?? [];
  const prepared = yield* prepare(record);
  if (input.model)
    yield* prepared.handle.setModel(input.model.provider, input.model.id).pipe(asError("start"));
  if (input.thinkingLevel)
    yield* prepared.handle.setThinkingLevel(input.thinkingLevel).pipe(asError("start"));
  const attachments = annotations.length > 0 ? [{ kind: "annotation" as const, annotations }] : [];
  const turnId = TurnId.make(
    yield* prepared.handle.prompt(input.text.trim(), attachments).pipe(asError("start")),
  );
  yield* environment.refreshParentIndex(prepared.record).pipe(asError("start"));
  return { turnId, thread: projectThread(prepared.record) };
});

/** Creates a Discussion Session and delivers its first prompt to a new sidecar. */
export const start = Effect.fn("DiscussionSessions.start")(function* (
  input: DiscussionSessionStartInput,
) {
  yield* requirePrompt(input);
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment
    .create(input.workingDirectory, input.parentSessionId, input.anchor)
    .pipe(asError("start"));
  return yield* deliverFirstPrompt(record, input);
});

/**
 * Branches a side chat from one Cake Chat message. Cake Chat forks its Durable
 * conversation after that exchange, so the side chat continues from Cake Chat's
 * exact model context (and its provider prompt cache). When Cake Chat cannot
 * fork there, the conversation text through that message is copied into the
 * side chat's instructions instead. Either way the branch point is resolved
 * before the thread is stored, so a missing message never leaves an empty
 * thread behind.
 */
export const startCakeChatSideChat = Effect.fn("DiscussionSessions.startCakeChatSideChat")(
  function* (input: CakeChatSideChatStartInput, workingDirectory: string) {
    const parentSessionId = input.parentSessionId ?? CAKE_CHAT_SESSION_ID;
    yield* requirePrompt(input);
    const messageId = input.anchor.messageId;
    if (input.anchor.view !== "message" || !messageId)
      return yield* new DiscussionSessionError({
        operation: "start",
        message: "A Cake Chat side chat must branch from a message",
      });
    const sessions = yield* CakeSessionRuntimes;
    const environment = yield* DiscussionSessionEnvironment;
    const entryId = input.anchor.entryId;
    const forked = entryId
      ? yield* Effect.scoped(
          sessions
            .acquireSession(parentSessionId)
            .pipe(Effect.flatMap((handle) => handle.fork(entryId, "Side chat"))),
        ).pipe(
          Effect.map((fork) => fork.sessionId),
          Effect.catch((error) =>
            Effect.logWarning(
              "Cake Chat side chat falls back to copied context",
              error.message,
            ).pipe(Effect.as(undefined)),
          ),
        )
      : undefined;
    if (forked && cakeChatSideChatConversationId(forked) !== undefined) {
      const record = yield* environment
        .create(workingDirectory, parentSessionId, input.anchor)
        .pipe(asError("start"));
      const linked = yield* environment
        .linkSidecar(record, { sessionId: forked })
        .pipe(asError("start"));
      return yield* deliverFirstPrompt(linked, input);
    }
    const snapshot = yield* Effect.scoped(
      sessions.acquireSession(parentSessionId).pipe(Effect.flatMap((handle) => handle.snapshot())),
    ).pipe(asError("start"));
    const messages = cakeChatBranchMessages(snapshot.parts, input.anchor);
    if (!messages)
      return yield* new DiscussionSessionError({
        operation: "start",
        message: "That Cake Chat message is no longer available",
      });
    const record = yield* environment
      .create(workingDirectory, parentSessionId, input.anchor)
      .pipe(asError("start"));
    yield* environment.prepareCakeChatBranchContext(record, messages).pipe(asError("start"));
    return yield* deliverFirstPrompt(record, input);
  },
);

const BranchTextPart = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("text"),
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  entryId: Schema.optional(Schema.String),
});
const decodeBranchTextPart = Schema.decodeUnknownOption(BranchTextPart);

/** User and assistant text through the anchored message, or undefined when it is gone. */
const cakeChatBranchMessages = (
  parts: ReadonlyArray<unknown>,
  anchor: { readonly messageId?: string; readonly entryId?: string },
) => {
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const candidate of parts) {
    const part = Option.getOrUndefined(decodeBranchTextPart(candidate));
    if (!part) continue;
    messages.push({ role: part.role, text: part.text });
    if (part.id === anchor.messageId || (anchor.entryId && part.entryId === anchor.entryId))
      return messages;
  }
  return undefined;
};

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
