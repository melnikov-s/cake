import { Context, Effect, Layer, Semaphore } from "effect";
import type { SessionCoordinationStorageError } from "../../contracts/storage/session-coordination-storage-errors";
import type {
  CoordinationMessage,
  CoordinationThread,
} from "../../contracts/conversations/cross-session-coordination";
import {
  SessionCoordinationStorage,
  type SessionCoordinationDocument,
} from "../storage/SessionCoordinationStorage";

type TurnOutcome = "complete" | "failed" | "aborted";

/** Durable application-wide correlation metadata; Pi remains the message authority.
 * The backend owns admission and serializes metadata commits independently of model execution.
 */
export class SessionCoordination extends Context.Service<
  SessionCoordination,
  {
    readonly withAdmission: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly checkStorage: () => Effect.Effect<void, SessionCoordinationStorageError>;
    readonly create: (
      source: string,
      target: string,
      maxMessages?: number,
    ) => Effect.Effect<CoordinationThread, SessionCoordinationStorageError>;
    readonly get: (threadId: string) => Effect.Effect<CoordinationThread | undefined>;
    readonly find: (
      sessionId: string,
      explicitThreadId?: string,
    ) => Effect.Effect<CoordinationThread | undefined>;
    readonly record: (
      thread: CoordinationThread,
      message: CoordinationMessage,
    ) => Effect.Effect<void, SessionCoordinationStorageError>;
    readonly close: (
      thread: CoordinationThread,
    ) => Effect.Effect<void, SessionCoordinationStorageError>;
    readonly bindTurn: (
      targetSessionId: string,
      messageId: string,
      turnId: string,
    ) => Effect.Effect<void, SessionCoordinationStorageError>;
    readonly settleTurn: (
      turnId: string,
      outcome: TurnOutcome,
    ) => Effect.Effect<void, SessionCoordinationStorageError>;
    readonly outcome: (message: CoordinationMessage) => Effect.Effect<TurnOutcome | undefined>;
  }
