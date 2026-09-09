import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  reviews: string;
  worktrees: string;
}

export interface ResolveCakePathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

/** The single authority for Cake-owned persistent filesystem locations. */
export function resolveCakePaths(options: ResolveCakePathsOptions = {}): CakePaths {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const home = resolve(env.CAKE_HOME || join(homeDirectory, ".cake"));
  const piAgent = join(home, "pi");
  const state = join(home, "state");
  return {
    home,
    piAgent,
    piSessions: join(piAgent, "sessions"),
    piResolvedSessions: join(piAgent, "resolved-sessions"),
    piReviewSessions: join(piAgent, "review-sessions"),
    piWidgetSessions: join(piAgent, "widget-sessions"),
    piSubagentSessions: join(piAgent, "subagent-sessions"),
    piGlobalChatSessions: join(piAgent, "global-chat", "sessions"),
    piGlobalChatResolvedSessions: join(piAgent, "global-chat", "resolved-sessions"),
    state,
    sessionFamilies: join(state, "session-families.json"),
    resolvedProjectMetadata: join(state, "resolved-project-metadata"),
    artifacts: join(state, "artifacts"),
    reviews: join(state, "reviews"),
    worktrees: join(state, "worktrees.json"),
  };
}
