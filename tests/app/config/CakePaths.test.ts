import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { resolveCakePaths } from "../../../src/config/CakePaths";
import { piAgentDirectory } from "../../../src/services/pi/PiPaths";

afterEach(() => vi.unstubAllEnvs());

describe("resolveCakePaths", () => {
  it("separates Pi's shared agent home from Cake-owned state and sidecar sessions", () => {
    expect(
      resolveCakePaths({
        env: {},
        homeDirectory: "/Users/fixture",
        piAgentDirectory: "/Users/fixture/.pi/agent",
      }),
    ).toEqual({
      home: "/Users/fixture/.cake",
      piAgent: "/Users/fixture/.pi/agent",
      piSessions: "/Users/fixture/.pi/agent/sessions",
      piResolvedSessions: "/Users/fixture/.pi/agent/resolved-sessions",
      piReviewSessions: "/Users/fixture/.cake/pi/review-sessions",
      piWidgetSessions: "/Users/fixture/.cake/pi/widget-sessions",
      piSubagentSessions: "/Users/fixture/.cake/pi/subagent-sessions",
      cakeChat: "/Users/fixture/.cake/pi/global-chat",
      state: "/Users/fixture/.cake/state",
      sessionFamilies: "/Users/fixture/.cake/state/session-families.json",
      resolvedProjectMetadata: "/Users/fixture/.cake/state/resolved-project-metadata",
      artifacts: "/Users/fixture/.cake/state/artifacts",
      reviews: "/Users/fixture/.cake/state/reviews",
      worktrees: "/Users/fixture/.cake/state/worktrees.json",
      cache: "/Users/fixture/.cake/cache",
    });
  });

  it("honors Pi's environment without overwriting it or coupling it to CAKE_HOME", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/opt/pi-agent");
    const paths = resolveCakePaths({
      env: { CAKE_HOME: "/opt/cake-data" },
      homeDirectory: "/Users/fixture",
      piAgentDirectory: piAgentDirectory(),
    });
    expect(paths.home).toBe("/opt/cake-data");
    expect(paths.piAgent).toBe("/opt/pi-agent");
    expect(paths.piSessions).toBe("/opt/pi-agent/sessions");
    expect(paths.piWidgetSessions).toBe("/opt/cake-data/pi/widget-sessions");
    expect(paths.worktrees).toBe("/opt/cake-data/state/worktrees.json");
    expect(process.env.PI_CODING_AGENT_DIR).toBe("/opt/pi-agent");
  });

  it("uses the Pi adapter's resolved default and tilde overrides", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    expect(resolveCakePaths({ piAgentDirectory: piAgentDirectory() }).piAgent).toBe(
      resolve(getAgentDir()),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/alternate-pi");
    expect(resolveCakePaths({ piAgentDirectory: piAgentDirectory() }).piAgent).toBe(
      resolve(getAgentDir()),
    );
    expect(process.env.PI_CODING_AGENT_DIR).toBe("~/alternate-pi");
  });
});
