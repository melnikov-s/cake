import { Effect } from "effect";
import {
  findSessionFile,
  forkWorkspaceSession,
  inspectWorkspace as inspectWorkspaceSync,
} from "./runtime/session-discovery";
import { rewordSelectionWithProjectContext } from "./runtime/rewording-agent";

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
