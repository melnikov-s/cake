import { Effect, Stream } from "effect";
import * as subagents from "../../domain/subagents";
import { SubagentRpc } from "../protocol/SubagentRpc";

export const subagentHandlers = SubagentRpc.of({
  "subagents.observe": ({ parentSessionId }) => Stream.unwrap(subagents.observe(parentSessionId)),
  "subagents.steer": ({ parentSessionId, handleId, text }) =>
    subagents.steer(parentSessionId, handleId, text),
  "subagents.abort": ({ parentSessionId, handleId }) => subagents.abort(parentSessionId, handleId),
  "subagents.close": ({ parentSessionId, handleId }) =>
    subagents.close(parentSessionId, handleId).pipe(Effect.asVoid),
});
