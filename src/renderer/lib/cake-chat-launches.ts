import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { CakeChatLaunchReport } from "../../contracts/project-sessions/session-reporting";
import type { SessionActivity } from "./session-activity";

export type LaunchedSessionStatus =
  | "running"
  | "needs-you"
  | "failed"
  | "stopped"
  | "interrupted"
  | "done"
  | "idle";

export interface LaunchedSessionSource {
  readonly sessionId: string;
  readonly title: string;
  readonly projectName: string;
  readonly modifiedAt: string;
  readonly resolved: boolean;
  readonly running: boolean;
  readonly cakeChatLaunch?:
    | {
        readonly requesterSessionId: string;
        readonly launchedAt?: string;
        readonly lastReport?: CakeChatLaunchReport;
      }
    | undefined;
}

export interface LaunchedSession {
  readonly sessionId: string;
  readonly title: string;
  readonly projectName: string;
  readonly status: LaunchedSessionStatus;
  readonly summary?: string;
}

/** Waiting on the user outranks activity; the latest report describes an idle session. */
export function launchedSessionStatus(
  session: LaunchedSessionSource,
  activity: SessionActivity | undefined,
): LaunchedSessionStatus {
  const report = session.cakeChatLaunch?.lastReport;
  if (activity === "waiting") return "needs-you";
  if (session.running || activity === "running") return "running";
  if (report?.status === "blocked") return "needs-you";
  if (report?.status === "failed" || activity === "error") return "failed";
  if (report?.status === "interrupted") return "interrupted";
  if (report?.status === "stopped" || activity === "stopped") return "stopped";
  if (report?.status === "completed") return "done";
  return "idle";
}

/** Unresolved sessions Cake Chat launched, most recent launch first. */
export function launchedSessions(
  sessions: readonly LaunchedSessionSource[],
  activity: (sessionId: string) => SessionActivity | undefined,
  requesterSessionId = CAKE_CHAT_SESSION_ID,
): LaunchedSession[] {
  return sessions
    .filter(
      (session) =>
        session.cakeChatLaunch?.requesterSessionId === requesterSessionId && !session.resolved,
    )
    .toSorted((left, right) =>
      (right.cakeChatLaunch?.launchedAt ?? right.modifiedAt).localeCompare(
        left.cakeChatLaunch?.launchedAt ?? left.modifiedAt,
      ),
    )
    .map((session) => {
      const summary = session.cakeChatLaunch?.lastReport?.summary;
      return {
        sessionId: session.sessionId,
        title: session.title,
        projectName: session.projectName,
        status: launchedSessionStatus(session, activity(session.sessionId)),
        ...(summary ? { summary } : null),
      };
    });
}

/** Statuses the user should look at. A deliberate stop never counts. */
export function launchedSessionNeedsAttention(status: LaunchedSessionStatus) {
  return status === "needs-you" || status === "failed" || status === "interrupted";
}

export const launchedSessionStatusLabel = {
  running: "Running",
  "needs-you": "Needs you",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
  done: "Done",
  idle: "Idle",
} satisfies Record<LaunchedSessionStatus, string>;
