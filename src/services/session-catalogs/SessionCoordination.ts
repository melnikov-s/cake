import { Context, Effect, Layer, Semaphore } from "effect";
import type {
  CoordinationMessage,
  CoordinationThread,
} from "../../contracts/conversations/cross-session-coordination";

type TurnOutcome = "complete" | "failed" | "aborted";

/** Transient application-wide thread bindings. Pi remains the message authority.
 * Lifetime is the backend, not a window or transport connection; nothing is persisted here.
 */
export class SessionCoordination extends Context.Service<
  SessionCoordination,
  {
    readonly withAdmission: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly create: (
      source: string,
      target: string,
      maxMessages?: number,
    ) => Effect.Effect<CoordinationThread>;
    readonly get: (threadId: string) => Effect.Effect<CoordinationThread | undefined>;
    readonly find: (
      sessionId: string,
      explicitThreadId?: string,
    ) => Effect.Effect<CoordinationThread | undefined>;
    readonly record: (
      thread: CoordinationThread,
      message: CoordinationMessage,
    ) => Effect.Effect<void>;
    readonly close: (thread: CoordinationThread) => Effect.Effect<void>;
    readonly bindTurn: (
      targetSessionId: string,
      messageId: string,
      turnId: string,
    ) => Effect.Effect<void>;
    readonly settleTurn: (turnId: string, outcome: TurnOutcome) => Effect.Effect<void>;
    readonly outcome: (message: CoordinationMessage) => Effect.Effect<TurnOutcome | undefined>;
  }
>()("cake/services/session-catalogs/SessionCoordination") {
  static readonly layer = Layer.effect(
    SessionCoordination,
    Effect.gen(function* () {
      const threads = new Map<string, CoordinationThread>();
      const latest = new Map<string, string>();
      const outcomes = new WeakMap<CoordinationMessage, TurnOutcome>();
      // Serializes thread reservation through Pi admission, never a model response.
      const admission = yield* Semaphore.make(1);
      return SessionCoordination.of({
        withAdmission: (effect) => admission.withPermits(1)(effect),
        create: Effect.fn("SessionCoordination.create")((source, target, maxMessages) =>
          Effect.sync(() => {
            const thread: CoordinationThread = {
              threadId: crypto.randomUUID(),
              participants: [source, target],
              messages: [],
              state: "open",
              ...(maxMessages !== undefined ? { maxMessages } : null),
            };
            threads.set(thread.threadId, thread);
            return thread;
          }),
        ),
        get: Effect.fn("SessionCoordination.get")((id) => Effect.sync(() => threads.get(id))),
        find: Effect.fn("SessionCoordination.find")((id, explicit) =>
          Effect.sync(() => {
            const threadId = explicit ?? latest.get(id);
            const thread = threadId ? threads.get(threadId) : undefined;
            return thread?.participants.includes(id) ? thread : undefined;
          }),
        ),
        record: Effect.fn("SessionCoordination.record")((thread, message) =>
          Effect.sync(() => {
            thread.messages.push(message);
            for (const id of thread.participants) latest.set(id, thread.threadId);
          }),
        ),
        close: Effect.fn("SessionCoordination.close")((thread) =>
          Effect.sync(() => {
            thread.state = "closed";
          }),
        ),
        bindTurn: Effect.fn("SessionCoordination.bindTurn")((targetSessionId, messageId, turnId) =>
          Effect.sync(() => {
            for (const thread of threads.values())
              for (const message of thread.messages)
                if (
                  message.targetSessionId === targetSessionId &&
                  message.messageId === messageId &&
                  message.turnId === messageId
                )
                  message.turnId = turnId;
          }),
        ),
        settleTurn: Effect.fn("SessionCoordination.settleTurn")((turnId, outcome) =>
          Effect.sync(() => {
            for (const thread of threads.values())
              for (const message of thread.messages)
                if (message.turnId === turnId) outcomes.set(message, outcome);
          }),
        ),
        outcome: Effect.fn("SessionCoordination.outcome")((message) =>
          Effect.sync(() => outcomes.get(message)),
        ),
      });
    }),
  );
}
