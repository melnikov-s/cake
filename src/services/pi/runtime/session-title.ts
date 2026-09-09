import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { SESSION_TITLE_MAX_LENGTH } from "../../../ipc/session-contract";
import { textFromContent } from "./session-projection";

function sessionTitle(sessionManager: SessionManager) {
  const firstUserMessage = sessionManager
    .getEntries()
    .flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      return [textFromContent(entry.message.content).trim()];
    })
    .find(Boolean);
  return (
    sessionManager.getSessionName() ||
    firstUserMessage ||
    sessionManager.getSessionId()
  ).slice(0, SESSION_TITLE_MAX_LENGTH);
}

export function sessionTitleFromFile(path: string, cwd: string) {
  return sessionTitle(SessionManager.open(path, dirname(path), cwd));
}
