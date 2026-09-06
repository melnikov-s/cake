import { describe, expect, it } from "vitest";
import {
  applyCakeChatCatalogGroupUpdate,
  applySessionCatalogGroupUpdate,
} from "../../../../src/renderer/projections/CatalogProjection";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";

describe("CatalogProjection", () => {
  it("does not let one Project Session catalog lane mutate another lane's summary", () => {
    const catalog = SessionCatalog.create({
      sessions: [
        {
          sessionId: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          resolved: true,
          unread: false,
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
        },
      ],
    });

    applySessionCatalogGroupUpdate(
      catalog,
      { projectPath: "/project", resolved: false },
      {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "StatusChanged",
          sessionId: "session-1",
          resolved: false,
          unread: false,
        },
      },
    );

    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.resolved).toBe(true);
    catalog[Symbol.dispose]();
  });

  it("moves a Cake Chat summary between lanes without replacing the catalog", () => {
    const catalog = CakeChatCatalog.create({
      loaded: true,
      sessions: [
        {
          sessionId: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          resolved: false,
        },
      ],
    });

    applyCakeChatCatalogGroupUpdate(
      catalog,
      { resolved: false },
      {
        _tag: "Event",
        revision: 2,
        event: { _tag: "StatusChanged", sessionId: "session-1", resolved: true },
      },
    );

    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.resolved).toBe(true);
    catalog[Symbol.dispose]();
  });
});
