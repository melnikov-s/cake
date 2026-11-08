import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { RootStore } from "../stores/RootStore";
import { rendererStartupTiming } from "../lib/startup-timing";

/** Measures distinct document paint, editable input and live transcript commits.
 * Editable is not proof of successful submission or model availability.
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
  const reported = useRef({ projection: false, composer: false });
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
  const session =
    finished || !target
      ? undefined
      : target.kind === "cake-chat"
        ? rootStore.cakeChatCollectionStore.registry.find(target.sessionId)
        : target.kind === "automation-session"
          ? rootStore.automationSessionsStore.sessions.find(
              (item) => item.sessionId === target.sessionId,
            )
          : rootStore.sessionRegistry.findSession(target.sessionId);
  const composerId = session?.conversationSessionStore.chatStore.id;
  const ready = Boolean(
    model && model.observedSnapshotRevision > 0 && !model.historyOnly && !model.observationError,
  );

  useLayoutEffect(() => {
    rendererStartupTiming("first-commit");
  }, []);
  useEffect(() => {
    if (!globalThis.PerformanceObserver?.supportedEntryTypes.includes("paint")) return;
    const observer = new PerformanceObserver((list) => {
      const paint = list.getEntries().find((entry) => entry.name === "first-contentful-paint");
      if (!paint) return;
      // Use Chromium's renderer-local paint timestamp, not callback/main receipt time.
      rendererStartupTiming("first-contentful-paint", paint.startTime);
      observer.disconnect();
    });
    observer.observe({ type: "paint", buffered: true });
    return () => observer.disconnect();
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
      return;
    }
    if (!reported.current.composer && composerId) {
      const input = Array.from(
        document.querySelectorAll<HTMLTextAreaElement>("[data-dictation-submission-owner]"),
      ).find((item) => item.dataset.dictationSubmissionOwner === composerId);
      if (input?.isConnected && !input.disabled && !input.readOnly) {
        rendererStartupTiming("selected-chat-composer-editable-commit");
        reported.current.composer = true;
      }
    }
    if (ready && !reported.current.projection) {
      rendererStartupTiming("selected-chat-projection-commit");
      reported.current.projection = true;
    }
    if (reported.current.projection && reported.current.composer) setFinished(true);
  }, [finished, target, selection?.kind, selection?.sessionId, ready, composerId]);
  return children;
});
