import { Context, Schema, type Effect } from "effect";

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
    /** Accepts one ordinary Project Session turn and waits until that turn settles. */
    readonly promptAndWait: (input: {
      readonly sessionId: string;
      readonly text: string;
    }) => Effect.Effect<void, WorktreeLandingAgentError>;
  }
>()("cake/services/worktrees/WorktreeLandingAgent") {}
