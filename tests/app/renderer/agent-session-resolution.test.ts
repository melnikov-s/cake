/** @vitest-environment jsdom */
import { applySnapshot } from "r-state-tree";
import { expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

it("resolves an agent-requested session known only from background signals", async () => {
  const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => undefined);
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/alpha" })],
    client: { projectSessions: { resolve } },
  });
  // The Sessions list has not been opened, so only the lightweight signals know the session.
  applySnapshot(fixture.models.sessionCatalog.signals, {
    loaded: true,
    sessions: [
      {
        sessionId: "second",
        projectPath: "/alpha",
        workingDirectory: "/alpha",
        running: false,
        unread: false,
      },
    ],
  });
  expect(fixture.root.sessionCatalogStore.find("second")).toBeUndefined();
  await expect(
    fixture.root.sessionRetirementStore.setProjectSessionsResolved(["second"], true, "agent"),
  ).resolves.toBe(1);
  expect(resolve).toHaveBeenCalledWith(
    { sessionId: "second", workingDirectory: "/alpha", userInitiated: false },
    expect.anything(),
  );
});
