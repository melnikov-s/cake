import { describe, expect, it, vi } from "vitest";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Renderer transport infrastructure contracts: Root supplies observation targets to Model
// synchronization. React rendering cannot prove lookup complexity or subscription demand,
// and a fabricated observer would not test the real transport. Keep real Root/Models/Stores.
// session-observation-workflow.test.tsx drives startup warm-demand reset, selected/archive
// demand, and visible/running sessions surviving the four-idle LRU through the real App.
// Retain only the materialized-lookup complexity regression that UI text cannot expose.
describe("Session observation-demand integration", () => {
  it("looks up only materialized identities while trimming a much larger restored collection", () => {
    using fixture = createRendererStoreFixture({
      snapshot: {
        state: {},
        children: {
          sessionRegistry: {
            state: {
              targets: Array.from({ length: 100 }, (_, index) => ({
                sessionId: `session-${index}`,
                workspacePath: "/project",
              })),
            },
            children: {},
          },
        },
      },
    });
    const registry = fixture.root.sessionRegistry;
    for (let index = 0; index < 5; index += 1) registry.load(`session-${index}`, "/project");

    // Monitor the real identity lookup; do not replace it or its returned Stores.
    const findSession = vi.spyOn(registry, "findSession");
    registry.observationRetention.retain("session-0");
    expect(new Set(findSession.mock.calls.map(([sessionId]) => sessionId))).toEqual(
      new Set(Array.from({ length: 5 }, (_, index) => `session-${index}`)),
    );
    expect(fixture.root.projectSessionObservationTargets).toHaveLength(4);
    expect(fixture.root.projectSessionObservationTargets).toContainEqual({
      sessionId: "session-0",
      workingDirectory: "/project",
      allowCreate: false,
    });
  });
});
