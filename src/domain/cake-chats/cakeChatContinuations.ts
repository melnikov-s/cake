import { Effect } from "effect";
import { TurnId, use as useConversation } from "../conversations/conversations";
import { type CakeChatTarget } from "./cake-chat-data";
import { acquireForUse, acquireTarget } from "./cakeChatOperations";
import { asError, publishCatalogChange } from "./cakeChatMetadata";
import type { CakeChatRuntimeConfiguration } from "./cakeChatRuntime";

export const toolCompact = Effect.fn("CakeChats.toolCompact")(function* (input: {
  readonly target: CakeChatTarget;
  readonly entryId: string;
  readonly prompt?: string;
  readonly configuration: CakeChatRuntimeConfiguration;
}) {
  const compacted = yield* useConversation(
    acquireForUse(input.target, input.configuration),
    (handle) => handle.toolCompact(input.entryId),
  ).pipe(asError("toolCompact"));
  let turnId: TurnId | undefined;
  if (input.prompt?.trim()) {
    const target = { ...input.target, sessionId: compacted.sessionId };
    const next = yield* acquireTarget(target, false, input.configuration);
    turnId = TurnId.make(yield* next.prompt(input.prompt.trim()).pipe(asError("toolCompact")));
  }
  yield* publishCatalogChange(compacted.sessionId, false);
  return turnId ? { sessionId: compacted.sessionId, turnId } : { sessionId: compacted.sessionId };
});
