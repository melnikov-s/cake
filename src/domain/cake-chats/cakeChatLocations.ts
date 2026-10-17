import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { Effect } from "effect";
import {
  CAKE_CHAT_SESSION_ID,
  PROJECT_CHAT_PREFIX,
} from "../../contracts/cake-chats/cake-chat-identity";
import { CakeChatError } from "../../contracts/cake-chats/cake-chat-data";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { CakeChatLocation } from "../../services/pi-durable/CakeChatConfiguration";

export const projectChatSessionId = (projectPath: string) =>
  PROJECT_CHAT_PREFIX + createHash("sha256").update(projectPath).digest("hex");

export const projectLocation = (
  global: CakeChatLocation,
  projectPath: string,
): CakeChatLocation => ({
  workingDirectory: projectPath,
  sessionDirectory: join(
    dirname(global.sessionDirectory),
    "project-chats",
    projectChatSessionId(projectPath).slice(PROJECT_CHAT_PREFIX.length),
  ),
});

/** Resolve only registered projects. Neither renderer input nor memory chooses storage paths. */
export const resolve = Effect.fn("CakeChats.resolveLocation")(function* (
  global: CakeChatLocation,
  sessionId: string,
) {
  if (sessionId === CAKE_CHAT_SESSION_ID) return global;
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
