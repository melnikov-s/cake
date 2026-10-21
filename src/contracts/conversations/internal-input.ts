import { Schema } from "effect";
import { PassiveNotice, passiveNoticeContext } from "./passive-notice";

/** Application provenance, supplied by admission code, never inferred from message text. */
export const InternalInput = Schema.TaggedUnion({
  UserWithReminders: {
    text: Schema.String,
    notices: Schema.Array(PassiveNotice),
  },
  /** Timer-delivered batch of deferred updates; carries no user text. */
  UpdateBatch: {
    notices: Schema.Array(PassiveNotice),
  },
  WorkboardDelivery: {
    boardId: Schema.String,
    sequences: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))),
  },
});
export type InternalInput = Schema.Schema.Type<typeof InternalInput>;

export function withoutPassiveNotices(text: string, origin?: InternalInput): string {
  if (origin?._tag !== "UserWithReminders" && origin?._tag !== "UpdateBatch") return text;
  if (!origin.notices.length) return text;
  const suffix = `\n\n${passiveNoticeContext(origin.notices)}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}
