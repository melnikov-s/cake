import { dirname, join } from "node:path";
import {
  CAKE_CHAT_SESSION_ID,
  PROJECT_CHAT_PREFIX,
  SESSION_ASSISTANT_ID,
  isProjectChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";

/** A Cake-owned neutral directory, never a project root, where Cake Chat's commands start. */
export const cakeChatScratchDirectory = (sessionDirectory: string) =>
  join(sessionDirectory, "scratch");

/**
 * Where a Cake Chat stores its conversation, derived from its ID alone, so history and
 * images stay locatable without a running chat. Undefined for any other session ID.
 */
export function cakeChatSessionDirectory(globalSessionDirectory: string, sessionId: string) {
  if (sessionId === CAKE_CHAT_SESSION_ID) return globalSessionDirectory;
  if (sessionId === SESSION_ASSISTANT_ID) return join(dirname(globalSessionDirectory), "companion");
  if (!isProjectChatSessionId(sessionId)) return undefined;
  return join(
    dirname(globalSessionDirectory),
    "project-chats",
    sessionId.slice(PROJECT_CHAT_PREFIX.length),
  );
}
