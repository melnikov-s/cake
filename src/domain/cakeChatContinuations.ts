import { Effect } from "effect";
import { getState, setSessionFastMode } from "./application";
import { TurnId, use as useConversation } from "./conversations";
import { type CakeChatTarget } from "./cake-chat-data";
import { acquireForUse, acquireTarget } from "./cakeChatOperations";
import { asError, publishCatalogChange } from "./cakeChatMetadata";
import type { CakeChatRuntimeConfiguration } from "./cakeChatRuntime";
import { resolve } from "./cakeChatLifecycle";

export const handoff = Effect.fn("CakeChats.handoff")(function* (input: {
  readonly target: CakeChatTarget;
  readonly entryId: string;
  readonly prompt?: string;
  readonly resolveSource?: boolean;
  readonly configuration: CakeChatRuntimeConfiguration;
}) {
  const state = yield* getState();
  const inheritFastMode = state.fastModeSessionIds.includes(input.target.sessionId);
  const handedOff = yield* useConversation(
    acquireForUse(input.target, input.configuration),
    (handle) => handle.handoff(input.entryId),
  ).pipe(asError("handoff"));
  if (inheritFastMode)
    yield* setSessionFastMode(handedOff.sessionId, true).pipe(asError("handoff"));
  let turnId: TurnId | undefined;
  if (input.prompt?.trim()) {
    const target = { ...input.target, sessionId: handedOff.sessionId };
    const next = yield* acquireTarget(target, false, input.configuration);
    turnId = TurnId.make(yield* next.prompt(input.prompt.trim()).pipe(asError("handoff")));
  }
  if (input.resolveSource) yield* resolve(input.target, input.configuration);
  yield* publishCatalogChange(handedOff.sessionId, false);
  return turnId ? { sessionId: handedOff.sessionId, turnId } : { sessionId: handedOff.sessionId };
});
