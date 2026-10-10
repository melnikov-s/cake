import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  ROOT_CONVERSATION_ID,
  type Session,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { CAKE_CHAT_SESSION_ID } from "../../ipc/cake-chat-data";
import type { PiSessionSummary, PiSessionPreview } from "../../ipc/session-contract";
import { ChatMetadataDoc } from "./durable-chat-metadata";
import { readDurableOriginalPage } from "./durable-chat-history";
import { durableChatDatabase, purgeLegacyGlobalChatHistory } from "./durable-chat-location";

/** Readers use the SDK's document kernel, not a Harness: discovery cannot create a
 * conversation, load providers, resume tasks, or run scheduler recovery cleanup. */
async function read<A>(
  directory: string,
  evaluate: (session: Session, storage: Storage) => Promise<A>,
): Promise<A | undefined> {
  await purgeLegacyGlobalChatHistory(directory);
  const path = durableChatDatabase(directory);
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const storage = await openNodeSqliteStorage(path);
  const session = createSession(storage);
  try {
    if (!(await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))) return undefined;
    return await evaluate(session, storage);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

export function readDurableChatSummary(directory: string): Promise<PiSessionSummary | undefined> {
  return read(directory, async (session) => {
    const metadata = await session.snapshot(
      ChatMetadataDoc,
      ROOT_CONVERSATION_ID,
      BACKGROUND_CONTEXT,
    );
    return {
      id: CAKE_CHAT_SESSION_ID,
      resolved: false,
      title: "Cake Chat",
      created: metadata?.createdAt ?? new Date().toISOString(),
      modified: metadata?.modifiedAt ?? new Date().toISOString(),
      messageCount: metadata?.messageCount ?? 0,
    };
  });
}

export function readDurableChatPreview(directory: string): Promise<PiSessionPreview | undefined> {
  return read(directory, async (_session, storage) => ({
    workspacePath: dirname(directory),
    sessionId: CAKE_CHAT_SESSION_ID,
    sessionFile: durableChatDatabase(directory),
    parts: (
      await readDurableOriginalPage({
        entries: (query, limit, cursor, context) =>
          storage.scanEntries(
            { ...query, conversationId: ROOT_CONVERSATION_ID },
            limit,
            cursor,
            context,
          ),
      })
    ).parts,
  }));
}
