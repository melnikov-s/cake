import { windowControlDefinitions } from "../../contracts/application/window-control-definitions";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import type { AppControlResult } from "./app-control-data";
import { knownSession } from "./control-projections";

import { defineControl } from "./control-definition";

export const sessionInspectionControls = [
  defineControl({
    ...windowControlDefinitions["sessions.open"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const chatMessage =
        input.sessionId === CAKE_CHAT_SESSION_ID &&
        input.messageId !== undefined &&
        host.state.cakeChatSessions().some((session) => session.sessionId === input.sessionId);
      const resolved = chatMessage
        ? { ok: true as const, sessionId: input.sessionId }
        : resolveSessionReference(
            input.sessionId,
            host.state.sessions().map((session) => session.sessionId),
          );
      if (!resolved.ok) return { ok: false, command, error: resolved.error };
      let known = chatMessage ? undefined : knownSession(host, resolved.sessionId);
      if (!chatMessage && !known?.draft) {
        try {
          known = await host.sessions.lookup(resolved.sessionId);
        } catch (error) {
          return {
            ok: false,
            command,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (!chatMessage && !known)
        return { ok: false, command, error: "Cake could not find that session." };
      if (!host.sessions.navigationEnabled())
        return {
          ok: false,
          command,
          error:
            "Agent session navigation is disabled in Settings → Agent for this window. Offer a session link for the user to open instead.",
        };
      const sessionId = resolved.sessionId;
      const target = known ? { sessionId, workspacePath: known.workingDirectory } : { sessionId };
      const { messageId } = input;
      const messageFound = messageId
        ? await host.sessions.open(sessionId, messageId)
        : await host.sessions.open(sessionId);
      if (messageFound === false)
        return {
          ok: false,
          command,
          error: messageId
            ? `Cake could not find message ${messageId} in that session.`
            : "Cake could not open that session.",
        };
      return {
        ok: true,
        command,
        opened: messageId ? { ...target, messageId } : target,
      };
    },
  }),
];
