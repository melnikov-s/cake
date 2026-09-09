import { Context, type Effect } from "effect";
import type { WorkingDirectoryResolutionResult } from "../../domain/project-sessions/project-session-data";
import type { WorktreeLandingError } from "../../domain/worktrees/worktree-landing-data";

/** Authoritative completion policy invoked by the process-lifetime landing workflow. */
export class WorktreeLandingCompletion extends Context.Service<
  WorktreeLandingCompletion,
  {
    readonly resolveWorkingDirectory: (
      workingDirectory: string,
    ) => Effect.Effect<WorkingDirectoryResolutionResult, WorktreeLandingError>;
  }
>()("cake/services/worktrees/WorktreeLandingCompletion") {}
