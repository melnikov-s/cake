import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";

describe("ProjectCatalogStore", () => {
  it("owns project records while preserving persisted project order", () => {
    const sessions = mount(createStore(SessionCatalogStore));
    sessions.replace([{ id: "session-1", title: "Task", created: "", modified: "", messageCount: 1, resolved: false, workspacePath: "/second", workspaceName: "old" }]);
    const projects = mount(createStore(ProjectCatalogStore, { sessions }));

    projects.applyApplicationState({
      schemaVersion: 1,
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
      projects: [
        { path: "/first", name: "First", addedAt: "", lastOpenedAt: "" },
        { path: "/second", name: "Second", addedAt: "", lastOpenedAt: "" }
      ]
    });
    projects.restoreRecentPaths(["/second", "/first"]);

    expect(projects.recentProjectPaths).toEqual(["/second", "/first"]);
    expect(projects.nameForPath("/second")).toBe("Second");
    expect(sessions.find("session-1")?.workspaceName).toBe("Second");
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
  });
});
