import { Schema } from "effect";

const identity = Schema.String.check(Schema.isMinLength(1));

/** A fixed point in the caller's Pi conversation, not a copy of its history. */
export const WidgetConversationOrigin = Schema.Struct({
  sessionId: identity,
  sessionFile: identity,
  entryId: identity,
});
export interface WidgetConversationOrigin extends Schema.Schema.Type<
  typeof WidgetConversationOrigin
> {}

/** Private generator runtime policy; only scalar references cross composition. */
export type WidgetConversationTarget =
  | { readonly type: "parent"; readonly origin: WidgetConversationOrigin }
  | { readonly type: "revision"; readonly sessionId: string }
  | { readonly type: "continue"; readonly sessionId: string };
