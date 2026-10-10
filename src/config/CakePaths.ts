import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { piAgentDirectory } from "../services/pi/PiPaths";

export interface CakePaths {
  home: string;
  piAgent: string;
  piSessions: string;
  piResolvedSessions: string;
  piReviewSessions: string;
  piWidgetSessions: string;
  piSubagentSessions: string;
  piGlobalChatSessions: string;
  piGlobalChatResolvedSessions: string;
  state: string;
  sessionFamilies: string;
  resolvedProjectMetadata: string;
  artifacts: string;
  drawBoards: string;
  reviews: string;
  worktrees: string;
  cache: string;
}

export interface ResolveCakePathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** Explicit backend/test boundary; production delegates resolution to Pi. */
  piAgentDirectory?: string;
}

/** The single authority for Cake-owned durable and disposable filesystem locations. */
export function resolveCakePaths(options: ResolveCakePathsOptions = {}): CakePaths {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const home = resolve(env.CAKE_HOME || join(homeDirectory, ".cake"));
  const piAgent = resolve(options.piAgentDirectory ?? piAgentDirectory());
  const state = join(home, "state");
  return {
    home,
    piAgent,
    piSessions: join(piAgent, "sessions"),
    piResolvedSessions: join(piAgent, "resolved-sessions"),
    // GUI-specific Pi sidecars are not primary project sessions or configuration.
    piReviewSessions: join(home, "pi", "review-sessions"),
    piWidgetSessions: join(home, "pi", "widget-sessions"),
    piSubagentSessions: join(home, "pi", "subagent-sessions"),
    piGlobalChatSessions: join(home, "pi", "global-chat", "sessions"),
    piGlobalChatResolvedSessions: join(home, "pi", "global-chat", "resolved-sessions"),
    state,
    sessionFamilies: join(state, "session-families.json"),
    resolvedProjectMetadata: join(state, "resolved-project-metadata"),
    artifacts: join(state, "artifacts"),
    drawBoards: join(state, "draw-boards"),
    reviews: join(state, "reviews"),
    worktrees: join(state, "worktrees.json"),
    cache: join(home, "cache"),
  };
}
