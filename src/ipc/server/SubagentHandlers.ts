import { Effect, Stream } from "effect";
import * as subagents from "../../domain/subagents/subagents";
import { SubagentRpc } from "../protocol/SubagentRpc";

export const subagentHandlers = SubagentRpc.of({
  "subagents.observe": ({ parentSessionId }) => Stream.unwrap(subagents.observe(parentSessionId)),
  "subagents.prompt": ({ parentSessionId, handleId, text }) =>
    subagents.prompt(parentSessionId, handleId, text, "prompt").pipe(Effect.asVoid),
  "subagents.steer": ({ parentSessionId, handleId, text }) =>
    subagents.steer(parentSessionId, handleId, text),
  "subagents.abort": ({ parentSessionId, handleId }) => subagents.abort(parentSessionId, handleId),
  "subagents.close": ({ parentSessionId, handleId }) =>
    subagents.close(parentSessionId, handleId).pipe(Effect.asVoid),
});
