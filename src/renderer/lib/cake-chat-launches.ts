import type { CakeChatLaunchReport } from "../../contracts/project-sessions/session-reporting";
import type { SessionActivity } from "./session-activity";

export type LaunchedSessionStatus =
  | "running"
  | "needs-you"
  | "failed"
  | "stopped"
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
    | { readonly launchedAt?: string; readonly lastReport?: CakeChatLaunchReport }
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
  if (report?.status === "stopped") return "stopped";
  if (report?.status === "completed") return "done";
  return "idle";
}

/** Unresolved sessions Cake Chat launched, most recent launch first. */
export function launchedSessions(
  sessions: readonly LaunchedSessionSource[],
  activity: (sessionId: string) => SessionActivity | undefined,
): LaunchedSession[] {
  return sessions
    .filter((session) => session.cakeChatLaunch && !session.resolved)
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

export const launchedSessionStatusLabel = {
  running: "Running",
  "needs-you": "Needs you",
  failed: "Failed",
  stopped: "Stopped",
  done: "Done",
  idle: "Idle",
} satisfies Record<LaunchedSessionStatus, string>;
