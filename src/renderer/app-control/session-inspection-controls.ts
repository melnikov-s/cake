import { windowControlDefinitions } from "../../contracts/application/window-control-definitions";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import type { AppControlResult } from "./app-control-data";
import { knownSession } from "./control-projections";

import { defineControl } from "./control-definition";

export const sessionInspectionControls = [
  defineControl({
    ...windowControlDefinitions["sessions.open"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const chats = host.state.cakeChatSessions();
      const resolved = resolveSessionReference(input.sessionId, [
        ...host.state.sessions().map((session) => session.sessionId),
        ...chats.map((session) => session.sessionId),
      ]);
      if (!resolved.ok) return { ok: false, command, error: resolved.error };
      const chatTarget = isCakeChatSessionId(resolved.sessionId);
      const chat = chats.find((session) => session.sessionId === resolved.sessionId);
      if (chatTarget && !chat)
        return { ok: false, command, error: "Cake could not find that registered chat." };
      let known = chatTarget ? undefined : knownSession(host, resolved.sessionId);
      if (!chatTarget && !known?.draft) {
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
      if (!chatTarget && !known)
        return { ok: false, command, error: "Cake could not find that session." };
      if (!host.sessions.navigationEnabled())
        return {
          ok: false,
          command,
          error:
            "Agent session navigation is disabled in Settings → Agent for this window. Offer a session link for the user to open instead.",
        };
      const sessionId = resolved.sessionId;
      const workspacePath = chat?.projectPath ?? known?.workingDirectory;
      const target = workspacePath ? { sessionId, workspacePath } : { sessionId };
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
