import { Schema } from "effect";
import { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import { resolveSessionLinkReference } from "../../contracts/project-sessions/session-reference";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import type { useMarkdownLinkActions } from "../components/ai-elements/markdown";

/** Reuse the hosting conversation/window's navigation, never the frame's location. */
export function openWidgetLink(
  url: string,
  actions: NonNullable<ReturnType<typeof useMarkdownLinkActions>>,
) {
  if (Schema.is(ArtifactStableRef)(url)) {
    actions.openArtifact?.(url);
    return;
  }
  const session = parseSessionLink(url);
  if (session) {
    const resolved = resolveSessionLinkReference(session.sessionId, actions.sessionIds?.() ?? []);
    actions.openSession(
      resolved.ok ? resolved.sessionId : session.sessionId,
      session.messageId,
      session.attachmentId,
    );
    return;
  }
  const subagent = parseSubagentLink(url);
  if (subagent) {
    actions.openSubagent?.(subagent.parentSessionId, subagent.handleId, subagent.messageId);
    return;
  }
  actions.openExternalUrl(url);
}
