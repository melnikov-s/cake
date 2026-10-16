import { Effect, Stream } from "effect";
import { CakeChatError } from "../../contracts/cake-chats/cake-chat-data";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { CakeChatSideChatStartInput } from "../../contracts/discussion-sessions/discussion-session-data";
import * as discussionSessions from "../discussion-sessions/discussionSessions";
import type { CakeChatLocation } from "./cakeChatLocations";

/**
 * Cake Chat side chats are Discussion Sessions whose parent is the permanent
 * Cake Chat. This module binds that parent's fixed identity and location so
 * the renderer never addresses Cake Chat by a Working Directory.
 */
const asCakeChatError = (operation: string) => (error: { readonly message: string }) =>
  new CakeChatError({ operation, message: error.message });

/** Current-first catalog of the side chats branched from Cake Chat. */
export const observeCatalog = Effect.fn("CakeChatSideChats.observeCatalog")(function* (
  location: CakeChatLocation,
) {
  const catalog = yield* discussionSessions
    .observeCatalog({
      workingDirectory: location.workingDirectory,
      parentSessionId: CAKE_CHAT_SESSION_ID,
    })
    .pipe(Effect.mapError(asCakeChatError("observeSideChats")));
  return catalog.pipe(Stream.mapError(asCakeChatError("observeSideChats")));
});

/** Branches a new side chat from one Cake Chat message and delivers its first prompt. */
export const start = Effect.fn("CakeChatSideChats.start")(function* (
  input: CakeChatSideChatStartInput,
  location: CakeChatLocation,
) {
  return yield* discussionSessions
    .startCakeChatSideChat(input, location.workingDirectory)
    .pipe(Effect.mapError(asCakeChatError("startSideChat")));
});
