import { sessionReference } from "../../contracts/project-sessions/session-reference";

/** Presentation only. Keep canonical IDs in links and the s: syntax at agent boundaries. */
export function sessionDisplayId(sessionId: string, knownSessionIds: readonly string[] = []) {
  const reference = sessionReference(sessionId, knownSessionIds);
  return reference.startsWith("s:") ? reference.slice(2) : reference;
}
