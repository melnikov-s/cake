import { describe, expect, it, vi } from "vitest";
import { applyConversationUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Renderer transport infrastructure contracts: Root supplies observation targets to Model
// synchronization. React rendering cannot prove lookup complexity or subscription demand,
// and a fabricated observer would not test the real transport. Keep real Root/Models/Stores.
// SessionRegistryStore.test.ts already covers startup warm-demand reset, selected/archive
// demand, and running sessions surviving the four-idle LRU; retain only the distinct gaps here.
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

  it("pins a visible nonselected pane outside the idle LRU alongside selected and running sessions", () => {
    using fixture = createRendererStoreFixture();
    const { root, models } = fixture;
    const registry = root.sessionRegistry;
    for (const sessionId of ["selected", "visible", "running"])
      registry.load(sessionId, "/project");
    // Establish a real two-pane surface: one session is selected, the other is merely visible.
    root.sessionLayoutStore.ensureSession("selected");
    root.sessionLayoutStore.splitFocused("visible", "x");
    root.appShellStore.selectProjectSession("selected");
    applyConversationUpdate(models.projectConversation("running", "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "running",
        sessionFile: "/project/running.jsonl",
        parts: [],
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: true,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });

    for (let index = 0; index < 5; index += 1) registry.load(`idle-${index}`, "/project");

    const demand = root.projectSessionObservationTargets;
    expect(demand).toHaveLength(7);
    expect(demand.map(({ sessionId }) => sessionId)).toEqual(
      expect.arrayContaining(["selected", "visible", "running", "idle-4"]),
    );
    expect(demand.map(({ sessionId }) => sessionId)).not.toContain("idle-0");
    expect(
      demand.every(
        ({ workingDirectory, allowCreate }) => workingDirectory === "/project" && !allowCreate,
      ),
    ).toBe(true);
  });
});
