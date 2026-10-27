import { describe, expect, it, vi } from "vitest";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { sessionSummary } from "../fixtures/catalog-fixtures";
import { SubagentActivityStore } from "../../../../src/renderer/stores/SubagentActivityStore";

// Renderer transport infrastructure contracts: Root supplies observation targets to Model
// synchronization. React rendering cannot prove lookup complexity or subscription demand,
// and a fabricated observer would not test the real transport. Keep real Root/Models/Stores.
// session-observation-workflow.test.tsx drives startup warm-demand reset, selected/archive
// demand, and visible/running sessions surviving the four-idle LRU through the real App.
// Retain the lookup/activity complexity regression that UI text cannot expose.
describe("Session observation-demand integration", () => {
  it("reuses materialized membership and activity when retaining and selecting sessions", () => {
    using fixture = createRendererStoreFixture({
      sessions: Array.from({ length: 100 }, (_, index) =>
        sessionSummary({ sessionId: `session-${index}`, projectPath: "/project" }),
      ),
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

    // Monitor real lookups/activity; do not replace the returned Stores or Models.
    const findSession = vi.spyOn(registry, "findSession");
    const activity = vi.spyOn(SubagentActivityStore.prototype, "activeRuns", "get");
    try {
      // Installing a method spy invalidates reactive method reads. Warm that
      // instrumentation change before measuring the actual navigation work.
      void registry.observationRetention.sessions;
      findSession.mockClear();
      activity.mockClear();
      registry.observationRetention.retain("session-0");
      fixture.root.navigationStore.selectProjectSession("session-4");
      fixture.root.navigationStore.selectProjectSession("session-0");
      // Navigation may look up its explicit destination, never all 100 identities.
      expect(findSession.mock.calls.map(([sessionId]) => sessionId)).toEqual(["session-4"]);
      expect(activity).not.toHaveBeenCalled();
    } finally {
      findSession.mockRestore();
      activity.mockRestore();
    }
    expect(fixture.root.projectSessionObservationTargets).toHaveLength(4);
    expect(fixture.root.projectSessionObservationTargets).toContainEqual({
      sessionId: "session-0",
      workingDirectory: "/project",
      allowCreate: false,
    });
  });
});
