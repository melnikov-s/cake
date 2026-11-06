import * as subagentInputs from "../../domain/subagents/subagentInputs";
import * as subagentLifetime from "../../domain/subagents/subagentLifetime";
import * as subagentObservation from "../../domain/subagents/subagentObservation";
import { Effect, Stream } from "effect";
import { SubagentRpc } from "../protocol/SubagentRpc";

export const subagentHandlers = SubagentRpc.of({
  "subagents.observeMetadata": ({ parentSessionId }) =>
    Stream.unwrap(subagentObservation.observeMetadata(parentSessionId)),
  "subagents.observe": ({ parentSessionId }) =>
    Stream.unwrap(subagentObservation.observe(parentSessionId)),
  "subagents.readAttachment": (input) => subagentInputs.readAttachment(input),
  "subagents.submit": (input) => subagentInputs.submitUserInput(input),
  "subagents.editQueued": (input) => subagentInputs.editQueuedUserInput(input),
  "subagents.setUserMessageMarkdown": (input) => subagentInputs.setUserMessageMarkdown(input),
  "subagents.prompt": ({ parentSessionId, handleId, text }) =>
    subagentInputs.prompt(parentSessionId, handleId, text, "prompt").pipe(Effect.asVoid),
  "subagents.steer": ({ parentSessionId, handleId, text }) =>
    subagentInputs.steer(parentSessionId, handleId, text),
  "subagents.abort": ({ parentSessionId, handleId }) =>
    subagentLifetime.abort(parentSessionId, handleId),
  "subagents.close": ({ parentSessionId, handleId }) =>
    subagentLifetime.close(parentSessionId, handleId).pipe(Effect.asVoid),
});
