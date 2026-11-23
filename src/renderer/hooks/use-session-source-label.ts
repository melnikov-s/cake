import { useEffect, useState } from "react";
import { resolveSessionLinkReference } from "../../contracts/project-sessions/session-reference";
import { meaningfulSessionTitle, SESSION_NAME_UNAVAILABLE } from "../lib/session-source-label";
import { useMarkdownLinkActions } from "../components/ai-elements/markdown";

/** Metadata only. The disclosure still owns loading the original message. */
export function useSessionSourceLabel({
  sessionId,
  recordedTitle,
  explicitTitle,
  taskTitle,
}: {
  sessionId?: string;
  recordedTitle?: string;
  explicitTitle?: string;
  taskTitle?: string;
}) {
  const actions = useMarkdownLinkActions();
  const exact = sessionId ? resolveSessionLinkReference(sessionId, []) : undefined;
  const resolved =
    exact?.ok === false && sessionId
      ? resolveSessionLinkReference(sessionId, actions?.sessionIds?.() ?? [])
      : exact;
  const id = resolved?.ok ? resolved.sessionId : undefined;
  const catalogTitle = id ? meaningfulSessionTitle(actions?.sessionTitle?.(id), id) : undefined;
  const knownTitle =
    explicitTitle ?? catalogTitle ?? meaningfulSessionTitle(recordedTitle, sessionId);
  const lookup = actions?.lookupSessionSource;
  const target = knownTitle === undefined && lookup ? id : undefined;
  const [result, setResult] = useState<{ id: string; source?: { readonly title: string } }>();
  useEffect(() => {
    if (!target || !lookup) return;
    const controller = new AbortController();
    const settle = (source?: { readonly title: string }) => {
      if (!controller.signal.aborted) setResult({ id: target, source });
    };
    void lookup(target, controller.signal).then(settle, () => settle());
    return () => controller.abort();
  }, [target, lookup]);

  const current = result?.id === target ? result : undefined;
  return (
    knownTitle ??
    meaningfulSessionTitle(current?.source?.title, id) ??
    (taskTitle?.trim() || undefined) ??
    (target && !current
      ? "Loading source session…"
      : current?.source
        ? SESSION_NAME_UNAVAILABLE
        : "Source session unavailable")
  );
}
