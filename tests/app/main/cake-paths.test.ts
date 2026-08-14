import { describe, expect, it } from "vitest";
import { resolveCakePaths } from "../../../src/main/cake-paths";

describe("resolveCakePaths", () => {
  it("resolves every owned directory beneath the default Cake home", () => {
    expect(resolveCakePaths({ env: {}, homeDirectory: "/Users/fixture" })).toEqual({
      home: "/Users/fixture/.cake",
      piAgent: "/Users/fixture/.cake/pi",
      piSessions: "/Users/fixture/.cake/pi/sessions",
      piReviewSessions: "/Users/fixture/.cake/pi/review-sessions",
      piGlobalChatSessions: "/Users/fixture/.cake/pi/global-chat/sessions",
      plugins: "/Users/fixture/.cake/plugins",
      migrations: "/Users/fixture/.cake/migrations",
      legacyPiSessions: "/Users/fixture/.pi/agent/sessions"
    });
  });

  it("honors CAKE_HOME without changing the legacy migration source", () => {
    const paths = resolveCakePaths({ env: { CAKE_HOME: "/opt/cake-data" }, homeDirectory: "/Users/fixture" });
    expect(paths.home).toBe("/opt/cake-data");
    expect(paths.piAgent).toBe("/opt/cake-data/pi");
    expect(paths.piSessions).toBe("/opt/cake-data/pi/sessions");
    expect(paths.plugins).toBe("/opt/cake-data/plugins");
    expect(paths.legacyPiSessions).toBe("/Users/fixture/.pi/agent/sessions");
  });
});
