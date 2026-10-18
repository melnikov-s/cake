import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { dirname } from "node:path";
import type { MessageListInput } from "../../contracts/conversations/message-reference";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import { findSessionFileById } from "../storage/session-files";
import { listMessageReferences, readMessageReference } from "./runtime/message-references";

interface Target {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly sessionDirectory: string;
}

/** Stateless Pi disk adapter: no agent assembly, extensions, worktree restoration,
 * or model/thinking configuration writes. Pi remains the only transcript store. */
const openOriginal = Effect.fn("PiMessageHistory.openOriginal")(function* (target: Target) {
  return yield* Effect.tryPromise({
    try: async () => {
      const path = await findSessionFileById(target.sessionId, {
        workingDirectory: target.workingDirectory,
        root: target.sessionDirectory,
      });
      if (!path) throw new Error("The original Pi session is missing or inaccessible");
      return SessionManager.open(path, dirname(path), target.workingDirectory);
    },
    catch: (cause) =>
      new SessionChatError({
        operation: "messages.read",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

export const list = Effect.fn("PiMessageHistory.list")(function* (
  target: Target,
  input: MessageListInput,
) {
  const manager = yield* openOriginal(target);
  return listMessageReferences(manager, input);
});

export const read = Effect.fn("PiMessageHistory.read")(function* (
  target: Target,
  input: { readonly entryId: string; readonly offset?: number; readonly maxChars?: number },
) {
  const manager = yield* openOriginal(target);
  return yield* Effect.try({
    try: () => readMessageReference(manager, input),
    catch: (cause) =>
      new SessionChatError({
        operation: "messages.read",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});
