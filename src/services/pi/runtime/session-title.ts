import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { SESSION_TITLE_MAX_LENGTH } from "../../../contracts/conversations/session-contract";
import { textFromContent, visibleUserMessageText } from "./session-projection";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";
import { stripResponseModeReminder } from "../../../contracts/conversations/response-mode-reminders";

function sessionTitle(sessionManager: SessionManager) {
  const name = sessionManager.getSessionName();
  if (name) return name.slice(0, SESSION_TITLE_MAX_LENGTH);
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = visibleUserMessageText(
      stripResponseModeReminder(
        stripPresentationModeReminder(textFromContent(entry.message.content)),
      ),
    ).trim();
    if (text) return text.slice(0, SESSION_TITLE_MAX_LENGTH);
  }
  return sessionManager.getSessionId().slice(0, SESSION_TITLE_MAX_LENGTH);
}

export function sessionTitleFromFile(path: string, cwd: string) {
  return sessionTitle(SessionManager.open(path, dirname(path), cwd));
}
