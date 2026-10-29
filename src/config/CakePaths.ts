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
  /** Pi Durable storage for the permanent Cake Chat (`coordinator.sqlite`). */
  cakeChat: string;
  state: string;
  sessionFamilies: string;
  resolvedProjectMetadata: string;
  artifacts: string;
  reviews: string;
  worktrees: string;
  /** Retained host operational logs, not Pi transcripts. */
  logs: string;
  /** One appended output log per Managed Worktree's lifecycle commands. */
  worktreeLogs: string;
  cache: string;
}

export interface ResolveCakePathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** Resolved by the Pi adapter at the host composition boundary. */
  piAgentDirectory: string;
}

/** The single authority for Cake-owned durable and disposable filesystem locations. */
export function resolveCakePaths(options: ResolveCakePathsOptions): CakePaths {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const home = resolve(env.CAKE_HOME || join(homeDirectory, ".cake"));
  const piAgent = resolve(options.piAgentDirectory);
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
    cakeChat: join(home, "pi", "global-chat"),
    state,
    sessionFamilies: join(state, "session-families.json"),
    resolvedProjectMetadata: join(state, "resolved-project-metadata"),
    artifacts: join(state, "artifacts"),
    reviews: join(state, "reviews"),
    worktrees: join(state, "worktrees.json"),
    logs: join(home, "logs"),
    worktreeLogs: join(home, "logs", "worktrees"),
    cache: join(home, "cache"),
  };
}
