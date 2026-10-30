import { Context, Effect, Layer, Stream } from "effect";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { acquireOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { projectTodoLayer } from "./projectTodoHarness";
import { familyStorageHarness } from "./familyStorageHarness";
import { fakeRuntime, makeRuntimeRecoveryStorageTestLayer, snapshot } from "./piRuntimeFixture";
import { makeProjectSessionRuntimeTestLayer } from "../domain/projectSessionRuntimeTestLayer";
import { WorkflowTestLive } from "./workflowFixture";
import { makeSubagentStorageTestLayer } from "./subagentStorageFixture";
import type { JsonObject, JsonValue } from "../../../src/contracts/serialization/json-contract";

export const localMcpTarget = "00000000-0000-4000-8000-000000000022";

/** Real Project Chat controls, registry, admission, runtime leases and to-do domain.
 * Only Pi execution and filesystem/persistence mechanisms are replaced.
 */
export const localMcpFixture = Effect.fn("LocalMcpTest.fixture")(function* (
  protectedSessions: readonly string[] = [],
) {
  const calls: Array<{ name: string; input: JsonObject }> = [];
  const prompts: string[] = [];
  const ids = new Set([localMcpTarget]);
  const summary = (id: string) => ({
    id,
    title: "Task",
    created: "2026-01-01",
    modified: "2026-01-01",
    messageCount: 1,
    resolved: false,
  });
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: () => Stream.fromIterable(ids),
    catalog: () => Stream.fromIterable([...ids].map(summary)),
    catalogEntry: (_query, id) => Effect.succeed(ids.has(id) ? summary(id) : undefined),
    inspect: ({ sessionId }) =>
      Effect.succeed({
        workspacePath: "/project",
        sessionId,
        sessionFile: `/cake/sessions/${sessionId}.jsonl`,
        parts: [],
      }),
    changelog: () => Effect.succeed(""),
    createRuntime: (setup) =>
      Effect.sync(() => {
        const id = setup.sessionId ?? localMcpTarget;
        ids.add(id);
        const registry = new CakeOperationRegistry([
          ...(setup.globalControl
            ? createGlobalControlOperations(setup.globalControl, () => ({
                provider: "test",
                modelId: "test-model",
                thinkingLevel: "off",
                fastMode: false,
              }))
            : []),
          ...(setup.projectTodos ? createProjectTodoOperations(setup.projectTodos) : []),
        ]);
        return {
          ...fakeRuntime(setup, () => undefined),
          sessionId: id,
          snapshot: async () => ({ ...snapshot, sessionId: id }),
          inspectSession: async () => ({ entries: [{ text: "Original history" }] }),
          prompt: async (text: string) => {
            prompts.push(text);
            setup.onInitialTranscriptPersisted?.();
          },
          callCakeOperation: async (name, input, signal): Promise<JsonValue> => {
            calls.push({ name, input });
            return (
              await registry.invoke(
                { command: name, input },
                { signal, toolCallId: "test", runtime: {} },
              )
            ).structuredContent;
          },
        };
      }),
  }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
  const initial = yield* Layer.build(
    Layer.mergeAll(
      projectTodoLayer(),
      runtimes,
      makeProjectSessionRuntimeTestLayer(),
      WorkflowTestLive,
      makeSubagentStorageTestLayer(),
      familyStorageHarness().layer,
    ),
  );
  const context = initial.pipe(
    Context.add(SessionArchiveStorage, {
      ...Context.get(initial, SessionArchiveStorage),
      locate: (_id, location) => Effect.succeed(location.cwd === "/project" ? "active" : undefined),
    }),
    Context.add(TaskInputStorage, {
      ...Context.get(initial, TaskInputStorage),
      isRecipient: (id) => Effect.succeed(protectedSessions.includes(id)),
    }),
    Context.add(ManagedWorktrees, {
      ...Context.get(initial, ManagedWorktrees),
      awaitSetup: () => Effect.void,
    }),
    Context.add(RendererRequestCoordinator, {
      ...Context.get(initial, RendererRequestCoordinator),
      releaseSession: () => Effect.void,
    }),
  );
  const chat = yield* acquireOptions({
    configuration: {
      location: { workingDirectory: "/project", sessionDirectory: "/cake/global" },
      agentDirectory: "/cake",
    },
    target: { sessionId: projectChatSessionId("/project"), tools: cakeChatControlTools() },
    newSession: false,
  }).pipe(Effect.provide(context));
  yield* Context.get(context, CakeSessionRuntimes).acquire(chat);
  return { context, calls, prompts, state: Context.get(context, ApplicationState) };
});
