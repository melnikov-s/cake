import { cakeChatSideChatParentId } from "../cake-chats/cake-chat-identity";
import type { SessionFamilyDocument } from "../session-families/session-family-document";

/** Current purpose and explicit transfer, falling back to creation provenance only. */
export function isDirectProjectChatDelegation(
  document: SessionFamilyDocument,
  target: {
    readonly sessionId: string;
    readonly projectPath?: string;
    readonly workspacePath: string;
  },
  projectChatId: string,
) {
  const relationship = document.sessionPurposes?.find(
    (item) => item.sessionId === target.sessionId,
  );
  if (
    relationship?.purpose !== "delegated" ||
    relationship.projectPath !== target.projectPath ||
    (relationship.delegatedBySessionId !== undefined &&
      relationship.delegatedBySessionId !== projectChatId)
  )
    return false;
  return document.spawnedSessions.some(
    (spawn) =>
      spawn.sessionId === target.sessionId &&
      !cakeChatSideChatParentId(spawn.sessionId) &&
      spawn.projectPath === target.projectPath &&
      spawn.workingDirectory === target.workspacePath &&
      spawn.requester.kind === "cake-chat" &&
      spawn.requester.sessionId === projectChatId,
  );
}
