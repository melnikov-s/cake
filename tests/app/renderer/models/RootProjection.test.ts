import { describe, expect, it } from "vitest";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";

describe("RootProjection", () => {
  it("owns stable loaded session projections", () => {
    const projection = RootProjection.create();

    const projectSession = projection.projectSession("project-session", "/project");
    const cakeChat = projection.cakeChat("cake-chat");

    expect(projection.projectSession("project-session", "/project")).toBe(projectSession);
    expect(projection.cakeChat("cake-chat")).toBe(cakeChat);
    expect(projectSession.parent).toBe(projection);
    expect(cakeChat.parent).toBe(projection);

    projection.removeProjectSession(projectSession.sessionId);
    projection.removeCakeChat(cakeChat.sessionId);

    expect(projection.projectSessions).toEqual([]);
    expect(projection.cakeChats).toEqual([]);

    projection[Symbol.dispose]();
  });
});
