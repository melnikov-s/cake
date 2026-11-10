import { Context, Schema, type Effect } from "effect";
import type { IdleCompactionResult } from "../../contracts/project-sessions/session-compaction";

export class WorktreeLandingAgentError extends Schema.TaggedError<WorktreeLandingAgentError>()(
  "WorktreeLandingAgentError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class WorktreeLandingAgent extends Context.Service<
  WorktreeLandingAgent,
  {
    readonly promptContext: (
      sessionId: string,
    ) => Effect.Effect<
      { readonly estimatedTokens: number | undefined; readonly cacheWarm: boolean },
      WorktreeLandingAgentError
    >;
    /** Deterministic dialogue-only pruning; never model compaction. */
    readonly toolPrune: (
      sessionId: string,
    ) => Effect.Effect<IdleCompactionResult, WorktreeLandingAgentError>;
    /** Accepts one ordinary Project Session turn and waits until that turn settles. */
    readonly promptAndWait: (input: {
      readonly sessionId: string;
      readonly text: string;
    }) => Effect.Effect<void, WorktreeLandingAgentError>;
  }
>()("cake/services/worktrees/WorktreeLandingAgent") {}
