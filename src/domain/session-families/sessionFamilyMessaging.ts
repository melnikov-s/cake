import { Effect, Schema, type Scope } from "effect";
import type { CrossSessionContextSnapshot } from "../../contracts/conversations/cross-session-message";
import { SessionTaskOutcome } from "../../contracts/project-sessions/session-reporting";
import type { JsonValue } from "../../ipc/json-contract";
import type { ProjectSessionError, ProjectSessionLocation } from "../../ipc/project-session-data";
import type { acquireOptions } from "../project-sessions/projectSessionRuntime";

/** Moves here from runtime assembly at cutover; decode once in the callback adapter. */
export const FamilyMessageInput = Schema.Struct({
  sessionId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
  threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  maxMessages: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  ),
  expectsResponse: Schema.optionalKey(Schema.Boolean),
  replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  outcome: Schema.optionalKey(SessionTaskOutcome),
});
export interface FamilyMessageInput extends Schema.Schema.Type<typeof FamilyMessageInput> {}

export interface FamilyMessageCaller {
  readonly sessionId: string;
  readonly location: ProjectSessionLocation;
}

/**
 * Review skeleton: owns the existing complete routing/correlation/delivery workflow.
 * undefined retains the existing not-handled fallback; this is not a new message engine.
 * Runtime acquisition stays with the existing Project Session composition point.
 */
export const route: (
  caller: FamilyMessageCaller,
  command: "sessions.send" | "sessions.reply",
  input: FamilyMessageInput,
  senderContext?: CrossSessionContextSnapshot,
) => Effect.Effect<
  JsonValue | undefined,
  ProjectSessionError,
  Effect.Services<ReturnType<typeof acquireOptions>> | Scope.Scope
> = Effect.fn("SessionFamilyMessaging.route")(function* () {
  return yield* Effect.die("Unimplemented review skeleton: SessionFamilyMessaging.route");
});
