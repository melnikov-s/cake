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
        let state: ReturnType<typeof defaultApplicationState> = {
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
          // No default preset configured: omission falls back to the caller's settings.
          assert.deepEqual(resolve(undefined, inherited), inherited);
          assert.throws(() => resolve(undefined, undefined), /no default model preset/);
          // A configured default wins over the caller's model, and later changes are respected.
          state = { ...state, defaultModelPresetId: "00000000-0000-4000-8000-000000000001" };
          assert.deepEqual(resolve(undefined, inherited), {
            provider: "openai-codex",
            modelId: "gpt-5.6",
            thinkingLevel: "high",
            fastMode: true,
          });
          // Only Cake Chat subagents read the live Subagent default model setting (absent means
          // Inherit); Project Session subagents and all session launches use the default preset.
          const sessionDefault = resolve(undefined, inherited);
          assert.equal(sessionDefault.modelId, "gpt-5.6");
          const subagent = () => resolve(undefined, inherited, "subagent");
          assert.deepEqual(subagent(), kind === "cake-chat" ? inherited : sessionDefault);
          const preferences = { memoryViewBytes: 40_000, instructions: "" };
          state = {
            ...state,
            cakeChatPreferences: { ...preferences, subagentDefaultModel: { source: "default" } },
          };
          assert.deepEqual(subagent(), sessionDefault);
          assert.equal(resolve("Sol", inherited, "subagent").modelId, "gpt-5.6");
          assert.deepEqual(resolve(inherited, first, "subagent"), inherited);
          state = {
            ...state,
            utilityModel: { provider: "openai", modelId: "gpt-mini", thinkingLevel: "low" },
            cakeChatPreferences: { ...preferences, subagentDefaultModel: { source: "utility" } },
          };
          assert.deepEqual(
            subagent(),
            kind === "cake-chat"
              ? { provider: "openai", modelId: "gpt-mini", thinkingLevel: "low", fastMode: false }
              : sessionDefault,
          );
          state = { ...state, cakeChatPreferences: preferences };
          state = {
            ...state,
            modelPresets: [
              ...state.modelPresets,
              {
                id: "00000000-0000-4000-8000-000000000002",
                name: "Luna",
                provider: "anthropic",
                modelId: "claude-luna",
                thinkingLevel: "low" as const,
                fastMode: false,
              },
            ],
            defaultModelPresetId: "00000000-0000-4000-8000-000000000002",
          };
          assert.deepEqual(resolve(undefined, inherited), {
            provider: "anthropic",
            modelId: "claude-luna",
            thinkingLevel: "low",
            fastMode: false,
          });
          assert.deepEqual(resolve(inherited, first), inherited);
          assert.equal(resolve("Sol", inherited).modelId, "gpt-5.6");
          assert.throws(() => resolve("gpt-5.6", inherited), /Unknown model preset/);
        }).pipe(Effect.provide(environment));
      },
    );
  }
});
