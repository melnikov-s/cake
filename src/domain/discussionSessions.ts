import { Effect, Schema, Stream } from "effect";
import type { DiscussionCatalogUpdate } from "./catalog-data";
import { PiSessionError, PiSessions } from "../services/pi/PiSessions";
import { ProjectSessionEnvironment } from "../services/project-sessions/ProjectSessionEnvironment";
import {
  DiscussionSessionEnvironment,
  DiscussionSessionEnvironmentError,
  type DiscussionSessionRecord,
} from "../services/discussion-sessions/DiscussionSessionEnvironment";
import {
  acquire as acquireConversation,
  observe as observeConversation,
  TurnId,
} from "./conversations";
import {
  DiscussionSessionError,
  type DiscussionSessionCreateInput,
  type DiscussionSessionPromptInput,
  type DiscussionSessionSnapshot,
  type DiscussionSessionTarget,
  type DiscussionSessionUpdate,
  type DiscussionThread,
} from "./discussion-session-data";
import { ReviewStorage } from "../services/storage/ReviewStorage";

export * from "./discussion-session-data";

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
  usage?: Schema.Schema.Type<typeof Schema.Json>,
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
  if (usage !== undefined) Object.assign(thread, { usage });
  return thread;
};

const parentHandle = Effect.fn("DiscussionSessions.parentHandle")(function* (
  target: DiscussionSessionTarget,
) {
  const environment = yield* ProjectSessionEnvironment;
  const sessions = yield* PiSessions;
  const locations = yield* environment.locations().pipe(asError("parentContext"));
  const location = locations.find(
    (candidate) => candidate.workingDirectory === target.workingDirectory,
  );
  if (!location)
    return yield* new DiscussionSessionError({
      operation: "parentContext",
      message: "The Discussion Session parent Working Directory is unavailable",
    });
  const options = yield* environment
    .runtimeOptions({ location, sessionId: target.parentSessionId, newSession: false })
    .pipe(asError("parentContext"));
  return yield* acquireConversation(sessions, options).pipe(asError("parentContext"));
});

const acquireRecord = Effect.fn("DiscussionSessions.acquireRecord")(function* (
  record: DiscussionSessionRecord,
  systemPrompt: string,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const sessions = yield* PiSessions;
  const location = yield* environment.location(record).pipe(asError("acquire"));
  const sidecarSessionId = record.sidecarSessionId ?? crypto.randomUUID();
  const runtime = {
    cwd: record.workingDirectory,
    trusted: location.trusted,
    agentDir: location.agentDirectory,
    sessionDir: location.sessionDirectory,
    newSession: record.sidecarSessionId === undefined,
    sessionId: sidecarSessionId,
    auxiliary: true,
    tools: ["read", "grep", "find", "ls"],
    slashCommands: [],
    additionalSystemPrompt: systemPrompt,
    requestUi: async () => undefined,
  };
  const handle = yield* acquireConversation(sessions, {
    profile: { _tag: "DiscussionSession" },
    runtime,
  }).pipe(asError("acquire"));
  if (record.sidecarSessionId !== undefined) return { record, handle };
  const snapshot = yield* handle.snapshot().pipe(asError("acquire"));
  const linked = yield* environment
    .linkSidecar(record, { sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile })
    .pipe(asError("acquire"));
  return { record: linked, handle };
});

const prepare = Effect.fn("DiscussionSessions.prepare")(function* (
  record: DiscussionSessionRecord,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const parent = yield* parentHandle({
    parentSessionId: record.parentSessionId,
    workingDirectory: record.workingDirectory,
    threadId: record.id,
  });
  const context = yield* parent.reviewParentContext().pipe(asError("parentContext"));
  const systemPrompt = yield* environment
    .prepareParentContext(record, context)
    .pipe(asError("parentContext"));
  return yield* acquireRecord(record, systemPrompt);
});

export const list = Effect.fn("DiscussionSessions.list")(function* (input: {
  readonly workingDirectory: string;
  readonly parentSessionId: string;
}) {
  const environment = yield* DiscussionSessionEnvironment;
  const sessions = yield* PiSessions;
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

export const create = Effect.fn("DiscussionSessions.create")(function* (
  input: DiscussionSessionCreateInput,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment
    .create(input.workingDirectory, input.parentSessionId, input.anchor)
    .pipe(asError("create"));
  return projectThread(record);
});

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
  const prepared = yield* prepare(record);
  return observeConversation(prepared.handle).pipe(
    Stream.map((update): DiscussionSessionUpdate => {
      if (update._tag === "Event")
        return {
          _tag: "Event",
          revision: update.revision,
          threadId: record.id,
          event: update.event,
        };
      const snapshot: DiscussionSessionSnapshot = {
        identity: {
          _tag: "DiscussionSession",
          sessionId: prepared.record.sidecarSessionId ?? update.snapshot.sessionId,
          parentSessionId: record.parentSessionId,
        },
        thread: projectThread(prepared.record, update.snapshot.parts, update.snapshot.usage),
        conversation: update.snapshot,
      };
      return { _tag: "Snapshot", revision: update.revision, snapshot };
    }),
    Stream.tap((update) =>
      update._tag === "Event" && update.event._tag === "TurnSettled"
        ? environment.refreshParentIndex(prepared.record).pipe(asError("refreshParentIndex"))
        : Effect.void,
    ),
    Stream.mapError((error) =>
      error instanceof DiscussionSessionError
        ? error
        : new DiscussionSessionError({ operation: "observe", message: String(error) }),
    ),
  );
});

export const prompt = Effect.fn("DiscussionSessions.prompt")(function* (
  input: DiscussionSessionPromptInput,
) {
  const annotations = input.annotations ?? [];
  if (!input.text.trim() && annotations.length === 0)
    return yield* new DiscussionSessionError({
      operation: "prompt",
      message: "A Discussion Session prompt cannot be empty",
    });
  const environment = yield* DiscussionSessionEnvironment;
  let record = yield* environment
    .get(input.workingDirectory, input.parentSessionId, input.threadId)
    .pipe(asError("prompt"));
  if (record.status === "resolved")
    record = yield* environment.setResolved(record, false).pipe(asError("prompt"));
  const prepared = yield* prepare(record);
  if (input.model)
    yield* prepared.handle.setModel(input.model.provider, input.model.id).pipe(asError("prompt"));
  if (input.thinkingLevel)
    yield* prepared.handle.setThinkingLevel(input.thinkingLevel).pipe(asError("prompt"));
  const attachments = annotations.length > 0 ? [{ kind: "annotation" as const, annotations }] : [];
  const turnId = TurnId.make(
    yield* prepared.handle.prompt(input.text.trim(), attachments).pipe(asError("prompt")),
  );
  return { turnId, thread: projectThread(prepared.record) };
});

export const abort = Effect.fn("DiscussionSessions.abort")(function* (
  target: DiscussionSessionTarget,
) {
  const environment = yield* DiscussionSessionEnvironment;
  const record = yield* environment
    .get(target.workingDirectory, target.parentSessionId, target.threadId)
    .pipe(asError("abort"));
  const prepared = yield* prepare(record);
  yield* prepared.handle.abort().pipe(asError("abort"));
});

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
