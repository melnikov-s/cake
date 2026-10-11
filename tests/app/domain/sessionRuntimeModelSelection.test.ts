import assert from "node:assert/strict";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { acquireOptions as acquireCakeChatOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { makeProjectSessionRuntimeTestLayer } from "./projectSessionRuntimeTestLayer";

const inherited = {
  provider: "anthropic",
  modelId: "claude-opus",
  thinkingLevel: "high" as const,
  fastMode: false,
};

describe("Session model policy composition", () => {
  for (const kind of ["project", "cake-chat"] as const) {
    it.effect(
      `${kind} supplies execution-time preset resolution independently of Pi mechanics`,
      () => {
        let state = {
          ...defaultApplicationState(),
          modelPresets: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Sol",
              provider: "openai-codex",
              modelId: "gpt-5.6",
              thinkingLevel: "high" as const,
              fastMode: false,
            },
          ],
        };
        const environment = Layer.mergeAll(
          WorkflowTestLive,
          makeProjectSessionRuntimeTestLayer(),
          Layer.mock(CakeSessionRuntimes, {}),
          Layer.mock(RendererRequestCoordinator, {}),
          Layer.mock(ApplicationState, { snapshot: () => state }),
        );
        return Effect.gen(function* () {
          const location = {
            projectPath: "/project",
            projectName: "Project",
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved",
          };
          const options = yield* kind === "project"
            ? acquireOptions({ location, sessionId: "session", newSession: true })
            : acquireCakeChatOptions({
                configuration: { location, agentDirectory: "/cake" },
                target: { sessionId: "session", tools: [] },
                newSession: true,
              });
          const resolve = options.runtime.resolveModelSelection;
          assert.ok(resolve);
          const first = resolve("Sol", inherited);
          assert.deepEqual(first, {
            provider: "openai-codex",
            modelId: "gpt-5.6",
            thinkingLevel: "high",
            fastMode: false,
          });
          state = {
            ...state,
            modelPresets: state.modelPresets.map((preset) => ({ ...preset, fastMode: true })),
          };
          assert.equal(resolve("Sol", inherited).fastMode, true);
          assert.equal(first.fastMode, false);
          assert.equal(options.runtime.modelPresets?.().presets[0]?.fastMode, true);
          assert.deepEqual(resolve(undefined, inherited), inherited);
          assert.deepEqual(resolve(inherited, first), inherited);
          assert.throws(() => resolve("gpt-5.6", inherited), /Unknown model preset/);
          assert.throws(() => resolve(undefined, undefined), /no model to inherit/);
        }).pipe(Effect.provide(environment));
      },
    );
  }
});
