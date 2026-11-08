import { Context, Layer, Schema, type Effect } from "effect";
import type { PiContextFork } from "../pi/context-fork";

const SubagentLocation = Schema.Struct({
  workingDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  agentDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  sessionDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
interface SubagentLocation extends Schema.Schema.Type<typeof SubagentLocation> {}

export class SubagentEnvironmentError extends Schema.TaggedError<SubagentEnvironmentError>()(
  "SubagentEnvironmentError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface SubagentEnvironmentService {
  /** Optional in limited hosts; context forks must fail, never fall back to Side Chats. */
  readonly seedContext?: (
    workingDirectory: string,
    sessionId: string,
    context: PiContextFork,
  ) => Effect.Effect<void, SubagentEnvironmentError>;
  readonly location: (
    workingDirectory?: string,
  ) => Effect.Effect<SubagentLocation, SubagentEnvironmentError>;
}

/** Temporary outside-world adapter for private Pi Session roots. */
export class SubagentEnvironment extends Context.Service<
  SubagentEnvironment,
  SubagentEnvironmentService
>()("cake/services/subagents/SubagentEnvironment") {}

export const makeSubagentEnvironmentLayer = (
  service: SubagentEnvironmentService,
): Layer.Layer<SubagentEnvironment> =>
  Layer.succeed(SubagentEnvironment, SubagentEnvironment.of(service));
