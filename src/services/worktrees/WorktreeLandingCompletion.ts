import { Context, type Effect } from "effect";
import type { WorkingDirectoryResolutionResult } from "../../contracts/project-sessions/project-session-resolution";
import type { WorktreeLandingError } from "../../contracts/worktrees/worktree-landing-data";

/** Authoritative completion policy invoked by the process-lifetime landing workflow. */
export class WorktreeLandingCompletion extends Context.Service<
  WorktreeLandingCompletion,
  {
    readonly resolveWorkingDirectory: (
      workingDirectory: string,
    ) => Effect.Effect<WorkingDirectoryResolutionResult, WorktreeLandingError>;
  }
>()("cake/services/worktrees/WorktreeLandingCompletion") {}
