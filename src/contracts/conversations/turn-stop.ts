import { Schema } from "effect";
import { parseSessionLink } from "./message-reference";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const reason = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500)));

export const TurnNoticeSource = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  href: Schema.String.check(
    Schema.isMaxLength(4096),
    Schema.makeFilter((href) => {
      const target = parseSessionLink(href);
      return !!target && !target.messageId && !target.attachmentId;
    }),
  ),
});

/** An explicit stop, whether or not the source can safely be shown. No marker means interruption. */
export const TurnStop = Schema.Union([
  Schema.Struct({ by: Schema.Literal("user"), reason }),
  Schema.Struct({ by: Schema.Literal("conversation"), source: TurnNoticeSource, reason }),
  Schema.Struct({ by: Schema.Literal("unattributed") }),
  // Old markers did not establish that their title or ID was safe to expose.
  Schema.Struct({
    by: Schema.Literal("session"),
    sessionId: boundedId,
    title: Schema.String.check(Schema.isMaxLength(500)),
    reason,
  }),
]);
export type TurnStop = typeof TurnStop.Type;

/** Transcript notices retain distinct settlement meanings. */
export const TURN_STOPPED_NOTICE_TITLE = "Stopped";
export const TURN_INTERRUPTED_NOTICE_TITLE = "Turn interrupted";

/**
 * One plain phrase naming who stopped the turn. `you` addresses the user in Cake's own UI;
 * agent-facing reports name the user in the third person.
 */
export function describeTurnStop(stop: TurnStop, audience: "user" | "agent" = "user") {
  if (stop.by === "unattributed") return "stopped";
  const who =
    stop.by === "user"
      ? audience === "user"
        ? "you"
        : "the user"
      : stop.by === "conversation"
        ? stop.source.title
        : stop.title.trim() || `session ${stop.sessionId}`;
  const why = stop.reason?.trim();
  return `stopped by ${who}${why ? ` (${why})` : ""}`;
}
