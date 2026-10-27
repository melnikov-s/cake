import { Schema } from "effect";
import { AgentUpdate } from "./agent-update";
import { PassiveNotice, passiveNoticeContext } from "./passive-notice";

/** Application provenance, supplied by admission code, never inferred from message text. */
export const InternalInput = Schema.TaggedUnion({
  UserWithReminders: {
    text: Schema.String,
    notices: Schema.Array(PassiveNotice),
    updates: Schema.optionalKey(Schema.Array(AgentUpdate)),
    /** Reference reports are carried in their own reminder, not the passive-notice suffix. */
    reportNotices: Schema.optionalKey(Schema.Array(PassiveNotice)),
    /** Exact human input before application reminders were added. */
    userText: Schema.optionalKey(Schema.String),
  },
  /** Timer-delivered batch of deferred updates; carries no user text. */
  UpdateBatch: {
    notices: Schema.Array(PassiveNotice),
    updates: Schema.optionalKey(Schema.Array(AgentUpdate)),
    reportNotices: Schema.optionalKey(Schema.Array(PassiveNotice)),
  },
  AgentUpdate: {
    update: AgentUpdate,
  },
  WorkboardDelivery: {
    boardId: Schema.String,
    sequences: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))),
  },
  /** A background worker's final result, queued for its parent like any other input. */
  SubagentCompletion: {
    details: Schema.Json,
  },
});
export type InternalInput = Schema.Schema.Type<typeof InternalInput>;

export function withoutPassiveNotices(text: string, origin?: InternalInput): string {
  if (origin?._tag !== "UserWithReminders" && origin?._tag !== "UpdateBatch") return text;
  if (!origin.notices.length) return text;
  const suffix = `\n\n${passiveNoticeContext(origin.notices)}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}
