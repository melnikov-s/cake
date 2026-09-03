import { describe, expect, it } from "vitest";
import { resolveCakePaths } from "../../../src/config/CakePaths";

describe("resolveCakePaths", () => {
  it("resolves every owned directory beneath the default Cake home", () => {
    expect(resolveCakePaths({ env: {}, homeDirectory: "/Users/fixture" })).toEqual({
      home: "/Users/fixture/.cake",
      piAgent: "/Users/fixture/.cake/pi",
      piSessions: "/Users/fixture/.cake/pi/sessions",
      piResolvedSessions: "/Users/fixture/.cake/pi/resolved-sessions",
      piReviewSessions: "/Users/fixture/.cake/pi/review-sessions",
      piWidgetSessions: "/Users/fixture/.cake/pi/widget-sessions",
      piSubagentSessions: "/Users/fixture/.cake/pi/subagent-sessions",
      piGlobalChatSessions: "/Users/fixture/.cake/pi/global-chat/sessions",
      piGlobalChatResolvedSessions: "/Users/fixture/.cake/pi/global-chat/resolved-sessions",
      state: "/Users/fixture/.cake/state",
    });
  });

  it("honors CAKE_HOME", () => {
    const paths = resolveCakePaths({
      env: { CAKE_HOME: "/opt/cake-data" },
      homeDirectory: "/Users/fixture",
    });
    expect(paths.home).toBe("/opt/cake-data");
    expect(paths.piAgent).toBe("/opt/cake-data/pi");
    expect(paths.piSessions).toBe("/opt/cake-data/pi/sessions");
    expect(paths.piWidgetSessions).toBe("/opt/cake-data/pi/widget-sessions");
    expect(paths.piSubagentSessions).toBe("/opt/cake-data/pi/subagent-sessions");
  });
});
