import { TURN_STOPPED_NOTICE_TITLE } from "../../contracts/conversations/turn-stop";

/**
 * `stopped` is a deliberate stop by the user or an agent: a neutral outcome that never asks
 * for attention, unlike `error` (a failure or unexpected interruption).
 * `blocked` recovery needs input but no longer owns an executing turn.
 */
export type SessionActivity = "waiting" | "running" | "blocked" | "unread" | "error" | "stopped";

/** Work readiness is independent of whether the user has read a session. */
export type SessionWorkActivity = Exclude<SessionActivity, "unread"> | "ready";

/** Chat activity never uses the generic StatusDot's gray default/pending treatment. */
export const sessionActivityDotStatus = {
  waiting: "attention",
  blocked: "attention",
  running: "running",
  unread: "success",
  ready: "success",
  error: "error",
  stopped: undefined,
} as const satisfies Record<SessionActivity | SessionWorkActivity, string | undefined>;

/** Shared settlement policy; read/selection acknowledgement remains with each owner. */
export function settledSessionActivity(
  outcome: "complete" | "failed" | "aborted" | undefined,
  parts: readonly {
    kind: string;
    role?: string;
    status?: string;
    tone?: string;
    title?: string;
  }[],
): SessionActivity {
  if (outcome === "failed") return "error";
  if (outcome === "complete") return "unread";
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if ((part.kind === "text" && part.role === "user") || part.kind === "skill") break;
    if (part.kind === "text" && part.role === "assistant") {
      if (part.status === "error") return "error";
      // A later returned answer supersedes failures from a hidden continuation
      // or retry, even when there is no new visible user message.
      if (part.status === "complete") break;
    }
    if (part.kind === "notice" && part.tone === "error" && part.title === "Model request failed")
      return "error";
    if (part.kind === "notice" && part.tone === "info" && part.title === TURN_STOPPED_NOTICE_TITLE)
      return "stopped";
  }
  // An unattributed abort is an interruption, not a successful response or deliberate stop.
  return outcome === "aborted" ? "error" : "unread";
}

/** Waiting sessions still own an active Pi turn blocked on user input. */
export function isActiveSessionActivity(activity: SessionActivity | undefined) {
  return activity === "waiting" || activity === "running";
}
