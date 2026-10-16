import { Schema } from "effect";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const reason = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500)));

/**
 * Who deliberately stopped a running turn, and why. A stop carrying this attribution is a
 * requested outcome, not a failure; unattributed aborts (teardown, crash recovery, internal
 * cancellation) remain unexpected interruptions.
 */
export const TurnStop = Schema.Union([
  Schema.Struct({ by: Schema.Literal("user"), reason }),
  Schema.Struct({
    by: Schema.Literal("session"),
    sessionId: boundedId,
    title: Schema.String.check(Schema.isMaxLength(500)),
    reason,
  }),
]);
export type TurnStop = typeof TurnStop.Type;

/** Transcript notice title for a deliberately stopped turn. */
export const TURN_STOPPED_NOTICE_TITLE = "Stopped";

/**
 * One plain phrase naming who stopped the turn. `you` addresses the user in Cake's own UI;
 * agent-facing reports name the user in the third person.
 */
export function describeTurnStop(stop: TurnStop, audience: "user" | "agent" = "user") {
  const who =
    stop.by === "user"
      ? audience === "user"
        ? "you"
        : "the user"
      : stop.title.trim() || `session ${stop.sessionId}`;
  const why = stop.reason?.trim();
  return `stopped by ${who}${why ? ` (${why})` : ""}`;
}
