/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { applyProjectCatalogUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { Profiler } from "react";
import { StoreProvider } from "r-state-tree/react";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

it("shows unselected-project activity from the project catalog without discovering descendants", () => {
  using fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/cake", name: "Cake" }),
      projectRecord({ path: "/other", name: "Other" }),
    ],
    sessions: [sessionSummary({ sessionId: "other-session", projectPath: "/other" })],
  });
  render(
    <StoreProvider store={fixture.root}>
      <ProjectRail />
    </StoreProvider>,
  );
  expect(screen.queryByRole("img", { name: "Work running in Other" })).toBeNull();
  act(() =>
    applyProjectCatalogUpdate(fixture.models.projects, {
      _tag: "Event",
      revision: 1,
      event: { _tag: "ActivityChanged", runningProjectPaths: ["/other"] },
    }),
  );
  expect(screen.getByRole("img", { name: "Work running in Other" })).toBeTruthy();
  expect(fixture.models.discussionCatalogs).toHaveLength(0);
  expect(fixture.models.subagentCatalogs).toHaveLength(0);
  act(() =>
    applyProjectCatalogUpdate(fixture.models.projects, {
      _tag: "Event",
      revision: 2,
      event: { _tag: "ActivityChanged", runningProjectPaths: [] },
    }),
  );
  expect(screen.queryByRole("img", { name: "Work running in Other" })).toBeNull();
});

it("keeps the project rail idle when worker snapshots change without changing project activity", () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake", name: "Cake" })],
    sessions: [sessionSummary({ sessionId: "owner", projectPath: "/cake" })],
  });
  const workers = fixture.models.subagentCatalog("owner");
  workers.metadataLoaded = true;
  const worker = {
    parentSessionId: "owner",
    handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000001"),
    anchorPartId: "spawn",
    task: "Running worker",
    status: "running" as const,
    streaming: true,
    released: false,
  };
  workers.metadata.push(worker);
  fixture.models.projects.runningProjectPaths.push("/cake");
  const committed = vi.fn();
  const view = render(
    <StoreProvider store={fixture.root}>
      <Profiler id="project-rail" onRender={committed}>
        <ProjectRail />
      </Profiler>
    </StoreProvider>,
  );
  expect(screen.getByRole("img", { name: "Work running in Cake" })).toBeTruthy();
  committed.mockClear();
  for (let revision = 0; revision < 5; revision += 1) {
    act(() => workers.metadata.splice(0, 1, { ...worker }));
  }
  expect(committed).not.toHaveBeenCalled();
  act(() => {
    workers.metadata.splice(0, 1, { ...worker, streaming: false, status: "complete" });
    fixture.models.projects.runningProjectPaths.splice(0);
  });
  expect(screen.queryByRole("img", { name: "Work running in Cake" })).toBeNull();
  view.unmount();
});
