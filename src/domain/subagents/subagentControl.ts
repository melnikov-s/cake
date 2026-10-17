import { Effect, Schema } from "effect";
import { jsonValueSchema } from "../../contracts/serialization/json-contract";
import type {
  CakeSessionRuntimeAcquireOptions,
  CakeSessionRuntimes,
} from "../../services/pi/CakeSessionRuntimes";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { makeAttachmentReferenceControl } from "../conversations/attachmentReferences";
import {
  MessageReadResult,
  type MessageOperationControl,
} from "../../contracts/conversations/message-reference";
import { grantMessageAttachments } from "../conversations/messageReferenceAccess";
import type { SubagentMessageAccess } from "../../contracts/subagents/subagent-messages";
import type { AgentOperationControl } from "../../contracts/agent/cake-operation-options";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import type { ApplicationState } from "../../services/storage/ApplicationState";
import type { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import * as subagents from "./subagents";

export type SubagentControlRequirements =
  | ApplicationState
  | CakeSessionRuntimes
  | SubagentCoordinator
  | SubagentEnvironment
  | TaskInputStorage
  | SessionFamilyStorage;

export interface SubagentControlOptions {
  readonly runEffect: <A, E>(
    effect: Effect.Effect<A, E, SubagentControlRequirements>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

const forwardAttachments = Effect.fn("Subagents.forwardAttachments")(function* (
  ownerSessionId: string,
  recipientSessionId: string,
  inputRefs: readonly string[],
) {
  const storage = yield* TaskInputStorage;
  const grants = yield* storage.authorizeForward(ownerSessionId, inputRefs, recipientSessionId);
  return yield* storage.grant(recipientSessionId, grants);
});

const makeMessageAccess = (
  source: MessageOperationControl | undefined,
  recipientSessionId: string,
  runEffect: SubagentControlOptions["runEffect"],
): SubagentMessageAccess | undefined => {
  if (!source) return undefined;
  const selected = new Set<string>();
  return {
    forward: (references) => {
      for (const reference of references) selected.add(reference);
      return references;
    },
    control: {
      list: async () => {
        throw new Error("Workers may read only explicitly forwarded message references");
      },
      open: async () => {
        throw new Error("Workers cannot navigate Cake sessions");
      },
      read: async (input, signal) => {
        if (!selected.has(input.ref))
          throw new Error("That message reference was not forwarded to this worker");
        const result = Schema.decodeUnknownSync(MessageReadResult)(
          await source.read(input, signal),
        );
        // Selecting a message does not eagerly inspect attached bytes. After an explicit
        // read, its exact attachment IDs become available to this worker for on-demand reads.
        await runEffect(grantMessageAttachments(recipientSessionId, result.message), signal);
        return Schema.decodeUnknownSync(jsonValueSchema)(result);
      },
    },
  };
};

export const makeSubagentParent = (
  options: CakeSessionRuntimeAcquireOptions,
  parentSessionId: string,
  workingDirectory: string,
  runEffect: SubagentControlOptions["runEffect"],
): subagents.SubagentParentRuntime => ({
  parentSessionId,
  workingDirectory,
  options,
  runEffect: (effect) => runEffect(effect),
  messages: (recipientSessionId) =>
    makeMessageAccess(options.runtime.messageReferenceControl, recipientSessionId, runEffect),
  attachments: (ownerSessionId, recipientSessionId) => ({
    forward: (inputRefs, signal) =>
      runEffect(forwardAttachments(ownerSessionId, recipientSessionId, inputRefs), signal),
    control: makeAttachmentReferenceControl(recipientSessionId, (effect, { signal }) =>
      runEffect(effect, signal),
    ),
  }),
});

/** Adapts Cake's Subagent domain operations to the callback API consumed by Pi. */
export const makeSubagentControl =
  ({ runEffect }: SubagentControlOptions) =>
  (
    options: () => CakeSessionRuntimeAcquireOptions,
    workingDirectory: string,
  ): AgentOperationControl => {
    const parent = (parentSessionId: string) =>
      makeSubagentParent(options(), parentSessionId, workingDirectory, runEffect);
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
          subagents.prompt(
            parentSessionId,
            input.handleId,
            input.text,
            input.delivery,
            options().profile._tag === "CakeChatSession",
            input.inputRefs,
            input.messageRefs,
          ),
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
