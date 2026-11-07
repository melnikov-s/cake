/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { fixtureTimestamp, projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

it.each(["project-chat", "session", "side-chat", "subagent", "nested-subagent"] as const)(
  "shows unselected-project %s activity from lightweight facts and clears on idle",
  (source) => {
    using fixture = createRendererStoreFixture({
      projects: [
        projectRecord({ path: "/cake", name: "Cake" }),
        projectRecord({ path: "/other", name: "Other" }),
      ],
      sessions: [sessionSummary({ sessionId: "other-session", projectPath: "/other" })],
    });
    const homeId = `project-chat:${"b".repeat(64)}`;
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [
        {
          sessionId: homeId,
          projectPath: "/other",
          title: "Other",
          createdAt: fixtureTimestamp,
          modifiedAt: fixtureTimestamp,
          messageCount: 1,
          running: false,
        },
      ],
    });
    const discussion = fixture.models.discussionCatalog("other-session");
    const side = {
      id: "thread",
      parentSessionId: "other-session",
      sidecarSessionId: "sidecar",
      workingDirectory: "/other",
      title: "Side",
      status: "open" as const,
      running: false,
      createdAt: fixtureTimestamp,
      updatedAt: fixtureTimestamp,
    };
    discussion.metadataLoaded = true;
    discussion.metadata.push(side);
    const nested = fixture.models.discussionCatalog("sidecar");
    nested.metadataLoaded = true;
    nested.metadata.push({
      ...side,
      id: "nested",
      parentSessionId: "sidecar",
      sidecarSessionId: "nested-sidecar",
      status: "resolved",
    });
    const workers = fixture.models.subagentCatalog(
      source === "nested-subagent" ? "nested-sidecar" : "other-session",
    );
    workers.metadataLoaded = true;
    workers.metadata.push({
      parentSessionId: workers.sessionId,
      handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000001"),
      anchorPartId: "spawn",
      task: "Background work",
      status: "complete",
      streaming: false,
      released: false,
    });
    const view = render(
      <StoreProvider store={fixture.root}>
        <ProjectRail />
      </StoreProvider>,
    );
    expect(fixture.root.workspaceProjectPath).toBeUndefined();
    expect(screen.queryByRole("img", { name: "Work running in Other" })).toBeNull();
    const setRunning = (running: boolean) => {
      if (source === "project-chat") fixture.models.cakeChatCatalog.sessions[0]!.running = running;
      else if (source === "session")
        fixture.models.sessionCatalog.find("other-session")!.running = running;
      else if (source === "side-chat")
        discussion.metadata.splice(0, 1, { ...discussion.metadata[0]!, running });
      else {
        workers.metadata.splice(0, 1, {
          ...workers.metadata[0]!,
          status: running ? "running" : "complete",
          streaming: running,
        });
      }
    };
    act(() => setRunning(true));
    expect(screen.getByRole("img", { name: "Work running in Other" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Work running in Cake" })).toBeNull();
    const targets = fixture.root.conversationNavigatorStore.metadataTargetsForProjects([
      "/cake",
      "/other",
    ]);
    expect(targets.map((target) => target.sessionId)).toEqual(
      expect.arrayContaining([homeId, "other-session", "sidecar", "nested-sidecar"]),
    );
    expect(fixture.models.discussionConversations).toHaveLength(0);
    expect(fixture.models.projectConversations).toHaveLength(0);
    act(() => setRunning(false));
    expect(screen.queryByRole("img", { name: "Work running in Other" })).toBeNull();
    view.unmount();
  },
);
