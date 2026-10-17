/** Stable identity of the global conversation, never a task Project Session. */
export const CAKE_CHAT_SESSION_ID = "ca4ec4a7-0000-4000-8000-000000000001";

/** Agent-facing shorthand for global Cake Chat. An omitted message target also means
 * global Cake Chat; Project Chats have their own explicit session addresses. */
export const CAKE_CHAT_REFERENCE = "cake-chat";

export const PROJECT_CHAT_PREFIX = "project-chat:";
export const isCakeChatSessionId = (sessionId: string) =>
  sessionId === CAKE_CHAT_SESSION_ID || /^project-chat:[a-f0-9]{64}$/.test(sessionId);

const SIDE_CHAT_SEPARATOR = ":side-chat:";
export const cakeChatSideChatParentId = (sessionId: string | undefined) => {
  const parent = sessionId?.split(SIDE_CHAT_SEPARATOR)[0];
  return parent && isCakeChatSessionId(parent) && sessionId !== parent ? parent : undefined;
};

/**
 * A Cake Chat side chat that runs as a native Durable fork lives in Cake Chat's own
 * database. Its sidecar session ID names that fork conversation.
 */
export const cakeChatSideChatSessionId = (
  conversationId: number,
  parentSessionId = CAKE_CHAT_SESSION_ID,
) => `${parentSessionId}${SIDE_CHAT_SEPARATOR}${conversationId}`;

/** The Durable fork conversation a side-chat session ID names, or undefined for Pi sidecars. */
export const cakeChatSideChatConversationId = (sessionId: string | undefined) => {
  const parent = cakeChatSideChatParentId(sessionId);
  if (!parent || !sessionId) return undefined;
  const id = Number(sessionId.slice(parent.length + SIDE_CHAT_SEPARATOR.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};