>()("cake/services/session-catalogs/SessionCoordination") {
  static readonly layer = Layer.effect(
    SessionCoordination,
    Effect.gen(function* () {
      const storage = yield* SessionCoordinationStorage;
      const loaded = yield* storage.load().pipe(Effect.result);
      if (loaded._tag === "Failure")
        yield* Effect.logWarning(
          "Session coordination recovery is disabled until its metadata is repaired",
          loaded.failure,
        );
      const stored =
        loaded._tag === "Success" ? loaded.success : { threads: [], latest: [], outcomes: [] };
      const threads = new Map<string, CoordinationThread>(
        stored.threads.map((thread) => [
          thread.threadId,
          {
            ...thread,
            participants: [...thread.participants],
            messages: thread.messages.map((message) => ({ ...message })),
          },
        ]),
      );
      const latest = new Map(stored.latest);
      const outcomes = new Map(stored.outcomes);
      // Serializes thread reservation through Pi admission, never a model response.
      const admission = yield* Semaphore.make(1);
      const mutations = yield* Semaphore.make(1);
      const snapshot = (): SessionCoordinationDocument => ({
        threads: [...threads.values()].map((thread) => ({
          ...thread,
          participants: [...thread.participants],
          messages: thread.messages.map((message) => ({ ...message })),
        })),
        latest: [...latest],
        outcomes: [...outcomes],
      });
      // Commit before changing live references. A failed write remains a typed
      // failure, never an acknowledged transient-only mutation.
      const commit = Effect.fn("SessionCoordination.commit")(
        <A>(
          prepare: (document: SessionCoordinationDocument) => SessionCoordinationDocument,
          apply: () => A,
        ) =>
          mutations.withPermits(1)(
            Effect.gen(function* () {
              if (loaded._tag === "Failure") return yield* loaded.failure;
              const previous = snapshot();
              const next = prepare(previous);
              if (next !== previous) yield* storage.save(next);
              return yield* Effect.sync(apply);
            }).pipe(Effect.uninterruptible),
          ),
      );
      return SessionCoordination.of({
        checkStorage: () => (loaded._tag === "Failure" ? Effect.fail(loaded.failure) : Effect.void),
        withAdmission: (effect) => admission.withPermits(1)(effect),
        create: Effect.fn("SessionCoordination.create")(function* (source, target, maxMessages) {
          const thread: CoordinationThread = {
            threadId: crypto.randomUUID(),
            participants: [source, target],
            messages: [],
            state: "open",
            ...(maxMessages !== undefined ? { maxMessages } : null),
          };
          return yield* commit(
            (document) => ({ ...document, threads: [...document.threads, thread] }),
            () => {
              threads.set(thread.threadId, thread);
              return thread;
            },
          );
        }),
        get: Effect.fn("SessionCoordination.get")((id) => Effect.sync(() => threads.get(id))),
        find: Effect.fn("SessionCoordination.find")((id, explicit) =>
          Effect.sync(() => {
            const threadId = explicit ?? latest.get(id);
            const thread = threadId ? threads.get(threadId) : undefined;
            return thread?.participants.includes(id) ? thread : undefined;
          }),
        ),
        record: Effect.fn("SessionCoordination.record")((thread, message) =>
          commit(
            (document) => ({
              ...document,
              threads: document.threads.map((candidate) =>
                candidate.threadId === thread.threadId &&
                !candidate.messages.some((item) => item.messageId === message.messageId)
                  ? { ...candidate, messages: [...candidate.messages, message] }
                  : candidate,
              ),
              latest: [
                ...document.latest.filter(([id]) => !thread.participants.includes(id)),
                ...thread.participants.map((id): [string, string] => [id, thread.threadId]),
              ],
            }),
            () => {
              if (!thread.messages.some((item) => item.messageId === message.messageId))
                thread.messages.push(message);
              for (const id of thread.participants) latest.set(id, thread.threadId);
            },
          ),
        ),
        close: Effect.fn("SessionCoordination.close")((thread) =>
          commit(
            (document) => ({
              ...document,
              threads: document.threads.map((candidate) =>
                candidate.threadId === thread.threadId
                  ? { ...candidate, state: "closed" }
                  : candidate,
              ),
            }),
            () => {
              thread.state = "closed";
            },
          ),
        ),
        bindTurn: Effect.fn("SessionCoordination.bindTurn")(
          (targetSessionId, messageId, turnId) => {
            const matches = (message: CoordinationMessage) =>
              message.targetSessionId === targetSessionId &&
              message.messageId === messageId &&
              message.turnId === messageId;
            return commit(
              (document) =>
                document.threads.some((thread) => thread.messages.some(matches))
                  ? {
                      ...document,
                      threads: document.threads.map((thread) => ({
                        ...thread,
                        messages: thread.messages.map((message) =>
                          matches(message) ? { ...message, turnId } : message,
                        ),
                      })),
                    }
                  : document,
              () => {
                for (const thread of threads.values())
                  for (const message of thread.messages)
                    if (matches(message)) message.turnId = turnId;
              },
            );
          },
        ),
        settleTurn: Effect.fn("SessionCoordination.settleTurn")((turnId, outcome) => {
          const tracked = () =>
            [...threads.values()].some((thread) =>
              thread.messages.some((message) => message.turnId === turnId),
            );
          return commit(
            (document) =>
              outcomes.has(turnId) || !tracked()
                ? document
                : { ...document, outcomes: [...document.outcomes, [turnId, outcome]] },
            () => {
              if (!outcomes.has(turnId) && tracked()) outcomes.set(turnId, outcome);
            },
          );
        }),
        outcome: Effect.fn("SessionCoordination.outcome")((message) =>
          Effect.sync(() => outcomes.get(message.turnId)),
        ),
      });
    }),
  );
}
