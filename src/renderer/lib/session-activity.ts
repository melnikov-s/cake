export type SessionActivity = "waiting" | "running" | "unread" | "error";

/** Waiting sessions still own an active Pi turn blocked on user input. */
export function isActiveSessionActivity(activity: SessionActivity | undefined) {
  return activity === "waiting" || activity === "running";
}
