import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import {
  currentSessionOutcome,
  type CakeChatLaunchReport,
} from "../../contracts/project-sessions/session-reporting";
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
  readonly latestTurnOutcome?: "complete" | "failed" | "aborted" | undefined;
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
}

/** Waiting on the user outranks activity; the latest report describes an idle session. */
export function launchedSessionStatus(
  session: LaunchedSessionSource,
  activity: SessionActivity | undefined,
): LaunchedSessionStatus {
  if (activity === "waiting" || activity === "blocked") return "needs-you";
  if (session.running || activity === "running") return "running";
  if (activity === "error") return "failed";
  if (activity === "stopped") return "stopped";
  const outcome = currentSessionOutcome(
    session.latestTurnOutcome,
    session.cakeChatLaunch?.lastReport?.status,
    false,
  );
  if (outcome === "blocked") return "needs-you";
  if (outcome === "failed") return "failed";
  if (outcome === "interrupted") return "interrupted";
  if (outcome === "stopped") return "stopped";
  if (outcome === "completed") return "done";
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
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      projectName: session.projectName,
      status: launchedSessionStatus(session, activity(session.sessionId)),
    }));
}
