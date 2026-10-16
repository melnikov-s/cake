/** Stable identity of the one application-level conversation, never a Project Session. */
export const CAKE_CHAT_SESSION_ID = "ca4ec4a7-0000-4000-8000-000000000001";

/** Agent-facing label for Cake Chat wherever an identity field must name it. It is not a
 * Project Session reference: Project Sessions address Cake Chat by omitting sessionId. */
export const CAKE_CHAT_REFERENCE = "cake-chat";

const SIDE_CHAT_PREFIX = `${CAKE_CHAT_SESSION_ID}:side-chat:`;

/**
 * A Cake Chat side chat that runs as a native Durable fork lives in Cake Chat's own
 * database. Its sidecar session ID names that fork conversation.
 */
export const cakeChatSideChatSessionId = (conversationId: number) =>
  `${SIDE_CHAT_PREFIX}${conversationId}`;

/** The Durable fork conversation a side-chat session ID names, or undefined for Pi sidecars. */
export const cakeChatSideChatConversationId = (sessionId: string | undefined) => {
  if (!sessionId?.startsWith(SIDE_CHAT_PREFIX)) return undefined;
  const id = Number(sessionId.slice(SIDE_CHAT_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};
