import { Schema, type Effect } from "effect";
import { jsonValueSchema } from "../../ipc/json-contract";
import type { PiSessionAcquireOptions, PiSessions } from "../../services/pi/PiSessions";
import type { CakeRuntimeOptions } from "../../services/pi/runtime/cake-runtime";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import type { ApplicationState } from "../../services/storage/ApplicationState";
import * as subagents from "./subagents";

type SubagentControlRequirements =
  | ApplicationState
  | PiSessions
  | SubagentCoordinator
  | SubagentEnvironment;

export interface SubagentControlOptions {
  readonly runEffect: <A, E>(
    effect: Effect.Effect<A, E, SubagentControlRequirements>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

/** Adapts Cake's Subagent domain operations to the callback API consumed by Pi. */
export const makeSubagentControl =
  ({ runEffect }: SubagentControlOptions) =>
  (
    options: () => PiSessionAcquireOptions,
    workingDirectory: string,
    remainingDepth = 1,
  ): NonNullable<CakeRuntimeOptions["agentControl"]> => {
    const parent = (parentSessionId: string): subagents.SubagentParentRuntime => ({
      parentSessionId,
      workingDirectory,
      remainingDepth,
      options: options(),
    });
    return {
      run: (input, parentSessionId, signal, onUpdate, anchorPartId) =>
        runEffect(
          subagents.run(
            input,
            parent(parentSessionId),
            onUpdate
              ? (value) => onUpdate(Schema.decodeUnknownSync(jsonValueSchema)(value))
              : undefined,
            anchorPartId,
          ),
          signal,
        ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
      start: (input, parentSessionId, signal, anchorPartId) =>
        runEffect(subagents.start(input, parent(parentSessionId), anchorPartId), signal).then(
          (value) => Schema.decodeUnknownSync(jsonValueSchema)(value),
        ),
      parallel: (input, parentSessionId, signal, onUpdate, anchorPartId) =>
        runEffect(
          subagents.parallel(
            input,
            parent(parentSessionId),
            onUpdate
              ? (value) => onUpdate(Schema.decodeUnknownSync(jsonValueSchema)(value))
              : undefined,
            anchorPartId,
          ),
          signal,
        ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
      prompt: (input, parentSessionId, signal) =>
        runEffect(
          subagents.prompt(parentSessionId, input.handleId, input.text, input.delivery),
          signal,
        ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
      wait: (handleId, parentSessionId, signal, onUpdate) =>
        runEffect(
          subagents.wait(
            parentSessionId,
            handleId,
            onUpdate
              ? (value) => onUpdate(Schema.decodeUnknownSync(jsonValueSchema)(value))
              : undefined,
          ),
          signal,
        ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
      abort: (handleId, parentSessionId) =>
        runEffect(subagents.abort(parentSessionId, handleId)).then(() =>
          Schema.decodeUnknownSync(jsonValueSchema)({
            handleId,
            status: "aborted",
            streaming: false,
          }),
        ),
      close: (handleId, parentSessionId) =>
        runEffect(subagents.close(parentSessionId, handleId)).then((value) =>
          Schema.decodeUnknownSync(jsonValueSchema)(value),
        ),
    };
  };
