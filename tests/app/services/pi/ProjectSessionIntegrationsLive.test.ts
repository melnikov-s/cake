import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { describe, vi } from "vitest";
import { Electron } from "../../../../src/services/electron/Electron";
import { ArtifactStorage } from "../../../../src/services/storage/ArtifactStorage";
import { ReviewStorage } from "../../../../src/services/storage/ReviewStorage";
import { ProjectSessionIntegrations } from "../../../../src/services/pi/ProjectSessionIntegrations";
import { ProjectSessionIntegrationsLive } from "../../../../src/services/pi/ProjectSessionIntegrationsLive";
import { ProjectSessionRuntimeOptions } from "../../../../src/services/pi/ProjectSessionRuntimeOptions";

const layer = ProjectSessionIntegrationsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ArtifactStorage, {}),
      Layer.mock(Electron, {
        sendTo: vi.fn(),
        broadcast: vi.fn(),
        requireRendererConnection: vi.fn(),
        workspaceForConnection: vi.fn(),
        associateWorkspace: vi.fn(),
        forgetWorkspace: vi.fn(),
        windowsForWorkspace: () => [],
        centerTrafficLights: vi.fn(),
      }),
      Layer.mock(ProjectSessionRuntimeOptions, {
        forWorkingDirectory: () => ({ agentDir: "/agent", sessionDir: "/sessions" }),
      }),
      Layer.mock(ReviewStorage, {
        agentSessionDirectory: () => "/reviews/agent",
        reviewContextPath: () => "/reviews/context.md",
        discussionParentContextPath: () => "/reviews/parent.md",
      }),
    ),
  ),
);

describe("ProjectSessionIntegrationsLive", () => {
  it.effect("accepts a late control response after the session integration was released", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const integrations = Context.get(context, ProjectSessionIntegrations);

      yield* integrations.respondControl("released-session", "completed-control", { ok: true });
    }),
  );
});
