import { createStore, mount } from "r-state-tree";
import { expect, it, vi } from "vitest";
import { ConversationActivityStore } from "../../../../src/renderer/stores/ConversationActivityStore";
import { createRendererStoreFixture } from "../renderer-store-fixture";

it("does not turn in-flight bookkeeping into demand or retry a missing child's settled lookup", async () => {
  using fixture = createRendererStoreFixture();
  fixture.models.sessionCatalog.signals.loaded = true;
  fixture.models.sessionCatalog.signals.sessions = [
    {
      sessionId: "child",
      projectPath: "/project",
      workingDirectory: "/project",
      purpose: "user",
      running: false,
      unread: false,
      familyParentSessionId: "parent",
    },
  ];
  const lookup = vi
    .spyOn(fixture.root.sessionCatalogStore, "lookup")
    .mockImplementationOnce(async () => undefined)
    // Bound a regression: a second lookup stays pending instead of starving the
    // test runner with an infinite resolved-promise/reaction loop.
    .mockImplementation(() => new Promise(() => {}));
  using store = mount(
    createStore(ConversationActivityStore, {
      catalog: fixture.root.sessionCatalogStore,
      selectedSessionId: () => "parent",
      metadata: () => {
        throw new Error("Metadata is not part of lookup demand");
      },
      openSession: async () => {},
    }),
  );
  await new Promise<void>((done) => setImmediate(done));
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith("child");
  void store;
});
