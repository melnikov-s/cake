import { Context, Effect, Layer, ManagedRuntime } from "effect";
import {
  CakeSessionRuntimes,
  PiSessionError,
  type CakeSessionHandle,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import {
  messageReference,
  type MessageReadResult,
} from "../../../src/contracts/conversations/message-reference";
import { projectTodoLayer } from "./projectTodoHarness";
import { familyStorageHarness } from "./familyStorageHarness";
import { snapshot } from "./piRuntimeFixture";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";

export const unusedMessageLookupLayer = Layer.mergeAll(
  Layer.mock(ManagedWorktrees, {}),
  Layer.mock(SessionArchiveStorage, {}),
  Layer.succeed(ProjectSessionConfiguration, {
    agentDirectory: "/test/agent",
    sessionDirectory: "/test/sessions",
    resolvedSessionDirectory: "/test/resolved",
  }),
);

class TestHandle extends Context.Service<TestHandle, CakeSessionHandle>()(
  "test/HeldAttentionHandle",
) {}
export const producer = projectChatSessionId("/producer");
export const originalRef = messageReference(producer, "46866");
export const originalText = "The investigation found the exact merge responsiveness failure.";
export const originalPage: MessageReadResult = {
  message: {
    ref: originalRef,
    link: originalRef,
    sessionId: producer,
    entryId: "46866",
    parentId: null,
    timestamp: "2026-11-08T07:28:56.682Z",
    role: "assistant",
    active: true,
    inputRefs: [],
    hasImages: false,
  },
  text: originalText,
  totalChars: originalText.length,
  offset: 0,
  nextOffset: null,
  truncated: false,
};

export function heldAttentionHarness() {
  const storage = familyStorageHarness();
  const submissions: Parameters<CakeSessionHandle["submit"]>[0][] = [];
  const acquired: string[] = [];
  const receipts = new Map<string, "pending" | "consumed" | "canceled">();
  const state = {
    streaming: false,
    sourceAvailable: true,
    reject: false,
    publishFail: false,
    cancelOnSubmit: false,
    beforeSubmit: undefined as Effect.Effect<void, PiSessionError> | undefined,
    afterSubmit: undefined as (() => void) | undefined,
  };
  const handles = Layer.mock(TestHandle, {
    profile: "CakeChatSession",
    snapshot: () => Effect.succeed({ ...snapshot, streaming: state.streaming }),
    inputReceipt: (id) => Effect.succeed(receipts.get(id)),
    submit: (input) =>
      Effect.gen(function* () {
        if (state.beforeSubmit) yield* state.beforeSubmit;
        if (state.reject)
          return yield* new PiSessionError({
            operation: "submit",
            message: "Admission rejected; retry",
          });
        if (!receipts.has(input.turnId)) {
          submissions.push(input);
          receipts.set(input.turnId, state.cancelOnSubmit ? "canceled" : "pending");
        }
        state.afterSubmit?.();
        return input.turnId;
      }),
    inspectSession: () =>
      state.sourceAvailable
        ? Effect.succeed(originalPage)
        : Effect.fail(
            new PiSessionError({
              operation: "inspect",
              message: "Source temporarily unavailable; retry",
            }),
          ),
    publishSessionChanged: () =>
      state.publishFail
        ? Effect.fail(
            new PiSessionError({
              operation: "publish",
              message: "Interrupted after durable admission",
            }),
          )
        : Effect.void,
  });
  const sessions = Layer.unwrap(
    Effect.gen(function* () {
      const handle = yield* TestHandle;
      return Layer.mock(CakeSessionRuntimes, {
        acquireSession: (sessionId) =>
          Effect.sync(() => {
            acquired.push(sessionId);
            return handle;
          }),
      });
    }),
  ).pipe(Layer.provide(handles));
  const layer = Layer.mergeAll(
    projectTodoLayer(),
    unusedMessageLookupLayer,
    storage.layer,
    Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
    sessions,
  );
  return { runtime: ManagedRuntime.make(layer), storage, state, submissions, receipts, acquired };
}
