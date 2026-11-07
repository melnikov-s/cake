import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  createSession,
  type Conversation,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { access } from "node:fs/promises";
import { cakeChatSideChatConversationId } from "../../contracts/cake-chats/cake-chat-identity";
import type { SessionInspectionQuery } from "../../contracts/conversations/session-query-data";
import { toJsonValue } from "../../utils/to-json-value";
import { durableChatDatabase } from "./durable-chat-location";
import {
  listDurableMessageReferences,
  readDurableMessageReference,
} from "./durable-message-references";

/** The same own-originals query as Conversation.entries, without starting a Harness or turn. */
export async function inspectDurableSideChatMessages(
  storage: Storage,
  sessionId: string,
  query: SessionInspectionQuery,
) {
  const id = cakeChatSideChatConversationId(sessionId);
  if (id === undefined) throw new Error("Invalid Side Chat ID");
  // SAFETY: the canonical Side Chat parser validates positive integer conversation IDs.
  const conversationId = id as ConversationId;
  const record = await storage.conversation(conversationId, BACKGROUND_CONTEXT);
  if (record?.parent?.conversationId !== ROOT_CONVERSATION_ID)
    throw new Error("That Cake Chat side chat no longer exists");
  const originals = {
    entries: (
      selected: Parameters<Conversation["entries"]>[0],
      limit: number,
      cursor: Parameters<Storage["scanEntries"]>[2],
    ) => storage.scanEntries({ ...selected, conversationId }, limit, cursor, BACKGROUND_CONTEXT),
  };
  if (query.kind === "messages-list")
    return toJsonValue(await listDurableMessageReferences(originals, sessionId, query));
  if (query.kind === "messages-read")
    return toJsonValue(await readDurableMessageReference(originals, sessionId, query));
  throw new Error("Expected an exact message query");
}

/** Cold history inspection follows the existing SDK catalog-reader lifetime, never recovery. */
export async function readDurableSideChatMessages(
  directory: string,
  sessionId: string,
  query: SessionInspectionQuery,
) {
  const path = durableChatDatabase(directory);
  await access(path); // Never create an empty database for a missing source.
  const storage = await openNodeSqliteStorage(path);
  const session = createSession(storage);
  try {
    return await inspectDurableSideChatMessages(storage, sessionId, query);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}
