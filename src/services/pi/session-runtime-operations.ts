import { Effect } from "effect";
import { PiSessionError } from "./CakeSessionRuntimes";
import { SideChatHistoryBusy } from "./side-chat-history";

export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const sessionError = (operation: string) =>
  Effect.mapError((cause: unknown) => {
    const details = { operation, message: messageOf(cause) };
    return cause instanceof SideChatHistoryBusy
      ? new PiSessionError({ ...details, reason: "side-chat-busy" })
      : new PiSessionError(details);
  });

export const sessionErrorValue = (operation: string) => (cause: unknown) =>
  new PiSessionError({ operation, message: messageOf(cause) });

export const runtimeOperation = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(sessionError(operation));

export const cancellableRuntimeOperation = <A>(
  operation: string,
  evaluate: (signal: AbortSignal) => Promise<A>,
) => Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(sessionError(operation));
