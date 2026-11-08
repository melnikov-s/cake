import { AgentControlTestLive } from "./agentControlTestLayer";
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
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { CakeOperationInvocation } from "../../../src/contracts/agent/cake-operation";
import { acquireOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import { coordinatorCakeOperations } from "../../../src/layers/CakeOperations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { projectTodoLayer } from "./projectTodoHarness";
import { familyStorageHarness } from "./familyStorageHarness";
import { fakeRuntime, makeRuntimeRecoveryStorageTestLayer, snapshot } from "./piRuntimeFixture";
import { makeProjectSessionRuntimeTestLayer } from "../domain/projectSessionRuntimeTestLayer";
import { makeSubagentStorageTestLayer } from "./subagentStorageFixture";
import type { JsonObject, JsonValue } from "../../../src/contracts/serialization/json-contract";

export const localMcpTarget = "00000000-0000-4000-8000-000000000022";

/** Real global/Project Chat controls, registry, admission, runtime leases and to-do domain.
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
        const makeRegistry = (access?: { readonly fullControl: true }) =>
          new CakeOperationRegistry(
            setup.globalControl
              ? coordinatorCakeOperations(setup)(
                  {
                    sessionId: id,
                    resolveModel: () => ({
                      provider: "test",
                      modelId: "test-model",
                      thinkingLevel: "off",
                      fastMode: false,
                    }),
                    info: async () => ({}),
                    usage: async () => ({}),
                    contextStatus: async () => ({}),
                    compact: async () => ({}),
                    setModel: async () => {},
                  },
                  access,
                )
              : [],
          );
        const registry = makeRegistry();
        const fullControlRegistry = makeRegistry({ fullControl: true });
        const callCakeTool = async (
          name: string,
          input: JsonObject,
          signal: AbortSignal,
        ): Promise<CakeOperationInvocation> => {
          calls.push({ name, input });
          return fullControlRegistry.invoke(
            { command: name, input },
            { signal, toolCallId: "test", runtime: {} },
          );
        };
        return {
          ...fakeRuntime(setup, () => undefined),
          callCakeTool,
          sessionId: id,
          snapshot: async () => ({ ...snapshot, sessionId: id }),
          inspectSession: async () => ({ entries: [{ text: "Original history" }] }),
          prompt: async (text: string) => {
            prompts.push(text);
            setup.onInitialTranscriptPersisted?.();
          },
          callCakeOperation: async (name, input, signal): Promise<JsonValue> => {
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
      AgentControlTestLive,
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
      recipients: () => Effect.succeed(new Set(protectedSessions)),
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
  for (const sessionId of [CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")]) {
    const chat = yield* acquireOptions({
      configuration: {
        location: { workingDirectory: "/project", sessionDirectory: "/cake/global" },
        agentDirectory: "/cake",
      },
      target: { sessionId, tools: cakeChatControlTools() },
      newSession: false,
    }).pipe(Effect.provide(context));
    yield* Context.get(context, CakeSessionRuntimes).acquire(chat);
  }
  return { context, calls, prompts, state: Context.get(context, ApplicationState) };
});
