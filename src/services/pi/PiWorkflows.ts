import { Effect } from "effect";
import type { JsonValue } from "../../ipc/json-contract";
import {
  findSessionFile,
  forkWorkspaceSession,
  inspectWorkspace as inspectWorkspaceSync,
} from "./runtime/session-discovery";
import { runSessionAssistant } from "./runtime/session-assistant";
import { rewordSelectionWithProjectContext } from "./runtime/rewording-agent";

type SessionAssistantOptions = Parameters<typeof runSessionAssistant>[0];
type SessionAssistantInvocation = Parameters<SessionAssistantOptions["invoke"]>[0];
type RewordSelectionOptions = Parameters<typeof rewordSelectionWithProjectContext>[0];

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

export const inspectWorkspace = Effect.fn("PiWorkflows.inspectWorkspace")((path: string) =>
  Effect.try({ try: () => inspectWorkspaceSync(path), catch: asError }),
);

export const rewordProjectSelection = Effect.fn("PiWorkflows.rewordProjectSelection")(
  (options: RewordSelectionOptions) =>
    Effect.tryPromise({
      try: (signal) =>
        rewordSelectionWithProjectContext({
          ...options,
          signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
        }),
      catch: asError,
    }),
);

export const runProjectSessionAssistant = Effect.fn("PiWorkflows.runProjectSessionAssistant")(
  function* (
    options: Omit<SessionAssistantOptions, "invoke"> & {
      readonly invoke: (
        invocation: SessionAssistantInvocation,
        signal: AbortSignal,
      ) => Effect.Effect<JsonValue, unknown, never>;
    },
  ) {
    const context = yield* Effect.context<never>();
    const runCallback = Effect.runPromiseWith(context);
    return yield* Effect.tryPromise({
      try: (signal) =>
        runSessionAssistant({
          ...options,
          signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
          invoke: (invocation, callbackSignal) =>
            runCallback(options.invoke(invocation, callbackSignal), { signal: callbackSignal }),
        }),
      catch: asError,
    });
  },
);

export const locateSessionFile = Effect.fn("PiWorkflows.locateSessionFile")(
  (cwd: string, sessionId: string, sessionDirectory: string, direct = false) =>
    Effect.tryPromise({
      try: () => findSessionFile(cwd, sessionId, sessionDirectory, direct),
      catch: asError,
    }),
);

export const forkSessionToWorkingDirectory = Effect.fn("PiWorkflows.forkSessionToWorkingDirectory")(
  (input: {
    readonly sourceFile: string;
    readonly sourceWorkingDirectory: string;
    readonly entryId: string;
    readonly destinationWorkingDirectory: string;
    readonly sessionDirectory: string;
    readonly title: string;
  }) =>
    Effect.try({
      try: () =>
        forkWorkspaceSession(
          input.sourceFile,
          input.sourceWorkingDirectory,
          input.entryId,
          input.destinationWorkingDirectory,
          input.sessionDirectory,
          input.title,
        ),
      catch: asError,
    }),
);
