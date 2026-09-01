import { Context, Schema, type Effect } from "effect";

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  operation: Schema.String,
  workingDirectory: Schema.String,
  message: Schema.String,
}) {}

export interface GitService {
  readonly run: (
    workingDirectory: string,
    arguments_: ReadonlyArray<string>,
  ) => Effect.Effect<string, GitError>;
}

/** Process-scoped authority for invoking Git and reporting Git facts. */
export class Git extends Context.Service<Git, GitService>()("cake/services/git/Git") {}

/** Promise adapter used only by the existing Managed Worktree engine. */
export type GitRunner = (
  workingDirectory: string,
  arguments_: ReadonlyArray<string>,
) => Promise<string>;
