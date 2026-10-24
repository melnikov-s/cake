import type { StoreSnapshot } from "r-state-tree";
import type { SessionLayoutNode } from "../stores/SessionLayoutStore";
import type { WindowConversationSelection } from "../stores/AppShellStore";

function child(snapshot: StoreSnapshot, name: string) {
  const value = snapshot.children[name];
  return value && !Array.isArray(value) ? value : undefined;
}

/** An unfinished renderer preview is not a resumable Pi identity. Persist its source instead. */
export function withoutSessionForkPreviews(
  snapshot: StoreSnapshot,
  sources: ReadonlyMap<string, string>,
  layout: SessionLayoutNode | undefined,
): StoreSnapshot {
  if (!sources.size) return snapshot;
  const registry = child(snapshot, "sessionRegistry");
  const navigation = child(snapshot, "appShellStore");
  const panes = child(snapshot, "sessionLayoutStore");
  if (registry) {
    const targets = registry.state.targets;
    if (Array.isArray(targets))
      registry.state.targets = targets.filter((target) => !sources.has(target.sessionId));
    const sessions = registry.children.sessions;
    if (Array.isArray(sessions))
      registry.children.sessions = sessions.filter((session) => !sources.has(String(session.key)));
  }
  if (navigation && Array.isArray(navigation.state.sessionHistory))
    navigation.state.sessionHistory = navigation.state.sessionHistory.map((entry) => ({
      ...entry,
      sessionId: sources.get(entry.sessionId) ?? entry.sessionId,
    }));
  const capture = child(snapshot, "screenCaptureStore");
  // SAFETY: captured directly from the local ScreenCaptureAttachmentStore, not loaded window data.
  const lastTarget = capture?.state.lastTarget as WindowConversationSelection | undefined;
  if (capture && lastTarget?.kind === "project-session" && sources.has(lastTarget.sessionId))
    capture.state.lastTarget = { ...lastTarget, sessionId: sources.get(lastTarget.sessionId) };
  if (panes) panes.state.layout = replaceLayout(layout, sources);
  return snapshot;
}

function replaceLayout(
  node: SessionLayoutNode | undefined,
  sources: ReadonlyMap<string, string>,
): SessionLayoutNode | undefined {
  if (!node) return undefined;
  return node.kind === "pane"
    ? { ...node, history: node.history.map((id) => sources.get(id) ?? id) }
    : {
        ...node,
        first: replaceLayout(node.first, sources)!,
        second: replaceLayout(node.second, sources)!,
      };
}
