import { Context, Schema, type Duration, type Effect } from "effect";

/** One configured lifecycle script run by the worktree engine. */
export interface WorktreeCommandRequest {
  /** Short lifecycle label such as `create`, `setup` or `remove`, used in logs and errors. */
  readonly label: string;
  readonly script: string;
  readonly workingDirectory: string;
  /** Output is appended to one log per worktree name. */
  readonly logName: string;
  readonly timeout?: Duration.Input;
}

export class WorktreeCommandError extends Schema.TaggedError<WorktreeCommandError>()(
  "WorktreeCommandError",
  {
    label: Schema.String,
    reason: Schema.Literals(["exit", "timeout", "start"]),
    logPath: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Runs project-configured worktree scripts with `/bin/sh -c` (not a login shell, so Cake's own
 * `PATH` resolves `git` and other tools), stdin closed, combined output appended to a log file,
 * a checked exit status and an optional timeout that terminates the script's process group.
 */
export class WorktreeCommands extends Context.Service<
  WorktreeCommands,
  {
    readonly run: (request: WorktreeCommandRequest) => Effect.Effect<void, WorktreeCommandError>;
  }
>()("cake/services/worktrees/WorktreeCommands") {}
