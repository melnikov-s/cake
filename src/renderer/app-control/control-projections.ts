import type { AppControlHost, AgentControlSource, AppControlState } from "./app-control-data";

/** Window state is orientation, not a second unbounded project/session roster. */
export function getAppState(host: AppControlHost, source?: AgentControlSource): AppControlState {
  const state: AppControlState = {
    selection: host.state.currentSelection(),
    projectCount: host.state.projects().length,
    sessionCount: host.state.sessions().length,
  };
  const sessionLayout = host.state.sessionLayout?.(source);
  if (sessionLayout) state.sessionLayout = sessionLayout;
  return state;
}

export function knownSession(host: AppControlHost, sessionId: string) {
  return host.state.sessions().find((session) => session.sessionId === sessionId);
}
