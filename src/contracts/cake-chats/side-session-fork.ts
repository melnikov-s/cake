import { Schema } from "effect";
import { ResultDelivery } from "../conversations/result-delivery";

export const SideSessionFork = Schema.Struct({
  workspacePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  initialPrompt: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100000)),
  entryId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  worktreeName: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  resultDelivery: Schema.optionalKey(ResultDelivery),
});
export interface SideSessionFork extends Schema.Schema.Type<typeof SideSessionFork> {}
