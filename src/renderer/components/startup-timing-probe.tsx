import { useLayoutEffect, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { RootStore } from "../stores/RootStore";
import { rendererStartupTiming } from "../lib/startup-timing";

/** A committed live projection is a readiness milestone, not proof of paint,
 * composer interactivity, Markdown completion, or a successful model request.
 */
export const StartupTimingProbe = observer(function StartupTimingProbe({
  rootStore,
  children,
}: {
  rootStore: RootStore;
  children: ReactNode;
}) {
  const [finished, setFinished] = useState(false);
  const selection = finished ? undefined : rootStore.appShellStore.activeConversation;
  const [target, setTarget] = useState(selection);
  const projection = rootStore.props.projection;
  const conversations =
    target?.kind === "cake-chat"
      ? projection.cakeChatConversations
      : target?.kind === "automation-session"
        ? projection.automationConversations
        : projection.projectConversations;
  const model = finished
    ? undefined
    : conversations.find((item) => item.sessionId === target?.sessionId);
  const ready = Boolean(
    model && model.observedSnapshotRevision > 0 && !model.historyOnly && !model.observationError,
  );

  useLayoutEffect(() => {
    rendererStartupTiming("first-commit");
  }, []);
  useLayoutEffect(() => {
    if (finished) return;
    if (!target) {
      if (selection) setTarget(selection);
      return;
    }
    if (selection?.kind !== target.kind || selection.sessionId !== target.sessionId) {
      rendererStartupTiming("selected-chat-changed");
      setFinished(true);
    } else if (ready) {
      rendererStartupTiming("selected-chat-projection-commit");
      setFinished(true);
    }
  }, [finished, target, selection?.kind, selection?.sessionId, ready]);
  return children;
});
