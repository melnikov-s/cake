import { cakeChatSideChatParentId } from "../cake-chats/cake-chat-identity";
import type { SpawnedSession } from "../session-families/session-family-document";

/** Creation provenance, never the sender of a later request or editable conversation text. */
export function isDirectProjectChatDelegation(
  spawns: readonly SpawnedSession[],
  target: {
    readonly sessionId: string;
    readonly projectPath?: string;
    readonly workspacePath: string;
  },
  projectChatId: string,
) {
  return spawns.some(
    (spawn) =>
      spawn.sessionId === target.sessionId &&
      !cakeChatSideChatParentId(spawn.sessionId) &&
      spawn.projectPath === target.projectPath &&
      spawn.workingDirectory === target.workspacePath &&
      spawn.requester.kind === "cake-chat" &&
      spawn.requester.sessionId === projectChatId,
  );
}
