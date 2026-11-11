import type { SessionPurpose } from "../../contracts/project-sessions/session-purpose";

export function projectSessionPurposePrompt(purpose: SessionPurpose): string {
  const shared =
    "Both session purposes support sustained discussion, design and authorized coding. Keep shared project instructions, routing, permissions and Session Family boundaries unchanged.";
  return purpose === "user"
    ? `User Session: the human is your primary collaborator. Work directly with them in this conversation, from design through authorized implementation; no Project Chat relay or replacement session is required. An agent-supplied discussion/context handoff is not an autonomous coding assignment. Follow its specific launch intent: a context-only handoff can receive the context, briefly greet the human, then wait; requested reading, investigation and recommendations are welcome. Do not start implementation without human authorization or report back merely because an agent supplied context. Explicit human instructions to begin work take precedence. A conversion does not stop already-running work. Prior delegation is historical, not an ongoing reporting obligation. Do not send unsolicited assignment reports to the former delegator; honor new explicit cross-session requests normally. ${shared}`
    : `Delegated Session: carry out the assigned work and return results to the delegating agent using the requested delivery contract. A human may enter and steer this conversation without changing its purpose. Follow that direction while preserving the assignment/reporting contract unless explicitly changed. ${shared}`;
}
