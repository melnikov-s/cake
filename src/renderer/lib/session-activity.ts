/**
 * `stopped` is a deliberate stop by the user or an agent: a neutral outcome that never asks
 * for attention, unlike `error` (a failure or unexpected interruption).
 */
export type SessionActivity = "waiting" | "running" | "unread" | "error" | "stopped";

/** Waiting sessions still own an active Pi turn blocked on user input. */
export function isActiveSessionActivity(activity: SessionActivity | undefined) {
  return activity === "waiting" || activity === "running";
}
