import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { describe, vi } from "vitest";
import { Electron } from "../../../../src/services/electron/Electron";
import { ArtifactStorage } from "../../../../src/services/storage/ArtifactStorage";
import { ReviewStorage } from "../../../../src/services/storage/ReviewStorage";
import { ProjectSessionRuntimeHost } from "../../../../src/services/pi/ProjectSessionRuntimeHost";
import { makeProjectSessionRuntimeHostLive } from "../../../../src/services/pi/ProjectSessionRuntimeHostLive";

const layer = makeProjectSessionRuntimeHostLive({
  agentDirectory: "/agent",
  sessionDirectory: "/sessions",
  widgetSessionDirectory: "/widgets",
}).pipe(
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
      Layer.mock(ReviewStorage, {
        agentSessionDirectory: () => "/reviews/agent",
        reviewContextPath: () => "/reviews/context.md",
        discussionParentContextPath: () => "/reviews/parent.md",
      }),
    ),
  ),
);

describe("ProjectSessionRuntimeHostLive", () => {
  it.effect("accepts a late control response after the session integration was released", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const integrations = Context.get(context, ProjectSessionRuntimeHost);

      yield* integrations.respondControl("released-session", "completed-control", { ok: true });
    }),
  );
});
