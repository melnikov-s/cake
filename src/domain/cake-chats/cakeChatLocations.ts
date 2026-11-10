import { createHash } from "node:crypto";
import { Effect } from "effect";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
  PROJECT_CHAT_PREFIX,
} from "../../contracts/cake-chats/cake-chat-identity";
import { cakeChatSessionDirectory } from "../../services/pi-durable/cake-chat-directories";
import { CakeChatError } from "../../contracts/cake-chats/cake-chat-data";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type {
  CakeChatLocation,
  CakeChatRuntimeConfiguration,
} from "../../services/pi-durable/CakeChatConfiguration";
import type { CakePaths } from "../../config/CakePaths";

export const projectChatSessionId = (projectPath: string) =>
  PROJECT_CHAT_PREFIX + createHash("sha256").update(projectPath).digest("hex");

export const projectLocation = (
  global: CakeChatLocation,
  projectPath: string,
): CakeChatLocation => ({
  workingDirectory: projectPath,
  sessionDirectory: cakeChatSessionDirectory(
    global.sessionDirectory,
    projectChatSessionId(projectPath),
  )!,
});

/** Resolve only registered projects. Neither renderer input nor memory chooses storage paths. */
export const resolve = Effect.fn("CakeChats.resolveLocation")(function* (
  global: CakeChatLocation,
  sessionId: string,
) {
  if (sessionId === CAKE_CHAT_SESSION_ID) return global;
  if (sessionId === SESSION_ASSISTANT_ID)
    return {
      ...global,
      sessionDirectory: cakeChatSessionDirectory(global.sessionDirectory, sessionId)!,
    };
  const application = yield* ApplicationState;
  const project = application
    .snapshot()
    .projects.find((item) => projectChatSessionId(item.path) === sessionId);
  if (!project)
    return yield* new CakeChatError({
      operation: "locate",
      message: "Project Chat belongs to no registered project",
    });
  return projectLocation(global, project.path);
});

export interface CakeChatLocationOptions {
  readonly homeDirectory: string;
  readonly sessionDirectory: string;
}

export const make = (options: CakeChatLocationOptions): CakeChatLocation => ({
  workingDirectory: options.homeDirectory,
  sessionDirectory: options.sessionDirectory,
});

/** The process's one Cake Chat configuration. Backend services and every endpoint must share it:
 * runtimes are keyed by location, so two working directories would open the same chat twice. */
export const configuration = (options: {
  readonly homeDirectory: string;
  readonly paths: Pick<CakePaths, "cakeChat" | "piAgent">;
}): CakeChatRuntimeConfiguration => ({
  agentDirectory: options.paths.piAgent,
  location: make({
    homeDirectory: options.homeDirectory,
    sessionDirectory: options.paths.cakeChat,
  }),
});
