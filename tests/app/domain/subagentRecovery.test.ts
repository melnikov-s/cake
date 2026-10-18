import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { describe } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import * as chatLocations from "../../../src/domain/cake-chats/cakeChatLocations";
import { open } from "../../../src/domain/cake-chats/cakeChatOperations";
import { deliver } from "../../../src/domain/conversations/sessionChats";
import { initialize } from "../../../src/domain/subagents/subagentRecovery";
import { close, wait } from "../../../src/domain/subagents/subagents";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimeSetup,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import type { SubagentRecord } from "../../../src/services/storage/SubagentStorage";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { SubagentCoordinator } from "../../../src/services/subagents/SubagentCoordinator";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import {
  fakeRuntime,
  makeRuntimeRecoveryStorageTestLayer,
  snapshot,
} from "../helpers/piRuntimeFixture";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const configuration = {
  location: { workingDirectory: "/home/user", sessionDirectory: "/cake/pi/global-chat" },
  agentDirectory: "/cake/agent",
};

const cases = ["global", "project"].flatMap((scope) =>
  (["pending", "notified"] as const).map((disposition) => ({ scope, disposition })),
);

describe("private worker restart recovery", () => {
  it.effect.each(cases)(
    "reopens and messages $scope chat after recovering a $disposition worker without an ID collision",
    ({ scope, disposition }) => {
      const sessionId =
        scope === "global" ? CAKE_CHAT_SESSION_ID : chatLocations.projectChatSessionId("/project");
      const location =
        scope === "global"
          ? configuration.location
          : chatLocations.projectLocation(configuration.location, "/project");
      const record: SubagentRecord = {
        handleId: SubagentHandleId.make("00000000-0000-4000-8000-000000000001"),
        privateSessionId: "00000000-0000-4000-8000-000000000002",
        parentSessionId: sessionId,
        parentProfile: "CakeChatSession",
        parentWorkingDirectory: location.workingDirectory,
        parentSessionDirectory: location.sessionDirectory,
        anchorPartId: "worker-call",
        workingDirectory: "/project",
        task: "Inspect the project",
        allowMutations: false,
        resolvedModel: {
          requested: "exact",
          source: "exact",
          provider: "test",
          modelId: "test-model",
          thinkingLevel: "off",
          fallbacks: [],
        },
        fastMode: false,
        tools: ["read"],
        inputReferences: [],
        messageReferences: [],
        continuation: "none",
        notifyOnCompletion: true,
        completionId: "00000000-0000-4000-8000-000000000003",
        completionDisposition: disposition,
        status: "complete",
        pendingInputs: [],
      };
      const constructions: CakeSessionRuntimeSetup[] = [];
      const messages: { sessionId: string; text: string }[] = [];
      const recoveryStorage = makeRuntimeRecoveryStorageTestLayer();
      const layer = Layer.mergeAll(
        WorkflowTestLive,
        makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
        familyStorageHarness().layer,
        recoveryStorage,
        Layer.succeed(CakeChatConfiguration, configuration),
        Layer.mock(ApplicationState, {
          snapshot: () => ({
            ...defaultApplicationState(),
            trustedProjectPaths: ["/project"],
            projects: [{ path: "/project", name: "Project", addedAt: "now", lastOpenedAt: "now" }],
          }),
        }),
        Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
        Layer.mock(SessionArchiveStorage, {}),
        Layer.mock(TaskInputStorage, {
          authorizeForward: () => Effect.succeed([]),
          grant: () => Effect.succeed([]),
        }),
        Layer.mock(RendererRequestCoordinator, { releaseSession: () => Effect.void }),
        SessionCatalogChanges.layer,
        makeCakeSessionRuntimesLayer({
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (options) =>
            Effect.sync(() => {
              constructions.push(options);
              const id = options.sessionId ?? "unexpected";
              return {
                ...fakeRuntime(options, () => undefined),
                sessionId: id,
                sessionFile: `${options.sessionDir}/${id}`,
                snapshot: async () => ({
                  ...snapshot,
                  workspacePath: options.cwd,
                  sessionId: id,
                  sessionFile: `${options.sessionDir}/${id}`,
                }),
                prompt: async (text) => {
                  messages.push({ sessionId: id, text });
                },
              };
            }),
        }).pipe(Layer.provide(recoveryStorage)),
      );
      return Effect.gen(function* () {
        // Keep continuations paused, just like backend initialization, while opening the pane.
        const coordinator = yield* SubagentCoordinator;
        yield* coordinator.storage.update(record);
        yield* initialize();
        assert.equal((yield* SubscriptionRef.get(coordinator.state)).handles.size, 1);
        if (disposition === "notified") {
          assert.equal(constructions.length, 0);
          // Inspecting a dormant recovered worker hydrates its parent on demand.
          yield* wait(sessionId, record.handleId);
        }
        const recoveredParents = constructions.filter((item) => item.sessionId === sessionId);
        assert.equal(recoveredParents.length, 1);
        yield* open({ sessionId, tools: cakeChatControlTools() }, configuration);
        const handle = yield* (yield* CakeSessionRuntimes).acquireSession(sessionId);
        assert.equal((yield* handle.snapshot()).sessionId, sessionId);
        yield* deliver(
          {
            sessionId,
            text: "Hello after restart",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
          "prompt",
        );
        assert.equal(constructions.filter((item) => item.sessionId === sessionId).length, 1);
        assert.deepEqual(messages, [{ sessionId, text: "Hello after restart" }]);
        assert.equal(recoveredParents[0]?.cwd, location.workingDirectory);
        assert.equal(recoveredParents[0]?.sessionDir, location.sessionDirectory);
        yield* close(sessionId, record.handleId);
      }).pipe(Effect.provide(layer));
    },
  );
});
