import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CakePaths {
  home: string;
  piAgent: string;
  piSessions: string;
  piReviewSessions: string;
  piWidgetSessions: string;
  piGlobalChatSessions: string;
  plugins: string;
  recovery: string;
  state: string;
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
  return {
    home,
    piAgent,
    piSessions: join(piAgent, "sessions"),
    piReviewSessions: join(piAgent, "review-sessions"),
    piWidgetSessions: join(piAgent, "widget-sessions"),
    piGlobalChatSessions: join(piAgent, "global-chat", "sessions"),
    plugins: join(home, "plugins"),
    recovery: join(home, "recovery"),
    state: join(home, "state")
  };
}
